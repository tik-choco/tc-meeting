// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { expect, it, vi } from 'vitest';
import { AppError } from '../types';
import * as db from './db';
import { createTranscriptionQueue } from './queue';

it('a concurrent old blocking error must not undo resume after settings have been fixed', async () => {
  vi.stubGlobal('Blob', NativeBlob);
  vi.stubGlobal('BroadcastChannel', undefined);
  await db.__setDbName(`review-resume-${crypto.randomUUID()}`);
  const date = new Date().toISOString();
  await db.putMeeting({ id: 'm', title: 'Queue resume race', createdAt: date, updatedAt: date,
    status: 'stopped', source: 'mic', language: '', durationMs: 90000, nextSeq: 2, keepAudio: true });
  for (const seq of [0, 1]) {
    await db.addSegmentWithAudio({ id: `m:${seq}`, meetingId: 'm', seq,
      startMs: seq * 45000, endMs: (seq + 1) * 45000, status: 'pending', text: '',
      edited: false, attempts: 0, mimeType: 'audio/wav', hasAudio: true }, new Blob(['speech']));
  }
  let configured = false;
  let oldCalls = 0;
  let releaseOld!: () => void;
  const oldRequests = new Promise<void>(resolve => { releaseOld = resolve; });
  const transcribe = vi.fn(async () => {
    if (!configured) {
      if (++oldCalls === 2) releaseOld();
      await oldRequests;
      throw new AppError('stt-not-configured');
    }
    return { text: 'Transcribed after fixing settings', via: 'api' as const };
  });
  const queue = createTranscriptionQueue({ transcribe, concurrency: 2 });
  let resumed = false;
  // AppShell resumes on a configuration change. At this point the other old
  // request has already thrown, but its IDB pending-status write is outstanding.
  const unsubscribe = queue.subscribe(state => {
    if (state.paused && !resumed) {
      resumed = true;
      configured = true;
      queue.resume();
    }
  });
  try {
    queue.enqueue('m:0'); queue.enqueue('m:1');
    await vi.waitFor(() => expect(resumed).toBe(true), { interval: 5 });
    await vi.waitFor(() => expect(queue.getState().active).toBe(0), { interval: 5 });
    expect({ statuses: (await db.listSegments('m')).map(s => s.status), paused: queue.getState().paused })
      .toEqual({ statuses: ['done', 'done'], paused: false });
  } finally {
    unsubscribe(); queue.dispose();
    await vi.waitFor(() => expect(queue.getState().active).toBe(0), { interval: 5 });
    await db.__setDbName(`closed-${crypto.randomUUID()}`);
    vi.unstubAllGlobals();
  }
});
