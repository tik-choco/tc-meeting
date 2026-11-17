import { useEffect, useState } from 'preact/hooks';
import { RefreshCw } from 'lucide-preact';
import { listMicDevices } from '../lib/audio/capture';
import type { CaptureSource } from '../types';
import { useLocale } from '../hooks/useLocale';
import { ErrorNotice } from './ErrorNotice';
import { TRANSLATION_LANGUAGES } from '../lib/ai/translate';
export const RECOGNITION_LANGUAGES = [
  ['en', 'English'], ['ja', '日本語'], ['zh', '中文'], ['ko', '한국어'], ['es', 'Español'], ['fr', 'Français'],
  ['de', 'Deutsch'], ['pt', 'Português'], ['it', 'Italiano'], ['nl', 'Nederlands'], ['ru', 'Русский'], ['uk', 'Українська'],
  ['ar', 'العربية'], ['hi', 'हिन्दी'], ['id', 'Bahasa Indonesia'], ['vi', 'Tiếng Việt'], ['th', 'ไทย'], ['tr', 'Türkçe'],
] as const;
export function LanguageSelect({ value, onChange }: { value: string; onChange(value: string): void }) {
  const { t } = useLocale();
  return <label class="field"><span>{t('language')}</span><select value={value} onChange={event => onChange(event.currentTarget.value)}><option value="">{t('auto')}</option>{RECOGNITION_LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>;
}
export function TranslationSelect({ value, onChange }: { value: string; onChange(value: string): void }) {
  const { t, locale } = useLocale();
  let names: Intl.DisplayNames | undefined;
  try { names = new Intl.DisplayNames(locale, { type: 'language' }); } catch { /* Fall back to language codes. */ }
  return <label class="field"><span>{t('translationTarget')}</span><select value={value} onChange={event => onChange(event.currentTarget.value)}><option value="">{t('translationOff')}</option>{TRANSLATION_LANGUAGES.map(code => {
    let name = code;
    try { name = names?.of(code) || code; } catch { /* Fall back to the code. */ }
    return <option key={code} value={code}>{name}</option>;
  })}</select></label>;
}
export function SourceSelect({ value, onChange }: { value: CaptureSource; onChange(value: CaptureSource): void }) {
  const { t } = useLocale();
  const tabAvailable = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  useEffect(() => { if (!tabAvailable && value === 'mic+tab') onChange('mic'); }, [tabAvailable, value]);
  return <label class="field"><span>{t('source')}</span><select value={tabAvailable ? value : 'mic'} onChange={event => onChange(event.currentTarget.value as CaptureSource)}><option value="mic">{t('mic')}</option>{tabAvailable && <option value="mic+tab">{t('mic+tab')}</option>}</select></label>;
}
export function MicSelect({ value, onChange }: { value: string; onChange(value: string): void }) {
  const { t } = useLocale();
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (value && devices.length && !devices.some(device => device.deviceId === value)) onChange(''); }, [value, devices]);
  async function refresh() { try { setDevices(await listMicDevices()); setError(null); } catch (cause) { setError(cause); } }
  useEffect(() => {
    let active = true;
    const load = async () => { try { const next = await listMicDevices(); if (active) setDevices(next); } catch { /* Labels/devices may not be available until permission. */ } };
    void load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => { active = false; navigator.mediaDevices?.removeEventListener?.('devicechange', load); };
  }, []);
  return <div><div class="mic-select"><label class="field"><span>{t('microphone')}</span><select value={devices.some(device => device.deviceId === value) ? value : ''} onChange={event => onChange(event.currentTarget.value)}><option value="">{t('defaultMic')}</option>{devices.filter(device => device.deviceId).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || t('unnamedMic', { number: index + 1 })}</option>)}</select></label><button type="button" class="icon-button" aria-label={t('refreshDevices')} onClick={() => void refresh()}><RefreshCw size={16} /></button></div><ErrorNotice error={error} onDismiss={() => setError(null)} /></div>;
}
