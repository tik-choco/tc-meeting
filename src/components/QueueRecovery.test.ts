// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as db from '../lib/db';
import { createTranscriptionQueue, type TranscriptionQueue } from '../lib/queue';
import { AppError, type Meeting, type Segment } from '../types';
import { MeetingView } from '../views/MeetingView';
import { useMeeting } from '../hooks/useMeeting';
import { getQueue } from '../lib/session';

vi.mock('../hooks/useMeeting', () => ({ useMeeting: vi.fn() }));
vi.mock('../lib/session', () => ({ getQueue: vi.fn(), continueMeeting: vi.fn(), pauseRecording: vi.fn(), resumeRecording: vi.fn(), stopRecording: vi.fn() }));
vi.mock('../lib/ai/summary', () => ({ summarizeMeeting: vi.fn() }));
let queue: TranscriptionQueue | undefined;
let root: HTMLDivElement | undefined;
let name: string;
beforeEach(() => { queue = undefined; root = undefined; name = ''; vi.clearAllMocks(); });
afterEach(async () => {
  queue?.dispose();
  if (root) { await act(() => render(null, root!)); root.remove(); }
  vi.restoreAllMocks();
  await db.__setDbName(`unused-${crypto.randomUUID()}`);
  if (name) await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  vi.unstubAllGlobals();
});

it('Retry must recover a queue paused by a storage error after space is available again', async () => {
  vi.stubGlobal('Blob', NativeBlob); vi.stubGlobal('BroadcastChannel', undefined);
  name = `review-${crypto.randomUUID()}`; await db.__setDbName(name);
  const meeting: Meeting = { id: 'm', title: 'Review', createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z', durationMs: 45000, nextSeq: 1, status: 'stopped', source: 'file', language: '', keepAudio: true };
  const segment: Segment = { id: 'm:000000', meetingId: 'm', seq: 0, startMs: 0, endMs: 45000, status: 'pending', text: '', edited: false, attempts: 0, mimeType: 'audio/wav', hasAudio: true };
  await db.putMeeting(meeting); await db.addSegmentWithAudio(segment, new Blob(['audio']));
  const transcribe = vi.fn().mockResolvedValue({ text: 'Recovered text', via: 'api' });
  queue = createTranscriptionQueue({ transcribe });
  vi.mocked(getQueue).mockReturnValue(queue);
  vi.mocked(useMeeting).mockReturnValue({ meeting, segments: [segment], loading: false, error: null, live: false, recording: { phase: 'idle', meetingId: null, elapsedMs: 0, level: 0 } });
  root = document.createElement('div'); document.body.append(root);
  await act(() => render(h(MeetingView, { id: 'm' }), root!));
  // This occurs after AppShell's configured-STT startup effect has already run.
  // Throw only once: subsequent writes succeed, as after the user frees space.
  vi.spyOn(db, 'updateSegment').mockRejectedValueOnce(new AppError('storage-full'));
  await act(() => queue!.enqueue(segment.id));
  await vi.waitFor(() => expect(queue!.getState()).toMatchObject({ paused: true, active: 0, blockedBy: 'storage-full' }));
  await act(() => root!.querySelector<HTMLButtonElement>('button[aria-label="Retry"]')!.click());
  await vi.waitFor(async () => expect(await db.getSegment(segment.id)).toMatchObject({ status: 'done', text: 'Recovered text' }));
  expect(queue.getState().paused, 'Retry after freeing space must actually dispatch work').toBe(false);
});

it.each(['resume', 'retryFailed'] as const)('%s resumes a paused queue through the meeting banner', async action => {
  const resume = vi.fn();
  const retryFailed = vi.fn().mockResolvedValue(undefined);
  const resumeAll = vi.fn().mockResolvedValue(undefined);
  const state = { pending: 1, active: 0, failed: 1, paused: true, blockedBy: 'storage-full' as const };
  const current = { resume, retryFailed, resumeAll, getState: () => state, subscribe: () => () => {} } as unknown as TranscriptionQueue;
  vi.mocked(getQueue).mockReturnValue(current);
  const meeting: Meeting = { id: 'm', title: 'Review', createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z', durationMs: 45000, nextSeq: 1, status: 'stopped', source: 'file', language: '', keepAudio: true };
  const segment: Segment = { id: 'm:000000', meetingId: 'm', seq: 0, startMs: 0, endMs: 45000, status: 'failed', text: '', edited: false, attempts: 4, mimeType: 'audio/wav', hasAudio: true };
  vi.mocked(useMeeting).mockReturnValue({ meeting, segments: [segment], loading: false, error: null, live: false, recording: { phase: 'idle', meetingId: null, elapsedMs: 0, level: 0 } });
  root = document.createElement('div'); document.body.append(root);
  await act(() => render(h(MeetingView, { id: 'm' }), root!));
  expect(root.textContent).toContain('Queue paused');
  await act(() => Array.from(root!.querySelectorAll('button')).find(button => button.textContent === (action === 'resume' ? 'Resume' : 'Retry failed'))!.click());
  expect(resume).toHaveBeenCalledTimes(1);
  if (action === 'resume') expect(resumeAll).toHaveBeenCalledTimes(1);
  else expect(retryFailed).toHaveBeenCalledWith('m');
});
