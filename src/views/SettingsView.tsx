import { useEffect, useState } from 'preact/hooks';
import type { Theme } from '../hooks/useTheme';
import { useLocale } from '../hooks/useLocale';
import { loadPrefs, LOCALES, savePrefs, subscribePrefs } from '../lib/prefs';
import { MeetingAiSettings } from '../components/MeetingAiSettings';
import { RecordingFields } from '../components/HomeFields';
import { ErrorNotice } from '../components/ErrorNotice';
import { ScreenBoundary } from '../components/ScreenBoundary';
import type { Locale } from '../types';
import { LoaderCircle, Square, Volume2 } from 'lucide-preact';
import { useSpeechState } from '../hooks/useSpeech';
import { getSpeechState, speak, stopSpeech } from '../lib/speech';
import { SpeechNotice } from '../components/SpeechNotice';
const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', ja: '日本語', 'zh-CN': '简体中文', 'zh-TW': '繁體中文' };
export function SettingsView({ theme, setTheme }: { theme: Theme; setTheme(theme: Theme): void }) {
  const { t, locale, setLocale } = useLocale();
  const speech = useSpeechState();
  const testingVoice = speech.activeId === 'settings-test';
  useEffect(() => () => { if (getSpeechState().activeId === 'settings-test') stopSpeech(); }, []);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => subscribePrefs(setPrefs), []);
  useEffect(() => {
    let active = true;
    async function loadStorage() {
      try {
        const [usage, durable] = await Promise.all([navigator.storage?.estimate?.(), navigator.storage?.persisted?.()]);
        if (active) { setEstimate(usage ?? null); setPersisted(durable ?? false); }
      } catch { /* Some browsers do not expose storage management. */ }
    }
    void loadStorage(); return () => { active = false; };
  }, []);
  async function persist() {
    try { const result = await navigator.storage?.persist?.(); setPersisted(!!result); setDenied(!result); }
    catch (cause) { setError(cause); }
  }
  return <div class="page settings-page"><h1>{t('settings')}</h1><section class="card"><div class="form-grid"><label class="field"><span>{t('appLanguage')}</span><select value={locale} onChange={event => setLocale(event.currentTarget.value as Locale)}>{LOCALES.map(value => <option value={value} key={value}>{LANGUAGE_NAMES[value]}</option>)}</select></label><label class="field"><span>{t('appearance')}</span><select value={theme} onChange={event => setTheme(event.currentTarget.value as Theme)}><option value="light">{t('light')}</option><option value="dark">{t('dark')}</option></select></label></div></section>
    <section class="card settings-inner"><ScreenBoundary><MeetingAiSettings /></ScreenBoundary><div class="button-row speech-controls"><button aria-pressed={testingVoice} aria-busy={testingVoice && speech.loading} onClick={() => speak('settings-test', [t('ttsTestSample')], locale.split('-')[0])}>{testingVoice && speech.loading ? <LoaderCircle size={16} class="speech-spinner" /> : testingVoice ? <Square size={16} /> : <Volume2 size={16} />}{t(testingVoice ? 'stopReading' : 'ttsTest')}</button></div><SpeechNotice speech={speech} /></section>
    <section class="card"><h2>{t('defaults')}</h2><RecordingFields prefs={prefs} onChange={next => { setPrefs(next); savePrefs(next); }} /></section>
    <section class="card"><h2>{t('storage')}</h2><p class="muted">{t('storageHint')}</p><p>{estimate && estimate.quota !== undefined ? t('storageUsage', { used: ((estimate.usage ?? 0) / 1048576).toFixed(1), quota: (estimate.quota / 1048576).toFixed(0) }) : t('storageUnavailable')}</p><button disabled={persisted || typeof navigator.storage?.persist !== 'function'} onClick={() => void persist()}>{t(persisted ? 'persisted' : 'persist')}</button>{denied && <p class="notice">{t('persistDenied')}</p>}<ErrorNotice error={error} onDismiss={() => setError(null)} /></section>
  </div>;
}
