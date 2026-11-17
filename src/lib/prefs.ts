import type { CaptureSource, ChunkProfile, Locale } from '../types';
import { isTranslationLanguage } from './ai/translate';

export const PREFS_KEY = 'tc-meeting:prefs-v1';
const CHANGE_EVENT = 'tc-meeting:prefs-change';
export interface Preferences {
  locale?: Locale;
  defaultLanguage: string;
  defaultSource: CaptureSource;
  micDeviceId: string;
  keepAudio: boolean;
  translateTo: string;
  liveNotes: boolean;
  proofread: boolean;
  chunkProfile: ChunkProfile;
}
export const DEFAULT_PREFS: Preferences = {
  defaultLanguage: '', defaultSource: 'mic', micDeviceId: '', keepAudio: true, translateTo: '', liveNotes: true, proofread: false, chunkProfile: 'standard',
};
export const LOCALES: readonly Locale[] = ['en', 'ja', 'zh-CN', 'zh-TW'];
export function isLocale(value: unknown): value is Locale {
  return LOCALES.includes(value as Locale);
}
function validate(value: unknown): Preferences {
  const result = { ...DEFAULT_PREFS };
  if (!value || typeof value !== 'object') return result;
  const raw = value as Record<string, unknown>;
  if (isLocale(raw.locale)) result.locale = raw.locale;
  if (typeof raw.defaultLanguage === 'string' && /^(|[a-z]{2})$/.test(raw.defaultLanguage)) result.defaultLanguage = raw.defaultLanguage;
  if (raw.defaultSource === 'mic' || raw.defaultSource === 'mic+tab') result.defaultSource = raw.defaultSource;
  if (typeof raw.micDeviceId === 'string') result.micDeviceId = raw.micDeviceId;
  if (typeof raw.keepAudio === 'boolean') result.keepAudio = raw.keepAudio;
  if (raw.translateTo === '' || isTranslationLanguage(raw.translateTo)) result.translateTo = raw.translateTo;
  if (typeof raw.liveNotes === 'boolean') result.liveNotes = raw.liveNotes;
  if (typeof raw.proofread === 'boolean') result.proofread = raw.proofread;
  if (raw.chunkProfile === 'standard' || raw.chunkProfile === 'fast') result.chunkProfile = raw.chunkProfile;
  return result;
}
export function loadPrefs(): Preferences {
  try { return validate(JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null')); }
  catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(prefs: Partial<Preferences>): Preferences {
  const next = validate({ ...loadPrefs(), ...prefs });
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* Storage may be disabled. */ }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  return next;
}
export function subscribePrefs(cb: (prefs: Preferences) => void): () => void {
  const local = (event: Event) => cb((event as CustomEvent<Preferences>).detail);
  const remote = (event: StorageEvent) => { if (event.key === PREFS_KEY || event.key === null) cb(loadPrefs()); };
  window.addEventListener(CHANGE_EVENT, local);
  window.addEventListener('storage', remote);
  return () => { window.removeEventListener(CHANGE_EVENT, local); window.removeEventListener('storage', remote); };
}
export function detectLocale(language = navigator.language): Locale {
  const normalized = language.toLowerCase();
  if (normalized.startsWith('ja')) return 'ja';
  if (normalized.startsWith('zh')) return /(?:tw|hk|mo|hant)/.test(normalized) ? 'zh-TW' : 'zh-CN';
  return 'en';
}
