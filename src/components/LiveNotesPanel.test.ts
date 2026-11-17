import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveNotesPanel } from './LiveNotesPanel';
import { useAssistState } from '../hooks/useAssistState';
import type { AssistState } from '../lib/assist';
import type { Meeting } from '../types';

vi.mock('../hooks/useAssistState', () => ({ useAssistState: vi.fn() }));
const rebuildNotes = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const retryNotes = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../lib/assist', () => ({ getAssist: () => ({ rebuildNotes, retryNotes }) }));
const idle: AssistState = { leader: true, translatePending: 0, translateActive: 0, proofreadPending: 0, proofreadActive: 0, notesMeetingId: null, notesDraft: '' };
const meeting: Meeting = { id: 'm', title: 'Meeting', createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z', durationMs: 0, status: 'stopped', source: 'file', language: '', nextSeq: 2, keepAudio: true, assist: { translateTo: '', liveNotes: true }, liveNotes: { text: 'Saved notes', throughSeq: 1, segmentCount: 2, locale: 'en', updatedAt: '2026-11-17T01:30:00Z' } };
let root: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); vi.mocked(useAssistState).mockReturnValue(idle); root = document.createElement('div'); document.body.append(root); });
afterEach(() => { act(() => render(null, root)); root.remove(); vi.restoreAllMocks(); Reflect.deleteProperty(window, 'confirm'); });

describe('live notes', () => {
  it('keeps saved notes visible until a non-empty draft arrives', async () => {
    for (const notesDraft of ['', '   ']) {
      vi.mocked(useAssistState).mockReturnValue({ ...idle, notesMeetingId: 'm', notesDraft });
      await act(() => render(h(LiveNotesPanel, { meeting, onToggle: vi.fn() }), root));
      expect(root.textContent).toContain('Saved notes');
      expect(root.textContent).toContain('Updating notes…');
    }
  });
  it('shows a localized terminal error and retries without rebuilding or confirmation', async () => {
    await act(() => render(h(LiveNotesPanel, { meeting: { ...meeting, liveNotesError: 'llm-failed' }, onToggle: vi.fn() }), root));
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Live notes failed.');
    expect(root.textContent).toContain('Saved notes');
    const button = Array.from(root.querySelectorAll('button')).find(button => button.textContent === 'Retry notes')!;
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(retryNotes).toHaveBeenCalledWith('m');
    expect(rebuildNotes).not.toHaveBeenCalled();
    await act(() => render(h(LiveNotesPanel, { meeting: { ...meeting, liveNotes: undefined, liveNotesError: 'llm-failed' }, onToggle: vi.fn() }), root));
    expect(root.textContent).not.toContain('Notes will appear as transcripts arrive.');
  });
  it('shows streaming text for this meeting and saved notes for another meeting', async () => {
    const onToggle = vi.fn();
    vi.mocked(useAssistState).mockReturnValue({ ...idle, notesMeetingId: 'm', notesDraft: '# Current\n<script>ignored</script>' });
    await act(() => render(h(LiveNotesPanel, { meeting, onToggle }), root));
    expect(root.textContent).toContain('Current');
    expect(root.textContent).toContain('Updating notes…');
    expect(root.textContent).not.toContain('Saved notes');
    expect(root.querySelector('script')).toBeNull();
    vi.mocked(useAssistState).mockReturnValue({ ...idle, notesMeetingId: 'other', notesDraft: 'Other meeting' });
    await act(() => render(h(LiveNotesPanel, { meeting, onToggle }), root));
    expect(root.textContent).toContain('Saved notes');
    expect(root.textContent).toContain('2 segments');
    expect(root.textContent).not.toContain('Other meeting');
  });
  it('offers setup and enabling when off, and confirms before rebuilding', async () => {
    const onToggle = vi.fn();
    vi.mocked(useAssistState).mockReturnValue({ ...idle, blockedBy: 'llm-not-configured' });
    const off = { ...meeting, assist: { translateTo: '', liveNotes: false } };
    await act(() => render(h(LiveNotesPanel, { meeting: off, onToggle }), root));
    expect(root.querySelector('a[href="#/settings"]')).not.toBeNull();
    await act(() => Array.from(root.querySelectorAll('button')).find(button => button.textContent === 'Enable live notes')!.click());
    expect(onToggle).toHaveBeenCalledWith(true);
    await act(() => render(h(LiveNotesPanel, { meeting, onToggle }), root));
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm });
    const rebuild = Array.from(root.querySelectorAll('button')).find(button => button.textContent === 'Rebuild notes')!;
    await act(() => rebuild.click());
    expect(rebuildNotes).not.toHaveBeenCalled();
    await act(async () => { rebuild.click(); await Promise.resolve(); });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(rebuildNotes).toHaveBeenCalledWith('m');
  });
});
