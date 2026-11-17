import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsView } from './SettingsView';
import { translator } from '../i18n';
import { useLocale } from '../hooks/useLocale';
import { useSpeechState } from '../hooks/useSpeech';
import { getSpeechState, speak, stopSpeech, clearSpeechError } from '../lib/speech';

vi.mock('../components/MeetingAiSettings', () => ({ MeetingAiSettings: () => null }));
vi.mock('../hooks/useLocale', () => ({ useLocale: vi.fn() }));
vi.mock('../hooks/useSpeech', () => ({ useSpeechState: vi.fn() }));
vi.mock('../lib/speech', () => ({ getSpeechState: vi.fn(), speak: vi.fn(), stopSpeech: vi.fn(), clearSpeechError: vi.fn() }));
let root: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.mocked(useLocale).mockReturnValue({ locale: 'ja', t: translator('ja'), setLocale: vi.fn() });
  const state = { activeId: null, loading: false, itemIndex: null, fallback: false, error: null };
  vi.mocked(useSpeechState).mockReturnValue(state); vi.mocked(getSpeechState).mockReturnValue(state);
  root = document.createElement('div'); document.body.append(root);
});
afterEach(() => { act(() => render(null, root)); root.remove(); vi.restoreAllMocks(); });

it('tests the voice using a localized sample and stops its own playback on unmount', async () => {
  await act(() => render(h(SettingsView, { theme: 'light', setTheme: vi.fn() }), root));
  await act(() => root.querySelector<HTMLButtonElement>('.speech-controls button')!.click());
  expect(speak).toHaveBeenCalledWith('settings-test', [translator('ja')('ttsTestSample')], 'ja');
  vi.mocked(getSpeechState).mockReturnValue({ activeId: 'settings-test', loading: false, itemIndex: 0, fallback: false, error: null });
  act(() => render(null, root)); expect(stopSpeech).toHaveBeenCalledOnce();
});

it('shows dismissable fallback/error notices and does not stop another owner on unmount', async () => {
  vi.mocked(useSpeechState).mockReturnValue({ activeId: 'settings-test', loading: true, itemIndex: 0, fallback: true, error: { code: 'tts-failed' } });
  await act(() => render(h(SettingsView, { theme: 'light', setTheme: vi.fn() }), root));
  expect(root.querySelector('.speech-controls button')?.getAttribute('aria-pressed')).toBe('true');
  expect(root.textContent).toContain(translator('ja')('ttsFallback'));
  expect(root.textContent).toContain(translator('ja')('error.tts-failed'));
  await act(() => root.querySelector<HTMLButtonElement>('.notice .icon-button')!.click());
  expect(clearSpeechError).toHaveBeenCalled();
  vi.mocked(getSpeechState).mockReturnValue({ activeId: 'another', loading: false, itemIndex: 0, fallback: false, error: null });
  act(() => render(null, root)); expect(stopSpeech).not.toHaveBeenCalled();
});
