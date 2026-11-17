import { afterEach, expect, it } from 'vitest';
import { loadPrefs, PREFS_KEY, savePrefs } from '../lib/prefs';

afterEach(() => localStorage.clear());

it('defaults and validates proofreading and live chunk profile preferences', () => {
  expect(loadPrefs()).toMatchObject({ proofread: false, chunkProfile: 'standard' });
  localStorage.setItem(PREFS_KEY, JSON.stringify({ proofread: 'true', chunkProfile: 'huge' }));
  expect(loadPrefs()).toMatchObject({ proofread: false, chunkProfile: 'standard' });
  savePrefs({ proofread: true, chunkProfile: 'fast' });
  expect(loadPrefs()).toMatchObject({ proofread: true, chunkProfile: 'fast' });
  savePrefs({ liveNotes: false });
  expect(loadPrefs()).toMatchObject({ proofread: true, chunkProfile: 'fast', liveNotes: false });
});
