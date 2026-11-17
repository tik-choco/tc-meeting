// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as db from '../lib/db';
import { MeetingView } from '../views/MeetingView';
import { SummaryPanel } from '../components/SummaryPanel';
import { useMeeting } from '../hooks/useMeeting';
import { useAssistState } from '../hooks/useAssistState';
import { summarizeMeeting } from '../lib/ai/summary';
import type { Meeting, Segment } from '../types';
import { AppError } from '../types';
import { useSpeechState } from '../hooks/useSpeech';
import { speak, stopSpeech } from '../lib/speech';

vi.mock('../hooks/useMeeting', () => ({ useMeeting: vi.fn() }));
vi.mock('../hooks/useQueueState', () => ({ useQueueState: () => ({ pending: 0, active: 0, failed: 0, paused: false }) }));
vi.mock('../hooks/useAssistState', () => ({ useAssistState: vi.fn() }));
vi.mock('../lib/session', () => ({ getQueue: vi.fn(), continueMeeting: vi.fn(), pauseRecording: vi.fn(), resumeRecording: vi.fn(), stopRecording: vi.fn() }));
vi.mock('../lib/ai/summary', () => ({ summarizeMeeting: vi.fn() }));
vi.mock('../hooks/useSpeech', () => ({ useSpeechState: vi.fn() }));
vi.mock('../lib/speech', () => ({ speak: vi.fn(), stopSpeech: vi.fn(), clearSpeechError: vi.fn(), getSpeechState: vi.fn(() => ({ activeId: null, loading: false, itemIndex: null, fallback: false, error: null })) }));

const meeting: Meeting = { id: 'm', title: 'Before', createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z', durationMs: 45000, nextSeq: 1, status: 'recording', source: 'mic', language: '', keepAudio: true };
const segment: Segment = { id: 'm:000000', meetingId: 'm', seq: 0, startMs: 0, endMs: 45000, status: 'done', text: 'Discussed budget.', edited: false, attempts: 0, mimeType: 'audio/wav', hasAudio: false };
let root: HTMLDivElement;
let databaseName: string;
const realGetMeeting = db.getMeeting;
const realUpdateMeeting = db.updateMeeting;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(useSpeechState).mockReturnValue({ activeId: null, loading: false, itemIndex: null, fallback: false, error: null });
  vi.mocked(useAssistState).mockReturnValue({ leader: false, translatePending: 0, translateActive: 0, proofreadPending: 0, proofreadActive: 0, notesMeetingId: null, notesDraft: '' });
  // Avoid opening a real cross-tab channel; only the actual fake IDB is used.
  vi.stubGlobal('BroadcastChannel', undefined);
  databaseName = `review-${crypto.randomUUID()}`;
  await db.__setDbName(databaseName);
  await db.putMeeting(meeting);
  await db.putSegment(segment);
  vi.mocked(useMeeting).mockReturnValue({ meeting, segments: [segment], loading: false, error: null, live: false, recording: { phase: 'idle', meetingId: null, elapsedMs: 0, level: 0 } });
  vi.mocked(summarizeMeeting).mockResolvedValue('Minutes');
  root = document.createElement('div'); document.body.append(root);
});

it('reads only valid visible corrections in sequence order and keeps highlighting tied to the playback snapshot', async () => {
  const first: Segment = { ...segment, proofread: { source: segment.text, text: segment.text, at: meeting.createdAt } };
  const last: Segment = { ...segment, id: 'm:000002', seq: 2, text: 'Last original', proofread: { source: 'Last original', text: 'Last correction', at: meeting.createdAt } };
  const stale: Segment = { ...segment, id: 'm:000001', seq: 1, text: 'Changed', proofread: { source: 'Old', text: 'Stale correction', at: meeting.createdAt } };
  const data = { meeting: { ...meeting, language: 'en' }, segments: [last, stale, first], loading: false, error: null, live: true, recording: { phase: 'recording' as const, meetingId: 'm', elapsedMs: 0, level: 0 } };
  vi.mocked(useMeeting).mockReturnValue(data);
  await act(() => render(h(MeetingView, { id: 'm' }), root));
  expect(root.textContent).toContain('Use headphones.');
  await act(() => root.querySelector<HTMLButtonElement>('.speech-controls button')!.click());
  expect(speak).toHaveBeenCalledWith('all:m', [segment.text, 'Last correction'], 'en');
  const scroll = vi.fn();
  root.querySelector<HTMLElement>('[data-segment-id="m:000002"]')!.scrollIntoView = scroll;
  vi.mocked(useSpeechState).mockReturnValue({ activeId: 'all:m', loading: false, itemIndex: 1, fallback: false, error: null });
  // A newly completed correction must not shift the item index of this sequence.
  vi.mocked(useMeeting).mockReturnValue({ ...data, segments: [first, { ...stale, proofread: { source: stale.text, text: 'New correction', at: meeting.createdAt } }, last] });
  await act(() => render(h(MeetingView, { id: 'm' }), root));
  expect(root.querySelector('.segment-speaking')?.getAttribute('data-segment-id')).toBe(last.id);
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
  await act(() => root.querySelector<HTMLButtonElement>('.speech-controls button')!.click());
  expect(stopSpeech).toHaveBeenCalled();
  const calls = vi.mocked(stopSpeech).mock.calls.length;
  await act(() => render(h(MeetingView, { id: 'other' }), root));
  expect(stopSpeech).toHaveBeenCalledTimes(calls + 1);
});

it('limits read-all to search results and does not scroll while searching', async () => {
  const corrected = { ...segment, proofread: { source: segment.text, text: 'Correction only', at: meeting.createdAt } };
  const other = { ...segment, id: 'm:000001', seq: 1, text: 'Other', proofread: { source: 'Other', text: 'Other correction', at: meeting.createdAt } };
  const data = vi.mocked(useMeeting).mock.results[0]?.value;
  vi.mocked(useMeeting).mockReturnValue({ ...data, meeting, segments: [corrected, other], loading: false, error: null, live: false, recording: { phase: 'idle', meetingId: null, elapsedMs: 0, level: 0 } });
  await act(() => render(h(MeetingView, { id: 'm' }), root));
  await act(() => { const search = root.querySelector<HTMLInputElement>('input[type="search"]')!; search.value = 'Correction only'; search.dispatchEvent(new Event('input', { bubbles: true })); });
  const scroll = vi.fn(); root.querySelector<HTMLElement>('[data-segment-id]')!.scrollIntoView = scroll;
  await act(() => root.querySelector<HTMLButtonElement>('.speech-controls button')!.click());
  expect(speak).toHaveBeenCalledWith('all:m', ['Correction only'], '');
  vi.mocked(useSpeechState).mockReturnValue({ activeId: 'all:m', loading: false, itemIndex: 0, fallback: false, error: null });
  await act(() => render(h(MeetingView, { id: 'm' }), root));
  expect(scroll).not.toHaveBeenCalled();
});
afterEach(async () => {
  await act(() => render(null, root)); root.remove();
  vi.restoreAllMocks();
  await db.__setDbName(`unused-${crypto.randomUUID()}`);
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  vi.unstubAllGlobals();
});

it('renaming during chunk persistence must not roll back duration/nextSeq/status', async () => {
  await act(() => render(h(MeetingView, { id: 'm' }), root));
  const write = vi.spyOn(db, 'updateMeeting').mockImplementationOnce(async (id, update) => {
    // Session commits another chunk after the view renders, before the edit commits.
    await realUpdateMeeting(id, current => ({ ...current, nextSeq: 2, durationMs: 90000, status: 'stopped' }));
    return realUpdateMeeting(id, update);
  });
  await act(() => { const input = root.querySelector<HTMLInputElement>('input.title-input')!; input.value = 'Renamed'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => { root.querySelector('input.title-input')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  await write.mock.results[0].value;
  expect(await realGetMeeting('m')).toMatchObject({ title: 'Renamed', durationMs: 90000, nextSeq: 2, status: 'stopped' });
});

it('changing the translation target preserves concurrent assist and timeline updates', async () => {
  await act(() => render(h(MeetingView, { id: 'm' }), root));
  const write = vi.spyOn(db, 'updateMeeting').mockImplementationOnce(async (id, update) => {
    await realUpdateMeeting(id, current => ({ ...current, durationMs: 90000, nextSeq: 2, assist: { translateTo: 'fr', liveNotes: true, proofread: true } }));
    return realUpdateMeeting(id, update);
  });
  const select = Array.from(root.querySelectorAll('label')).find(label => label.textContent?.includes('Translation language'))!.querySelector('select')!;
  await act(() => { select.value = 'ja'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  await write.mock.results[0].value;
  expect(await realGetMeeting('m')).toMatchObject({ durationMs: 90000, nextSeq: 2, assist: { translateTo: 'ja', liveNotes: true, proofread: true } });
});

it('enables proofreading without overwriting concurrent assist changes and shows the fast profile', async () => {
  const current = { ...meeting, chunkProfile: 'fast' as const };
  vi.mocked(useMeeting).mockReturnValue({ meeting: current, segments: [segment], loading: false, error: null, live: false, recording: { phase: 'idle', meetingId: null, elapsedMs: 0, level: 0 } });
  await act(() => render(h(MeetingView, { id: 'm' }), root));
  expect(root.textContent).toContain('Fast segments');
  const write = vi.spyOn(db, 'updateMeeting').mockImplementationOnce(async (id, update) => {
    await realUpdateMeeting(id, value => ({ ...value, durationMs: 90000, assist: { translateTo: 'fr', liveNotes: true } }));
    return realUpdateMeeting(id, update);
  });
  const checkbox = Array.from(root.querySelectorAll('label')).find(label => label.textContent?.includes('Proofread transcript'))!.querySelector('input')!;
  await act(() => checkbox.click());
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  await write.mock.results[0].value;
  expect(await realGetMeeting('m')).toMatchObject({ durationMs: 90000, assist: { translateTo: 'fr', liveNotes: true, proofread: true } });
});

it('links to model settings when proofreading is blocked', async () => {
  const current = { ...meeting, assist: { translateTo: '', liveNotes: false, proofread: true } };
  vi.mocked(useMeeting).mockReturnValue({ meeting: current, segments: [segment], loading: false, error: null, live: false, recording: { phase: 'idle', meetingId: null, elapsedMs: 0, level: 0 } });
  vi.mocked(useAssistState).mockReturnValue({ leader: true, translatePending: 0, translateActive: 0, proofreadPending: 1, proofreadActive: 0, notesMeetingId: null, notesDraft: '', blockedBy: 'llm-not-configured' });
  await act(() => render(h(MeetingView, { id: 'm' }), root));
  const notice = root.querySelector('.transcript-panel .notice');
  expect(notice?.textContent).toContain('proofreading');
  expect(notice?.querySelector('a')?.getAttribute('href')).toBe('#/settings');
});

it('searches valid translations but not stale translations', async () => {
  const current = { ...meeting, assist: { translateTo: 'fr', liveNotes: false } };
  const translated = { ...segment, translation: { source: segment.text, lang: 'fr', text: 'Budget approuvé', at: '2026-11-17T00:00:00Z' } };
  const stale = { ...segment, id: 'm:000001', seq: 1, text: 'Other source', translation: { source: 'Old source', lang: 'fr', text: 'Budget obsolète', at: '2026-11-17T00:00:00Z' } };
  vi.mocked(useMeeting).mockReturnValue({ meeting: current, segments: [translated, stale], loading: false, error: null, live: false, recording: { phase: 'idle', meetingId: null, elapsedMs: 0, level: 0 } });
  await act(() => render(h(MeetingView, { id: 'm' }), root));
  const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(() => { input.value = 'approuvé'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(root.querySelectorAll('.segment')).toHaveLength(1);
  expect(root.querySelector('.segment-translation mark')?.textContent).toBe('approuvé');
  await act(() => { input.value = 'obsolète'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(root.querySelectorAll('.segment')).toHaveLength(0);
  expect(root.textContent).toContain('No matching segments.');
});

it('searches valid corrections but not stale corrections', async () => {
  const current = { ...meeting, assist: { translateTo: '', liveNotes: false, proofread: true } };
  const corrected = { ...segment, proofread: { source: segment.text, text: 'Discussed allocation.', at: '2026-11-17T00:00:00Z' } };
  const stale = { ...segment, id: 'm:000001', seq: 1, text: 'Other source', proofread: { source: 'Old source', text: 'Obsolete correction', at: '2026-11-17T00:00:00Z' } };
  vi.mocked(useMeeting).mockReturnValue({ meeting: current, segments: [corrected, stale], loading: false, error: null, live: false, recording: { phase: 'idle', meetingId: null, elapsedMs: 0, level: 0 } });
  await act(() => render(h(MeetingView, { id: 'm' }), root));
  const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(() => { input.value = 'allocation'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(root.querySelectorAll('.segment')).toHaveLength(1);
  expect(root.querySelector('.segment-correction mark')?.textContent).toBe('allocation');
  await act(() => { input.value = 'obsolete'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(root.querySelectorAll('.segment')).toHaveLength(0);
  expect(root.textContent).toContain('No matching segments.');
});

it('a summary finishing during deletion must not recreate the deleted meeting', async () => {
  await act(() => render(h(SummaryPanel, { meeting, segments: [segment] }), root));
  const write = vi.spyOn(db, 'updateMeeting').mockImplementationOnce(async (id, update) => {
    await db.deleteMeeting(id); // Another tab deletes before the write transaction.
    return realUpdateMeeting(id, update);
  });
  await act(() => Array.from(root.querySelectorAll('button')).find(button => button.textContent?.includes('Generate minutes'))!.click());
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  await write.mock.results[0].value;
  expect(await realGetMeeting('m'), 'deleted meetings must stay deleted').toBeUndefined();
});

it('Cancel while the summary save is waiting for IDB must preserve the previous minutes', async () => {
  const previous = { ...meeting, summary: { text: 'Previous minutes', createdAt: meeting.createdAt, segmentCount: 1 } };
  await db.putMeeting(previous);
  let release!: () => void;
  const write = vi.spyOn(db, 'updateMeeting').mockImplementationOnce((id, update) => new Promise((resolve, reject) => {
    release = () => { void realUpdateMeeting(id, update).then(resolve, reject); };
  }));
  await act(() => render(h(SummaryPanel, { meeting: previous, segments: [segment] }), root));
  await act(() => Array.from(root.querySelectorAll('button')).find(button => button.textContent?.includes('Regenerate minutes'))!.click());
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  await act(() => Array.from(root.querySelectorAll('button')).find(button => button.textContent === 'Cancel')!.click());
  await act(async () => { release(); await Promise.resolve(); });
  await vi.waitFor(() => expect(root.textContent).toContain('Regenerate minutes'));
  await expect(write.mock.results[0].value).rejects.toMatchObject({ code: 'aborted' });
  expect((await realGetMeeting('m'))?.summary?.text, 'a cancelled summary must not replace saved minutes').toBe('Previous minutes');
});

it('summary completion preserves timeline changes made during generation', async () => {
  vi.mocked(summarizeMeeting).mockImplementationOnce(async () => {
    await realUpdateMeeting('m', current => ({ ...current, durationMs: 90000, nextSeq: 2, status: 'paused' }));
    return 'Minutes';
  });
  await act(() => render(h(SummaryPanel, { meeting, segments: [segment] }), root));
  await act(() => root.querySelector<HTMLButtonElement>('button.primary')!.click());
  await vi.waitFor(async () => expect(await realGetMeeting('m')).toMatchObject({ durationMs: 90000, nextSeq: 2, status: 'paused', summary: { text: 'Minutes' } }));
});

it('renaming a meeting deleted after render does not recreate it', async () => {
  await act(() => render(h(MeetingView, { id: 'm' }), root));
  await db.deleteMeeting('m');
  const write = vi.spyOn(db, 'updateMeeting');
  await act(() => { const input = root.querySelector<HTMLInputElement>('input.title-input')!; input.value = 'Renamed'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => { root.querySelector('input.title-input')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  await write.mock.results[0].value;
  expect(await realGetMeeting('m')).toBeUndefined();
});

it('shows localized recording errors after the recorder returns to idle', async () => {
  vi.mocked(useMeeting).mockReturnValue({ meeting, segments: [segment], loading: false, error: null, live: false, recording: { phase: 'idle', meetingId: null, elapsedMs: 45000, level: 0, error: new AppError('unknown', 'private recorder detail') } });
  await act(() => render(h(MeetingView, { id: 'm' }), root));
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('The operation could not be completed. Please try again.');
  expect(root.textContent).not.toContain('private recorder detail');
});

it('cancelling generation suppresses a late summary result', async () => {
  let finish!: (text: string) => void;
  vi.mocked(summarizeMeeting).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const write = vi.spyOn(db, 'updateMeeting');
  await act(() => render(h(SummaryPanel, { meeting, segments: [segment] }), root));
  await act(() => root.querySelector<HTMLButtonElement>('button.primary')!.click());
  const signal = vi.mocked(summarizeMeeting).mock.calls[0][0].signal;
  await act(() => Array.from(root.querySelectorAll('button')).find(button => button.textContent === 'Cancel')!.click());
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish('Late minutes'); await Promise.resolve(); });
  expect(write).not.toHaveBeenCalled();
  expect((await realGetMeeting('m'))?.summary).toBeUndefined();
});
