import { X } from 'lucide-preact';
import { useLocale } from '../hooks/useLocale';
import type { SpeechState } from '../lib/speech';
import { clearSpeechError } from '../lib/speech';
import { ErrorNotice } from './ErrorNotice';

export function SpeechNotice({ speech }: { speech: SpeechState }) {
  const { t } = useLocale();
  return <>{speech.fallback && <div class="notice" role="status"><span>{t('ttsFallback')}</span><button class="icon-button" aria-label={t('dismiss')} onClick={clearSpeechError}><X size={16} /></button></div>}<ErrorNotice error={speech.error} onDismiss={clearSpeechError} /></>;
}
