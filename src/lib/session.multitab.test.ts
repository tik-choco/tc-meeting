// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import type { AudioChunk } from '../types';
import type { SegmenterOptions } from './audio/segmenter';
import type { CaptureHandle } from './audio/capture';

vi.mock('./ai/stt', () => ({ transcribe: vi.fn() }));
type Session = typeof import('./session');
type Database = typeof import('./db');
import { testLocks } from "./audio/testLocks";
const locks = testLocks();
const instances: { session: Session; db: Database }[] = [];
afterEach(async () => {
  for (const tab of instances) await tab.session.stopRecording().catch(() => {});
  for (const tab of instances) {
    tab.session.getQueue().dispose();
    tab.session.__setSessionDeps({});
    await tab.db.__setDbName(`closed-${crypto.randomUUID()}`);
  }
  instances.length = 0;
  vi.unstubAllGlobals();
});
async function tab(name: string) {
  // Independent module singletons, shared IndexedDB: two actual tab heaps.
  vi.resetModules();
  const db = await import('./db');
  const session = await import('./session');
  await db.__setDbName(name);
  instances.push({ session, db });
  let callbacks!: SegmenterOptions;
  session.__setSessionDeps({
    locks,
    startCapture: async () => ({ stream: {}, analyser: {}, onEnded() {}, stop() {} } as unknown as CaptureHandle),
    createSegmenter: (_capture, opts) => {
      callbacks = opts;
      return { start() {}, pause() {}, resume() {}, async stop() {},
        get elapsedMs() { return opts.startOffsetMs ?? 0; }, state: 'recording' };
    },
    holdWakeLock: () => () => {}, pickRecorderMimeType: () => 'audio/wav',
    transcribe: vi.fn(async () => ({ text: 'Speech', via: 'api' as const })),
  });
  session.getQueue().pause();
  return { session, db, emit: (value: AudioChunk) => callbacks.onChunk(value) };
}

it('must prevent a second tab continuing the same still-owned recording and losing a chunk to a seq collision', async () => {
  vi.stubGlobal('Blob', NativeBlob);
  vi.stubGlobal('BroadcastChannel', undefined);
  const name = `review-continuation-${crypto.randomUUID()}`;
  const first = await tab(name);
  const id = await first.session.startNewMeeting({ title: 'Owned by first tab', source: 'mic', language: '', keepAudio: true });
  const second = await tab(name);
  await second.session.initSession();
  // A second boot leaves the live owner intact and refuses concurrent continuation.
  expect((await second.db.getMeeting(id))?.status).toBe('recording');
  await expect(second.session.continueMeeting(id, { source: 'mic' })).rejects.toMatchObject({ code: 'already-recording' });
  expect((await first.db.getMeeting(id))?.status).toBe('recording');
  first.emit({ startMs: 0, endMs: 45000, blob: new Blob(['first tab audio']), mimeType: 'audio/wav' });
  await vi.waitFor(async () => expect(await first.db.listSegments(id)).toHaveLength(1), { interval: 5 });
  await first.session.stopRecording();
  await second.session.continueMeeting(id, { source: 'mic' });
  second.emit({ startMs: 45000, endMs: 90000, blob: new Blob(['second tab audio']), mimeType: 'audio/wav' });
  await second.session.stopRecording();
  expect((await first.db.listSegments(id)).map(s => s.seq)).toEqual([0, 1]);
});
