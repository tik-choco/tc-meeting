import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecordingBar } from './RecordingBar';
import { LocaleProvider } from '../hooks/useLocale';
import { translator } from '../i18n';
import { AppError } from '../types';
import type { Locale } from '../types';
import type { RecordingPhase } from '../lib/session';

vi.mock('../lib/session', () => ({ stopRecording: vi.fn() }));
let root: HTMLDivElement;
beforeEach(() => { localStorage.clear(); root = document.createElement('div'); document.body.append(root); });
afterEach(() => { act(() => render(null, root)); root.remove(); localStorage.clear(); });

it.each<Locale>(['en', 'ja', 'zh-CN', 'zh-TW'])('localizes recorder errors in %s even after recording stops', async locale => {
  localStorage.setItem('tc-meeting:prefs-v1', JSON.stringify({ locale }));
  await act(() => render(h(LocaleProvider, { children: h(RecordingBar, { state: { phase: 'idle', meetingId: null, elapsedMs: 1000, level: 0, error: new AppError('unknown', 'private recorder details') }, onError: vi.fn() }) }), root));
  expect(root.querySelector('[role="alert"]')?.textContent).toContain(translator(locale)('error.unknown'));
  expect(root.textContent).not.toContain('private recorder details');
  expect(root.querySelector('aside.recording-bar')).toBeNull();
});

it.each<RecordingPhase>(['recording', 'paused', 'stopping'])('shows any recording error during %s', async phase => {
  await act(() => render(h(RecordingBar, { state: { phase, meetingId: 'm', elapsedMs: 1000, level: 0, error: new AppError('storage-full') }, onError: vi.fn() }), root));
  expect(root.querySelector('[role="alert"]')?.textContent).toContain(translator('en')('error.storage-full'));
  expect(root.querySelector('aside.recording-bar')).not.toBeNull();
});
