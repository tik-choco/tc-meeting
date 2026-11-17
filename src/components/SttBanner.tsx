import { CircleCheck, AudioLines } from 'lucide-preact';
import { useSttStatus } from '../hooks/useSttStatus';
import { useLocale } from '../hooks/useLocale';
import { errorKey } from '../i18n';
export function SttBanner() {
  const status = useSttStatus();
  const { t } = useLocale();
  return <div class={`notice ${status.configured ? 'success' : ''}`}><span>{status.configured ? <CircleCheck size={19} /> : <AudioLines size={19} />}</span><div><p>{t(status.configured ? 'sttReady' : 'sttMissing')}</p>{!status.configured && <a href="#/settings">{t('configure')}</a>}{status.problem === 'unresolved' && <p>{t(errorKey('stt-unresolved'))}</p>}</div></div>;
}
