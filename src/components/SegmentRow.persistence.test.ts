// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SegmentRow } from '../components/SegmentRow';
import { translator } from '../i18n';
import * as db from '../lib/db';
import type { Segment } from '../types';

vi.mock('../lib/session', () => ({ getQueue: vi.fn() }));
const segment: Segment = { id: 'm:000000', meetingId: 'm', seq: 0, startMs: 0, endMs: 45000, status: 'transcribing', text: '', edited: false, attempts: 0, mimeType: 'audio/wav', hasAudio: true };
const realGet = db.getSegment;
const realUpdate = db.updateSegment;
let root: HTMLDivElement;
let name: string;
beforeEach(async () => {
  vi.stubGlobal('Blob', NativeBlob); vi.stubGlobal('BroadcastChannel', undefined);
  name = `review-${crypto.randomUUID()}`; await db.__setDbName(name);
  await db.addSegmentWithAudio(segment, new Blob(['audio']));
  root = document.createElement('div'); document.body.append(root);
});
afterEach(async () => {
  await act(() => render(null, root)); root.remove(); vi.restoreAllMocks();
  await db.__setDbName(`unused-${crypto.randomUUID()}`);
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  vi.unstubAllGlobals();
});

it('saving while the queue finishes and deletes audio must not restore hasAudio=true', async () => {
  await act(() => render(h(SegmentRow, { segment, query: '', t: translator('en'), onError: vi.fn() }), root));
  await act(() => root.querySelector<HTMLButtonElement>('button[aria-label="Edit transcript"]')!.click());
  await act(() => { const text = root.querySelector('textarea')!; text.value = 'Human correction'; text.dispatchEvent(new Event('input', { bubbles: true })); });
  const write = vi.spyOn(db, 'updateSegment').mockImplementationOnce(async (id, update) => {
    // Queue completion lands after the editor opens but before the edit commits.
    await realUpdate(id, current => ({ ...current, text: 'Recognizer result', status: 'done', via: 'api', attempts: 2, transcribedAt: '2026-11-16T00:01:00Z' }));
    await db.deleteSegmentAudio(id);
    return realUpdate(id, update);
  });
  await act(() => Array.from(root.querySelectorAll('button')).find(button => button.textContent === 'Save')!.click());
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1)); await write.mock.results[0].value;
  expect(await db.getSegmentAudio(segment.id)).toBeUndefined();
  expect(await realGet(segment.id)).toMatchObject({ text: 'Human correction', edited: true, hasAudio: false, via: 'api', status: 'done', attempts: 2, transcribedAt: '2026-11-16T00:01:00Z' });
});
