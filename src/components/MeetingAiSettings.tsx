import { LlmSettings } from '@tik-choco/mistai/preact';
import { localSettingsAdapter } from '../lib/ai/settings';
import { useLocale } from '../hooks/useLocale';
import '../styles/ai-settings.css';
export function MeetingAiSettings() {
  const { locale, t } = useLocale();
  return <LlmSettings title={t('aiSettings')} locale={locale} localSettings={localSettingsAdapter} voice={{ stt: {}, tts: {} }} tasks={[{ id: 'summary', label: t('summaryTask'), tip: t('summaryTip'), reasoning: true }, { id: 'translate', label: t('translationTask'), tip: t('translationTip'), reasoning: true }, { id: 'proofread', label: t('proofreadTask'), tip: t('proofreadTip'), reasoning: true }]} />;
}
