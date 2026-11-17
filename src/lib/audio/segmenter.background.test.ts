// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSegmenter, type Segmenter } from './segmenter';
import { createTranscriptionQueue, type TranscriptionQueue } from '../queue';
import * as db from '../db';
import type { AudioChunk } from '../../types';

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
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['encoded speech captured while JS was throttled']) });
      this.onstop?.();
    });
  }
}
let segmenter: Segmenter | undefined;
let queue: TranscriptionQueue | undefined;
beforeEach(async () => {
  vi.stubGlobal('Blob', NativeBlob);
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('MediaRecorder', Recorder);
  Recorder.all = [];
  await db.__setDbName(`review-background-${crypto.randomUUID()}`);
});
afterEach(async () => {
  await segmenter?.stop();
  queue?.dispose();
  if (queue) await vi.waitFor(() => expect(queue!.getState().active).toBe(0), { interval: 5 });
  segmenter = undefined; queue = undefined;
  await db.__setDbName(`closed-${crypto.randomUUID()}`);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('must not classify an unsampled background minute as known silence and delete its speech', async () => {
  let now = 0;
  let tick!: () => void;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  // Model a throttled tab: the browser records audio, but the main-thread
  // interval does not run until a quiet instant at the end of the minute.
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
    tick = fn; return 123;
  }) as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  const chunks: AudioChunk[] = [];
  segmenter = createSegmenter({ stream: {} as MediaStream, analyser: {
    fftSize: 2048, getFloatTimeDomainData: (data: Float32Array) => data.fill(0),
  } as unknown as AnalyserNode }, { onChunk: c => chunks.push(c) });
  segmenter.start();
  now = 60000;
  tick();
  await Promise.resolve();
  expect(chunks).toHaveLength(1);
  expect(chunks[0].speechMs).toBeUndefined(); // Missing coverage must always reach STT.

  const date = new Date().toISOString();
  await db.putMeeting({ id: 'm', title: 'Speech in background', createdAt: date, updatedAt: date,
    status: 'recording', source: 'mic', language: '', durationMs: 60000, nextSeq: 1, keepAudio: false });
  await db.addSegmentWithAudio({ id: 'm:000000', meetingId: 'm', seq: 0,
    startMs: 0, endMs: 60000, status: 'pending', text: '', edited: false, attempts: 0,
    mimeType: chunks[0].mimeType, hasAudio: true, speechMs: chunks[0].speechMs }, chunks[0].blob);
  const transcribe = vi.fn(async () => ({ text: 'Meeting speech', via: 'api' as const }));
  queue = createTranscriptionQueue({ transcribe });
  queue.enqueue('m:000000');
  await vi.waitFor(() => expect(queue!.getState().active).toBe(0), { interval: 5 });
  expect({ calls: transcribe.mock.calls.length, status: (await db.getSegment('m:000000'))?.status,
    hasAudio: (await db.getSegment('m:000000'))?.hasAudio })
    .toEqual({ calls: 1, status: 'done', hasAudio: false });
});
