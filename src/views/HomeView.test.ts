import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeView } from './HomeView';
import { LocaleProvider } from '../hooks/useLocale';
import { listMeetings, subscribeDb } from '../lib/db';
import { startNewMeeting } from '../lib/session';
vi.mock('../lib/session', () => ({
  getRecordingState: () => ({ phase: 'idle', meetingId: null, elapsedMs: 0, level: 0 }),
  subscribeRecording: () => () => {}, startNewMeeting: vi.fn().mockResolvedValue('new-meeting'),
}));
vi.mock('../lib/db', () => ({ listMeetings: vi.fn().mockResolvedValue([]), listSegments: vi.fn().mockResolvedValue([]), subscribeDb: vi.fn(() => () => {}), deleteMeeting: vi.fn() }));
vi.mock('../lib/ai/stt', () => ({ getSttStatus: () => ({ configured: false, model: '', transport: null }), subscribeSttStatus: () => () => {} }));
vi.mock('../lib/audio/capture', () => ({ listMicDevices: async () => [{ deviceId: 'mic-1', label: '' }] }));
vi.mock('../lib/audio/mime', () => ({ isRecordingSupported: () => true }));
const importer = { progress: null, error: null, start: vi.fn(), cancel: vi.fn(), clearError: vi.fn() };
let root: HTMLDivElement;
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('tc-meeting:prefs-v1', '{"locale":"en"}');
  root = document.createElement('div'); document.body.append(root); vi.clearAllMocks();
});
afterEach(() => { act(() => render(null, root)); root.remove(); history.replaceState(null, '', '#/'); });
async function mount() {
  await act(() => { render(h(LocaleProvider, { children: h(HomeView, { importer }) }), root); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
describe('Home view', () => {
  it('renders creation, import, empty meetings and setup link with mocked integrations', async () => {
    await mount();
    expect(root.textContent).toContain('New meeting'); expect(root.textContent).toContain('Import audio file');
    expect(root.textContent).toContain('Your conversations start here.'); expect(root.querySelector('a[href="#/settings"]')).not.toBeNull();
    const start = root.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    await act(async () => { root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(startNewMeeting).toHaveBeenCalledWith(expect.objectContaining({ language: '', source: 'mic', keepAudio: true, chunkProfile: 'standard', title: expect.stringContaining('Meeting'), assist: { translateTo: '', liveNotes: true, proofread: false } }));
    expect(location.hash).toBe('#/m/new-meeting');
  });
  it('passes the selected assist options to recording and import', async () => {
    await mount();
    const select = Array.from(root.querySelectorAll('label')).find(label => label.textContent?.includes('Translation language'))!.querySelector('select')!;
    const checkbox = Array.from(root.querySelectorAll('label')).find(label => label.textContent?.includes('Keep live notes updated'))!.querySelector('input')!;
    const proofread = Array.from(root.querySelectorAll('label')).find(label => label.textContent?.includes('Proofread transcript'))!.querySelector('input')!;
    const chunks = Array.from(root.querySelectorAll('label')).find(label => label.textContent?.includes('Recording segment length'))!.querySelector('select')!;
    await act(() => { select.value = 'ja'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(() => checkbox.click());
    await act(() => proofread.click());
    await act(() => { chunks.value = 'fast'; chunks.dispatchEvent(new Event('change', { bubbles: true })); });
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['audio'], 'conversation.wav', { type: 'audio/wav' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(importer.start).toHaveBeenCalledWith(file, expect.objectContaining({ assist: { translateTo: 'ja', liveNotes: false, proofread: true } }));
    await act(async () => { root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(startNewMeeting).toHaveBeenCalledWith(expect.objectContaining({ chunkProfile: 'fast', assist: { translateTo: 'ja', liveNotes: false, proofread: true } }));
    expect(JSON.parse(localStorage.getItem('tc-meeting:prefs-v1')!)).toMatchObject({ chunkProfile: 'fast', proofread: true });
  });
  it('keeps the form available when database loading or subscription throws', async () => {
    vi.mocked(listMeetings).mockRejectedValueOnce(new Error('stub'));
    vi.mocked(subscribeDb).mockImplementationOnce(() => { throw new Error('stub'); });
    await mount();
    expect(root.querySelector('form')).not.toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('could not be completed');
  });
});
