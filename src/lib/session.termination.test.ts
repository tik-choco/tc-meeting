// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as db from './db';
import * as session from './session';
import { createSegmenter } from './audio/segmenter';

vi.mock('./ai/stt', () => ({ transcribe: vi.fn() }));
class Recorder {
  static all: Recorder[] = [];
  static isTypeSupported() { return true; }
  state = 'inactive';
  mimeType = 'audio/mp4';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor() { Recorder.all.push(this); }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['mp4 audio']) });
      this.onstop?.();
    });
  }
}
let clock = 0;
const releaseWake = vi.fn();
const stopCapture = vi.fn();
beforeEach(async () => {
  vi.stubGlobal('Blob', NativeBlob);
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('MediaRecorder', Recorder);
  Recorder.all = []; clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  await db.__setDbName(`review-session-${crypto.randomUUID()}`);
  session.__setSessionDeps({
    startCapture: async () => ({ stream: {} as MediaStream, analyser: {
      fftSize: 2048, getFloatTimeDomainData: (data: Float32Array) => data.fill(0.2),
    } as unknown as AnalyserNode, onEnded: () => {}, stop: stopCapture }),
    createSegmenter, holdWakeLock: () => releaseWake, pickRecorderMimeType: () => 'audio/mp4',
    transcribe: vi.fn(async () => ({ text: 'Speech', via: 'api' as const })),
  });
  session.getQueue().pause();
});
afterEach(async () => {
  await session.stopRecording().catch(() => {});
  session.getQueue().dispose();
  await vi.waitFor(() => expect(session.getQueue().getState().active).toBe(0), { interval: 5 });
  session.__setSessionDeps({});
  await db.__setDbName(`closed-${crypto.randomUUID()}`);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('must end the session and release capture when MediaRecorder spontaneously stops', async () => {
  const id = await session.startNewMeeting({ title: 'Device/encoder stop', source: 'mic', language: '', keepAudio: true });
  clock = 10000;
  // MediaRecorder is allowed to stop by itself (e.g. input stream becomes
  // inactive). A final dataavailable/stop pair is delivered without an error.
  Recorder.all[0].stop();
  await vi.waitFor(async () => expect(await db.listSegments(id)).toHaveLength(1), { interval: 5 });
  await vi.waitFor(() => expect(session.getRecordingState().phase).toBe('idle'), { interval: 5, timeout: 150 });
  expect(stopCapture).toHaveBeenCalled();
  expect(releaseWake).toHaveBeenCalled();
  expect(session.getRecordingState().error).toMatchObject({ code: 'unknown' });
  expect(await db.getMeeting(id)).toMatchObject({ status: 'stopped', nextSeq: 1, durationMs: 10000 });
  expect(await db.getSegmentAudio(`${id}:000000`)).toBeDefined();
});
