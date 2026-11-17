import { AlertCircle, X } from 'lucide-preact';
import { useLocale } from '../hooks/useLocale';
import { errorKey } from '../i18n';
export function ErrorNotice({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  const { t } = useLocale();
  if (!error) return null;
  return <div class="notice danger" role="alert"><AlertCircle size={18} /><span>{t(errorKey(error))}</span>{onDismiss && <button class="icon-button" aria-label={t('dismiss')} onClick={onDismiss}><X size={16} /></button>}</div>;
}
