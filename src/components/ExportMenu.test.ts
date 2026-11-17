import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportMenu } from './ExportMenu';
import { exportMeeting } from '../lib/export';
import type { Meeting, Segment } from '../types';

vi.mock('../lib/export', () => ({ exportMeeting: vi.fn(() => ({ filename: 'meeting.txt', mime: 'text/plain', content: 'text' })) }));
const meeting: Meeting = { id: 'm', title: 'Meeting', createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z', durationMs: 0, status: 'stopped', source: 'file', language: '', nextSeq: 0, keepAudio: true, assist: { translateTo: 'ja', liveNotes: true } };
let root: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); root = document.createElement('div'); document.body.append(root); });
afterEach(() => { act(() => render(null, root)); root.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('applies the translation checkbox to copied text and hides it with no target', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  await act(() => render(h(ExportMenu, { meeting, segments: [], onError: vi.fn() }), root));
  const copy = () => Array.from(root.querySelectorAll('button')).find(button => button.textContent?.includes('Copy'))!;
  await act(async () => { copy().click(); await Promise.resolve(); });
  expect(exportMeeting).toHaveBeenLastCalledWith(meeting, [], 'txt', { translation: true, proofread: false });
  await act(() => root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => { copy().click(); await Promise.resolve(); });
  expect(exportMeeting).toHaveBeenLastCalledWith(meeting, [], 'txt', { translation: false, proofread: false });
  expect(writeText).toHaveBeenCalledTimes(2);
  await act(() => render(h(ExportMenu, { meeting: { ...meeting, assist: { translateTo: '', liveNotes: true } }, segments: [], onError: vi.fn() }), root));
  expect(root.querySelector('input[type="checkbox"]')).toBeNull();
});

it('offers persisted current corrections even after proofreading is switched off', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const segment: Segment = { id: 'm:000000', meetingId: 'm', seq: 0, startMs: 0, endMs: 1000, status: 'done', text: 'Original', edited: false, attempts: 0, mimeType: 'audio/wav', hasAudio: false, proofread: { source: 'Original', text: 'Corrected', at: '2026-11-17T00:00:00Z' } };
  const current = { ...meeting, assist: { translateTo: '', liveNotes: false, proofread: false } };
  await act(() => render(h(ExportMenu, { meeting: current, segments: [segment], onError: vi.fn() }), root));
  expect(root.textContent).toContain('Include corrections');
  const copy = () => Array.from(root.querySelectorAll('button')).find(button => button.textContent?.includes('Copy'))!;
  await act(async () => { copy().click(); await Promise.resolve(); });
  expect(exportMeeting).toHaveBeenLastCalledWith(current, [segment], 'txt', { translation: false, proofread: true });
  await act(() => root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => { copy().click(); await Promise.resolve(); });
  expect(exportMeeting).toHaveBeenLastCalledWith(current, [segment], 'txt', { translation: false, proofread: false });
  await act(() => render(h(ExportMenu, { meeting: current, segments: [{ ...segment, text: 'Edited' }], onError: vi.fn() }), root));
  expect(root.textContent).not.toContain('Include corrections');
});
