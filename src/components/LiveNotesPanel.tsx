import { useState } from 'preact/hooks';
import { NotebookPen, RotateCcw } from 'lucide-preact';
import type { Meeting } from '../types';
import { errorKey } from '../i18n';
import { getAssist } from '../lib/assist';
import { useAssistState } from '../hooks/useAssistState';
import { useLocale } from '../hooks/useLocale';
import { ErrorNotice } from './ErrorNotice';
import { SafeMarkdown } from './SafeMarkdown';

export function LiveNotesPanel({ meeting, onToggle }: { meeting: Meeting; onToggle(enabled: boolean): void }) {
  const { t, locale } = useLocale();
  const assist = useAssistState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const enabled = meeting.assist?.liveNotes === true;
  const streaming = assist.notesMeetingId === meeting.id;
  const text = streaming && assist.notesDraft.trim() ? assist.notesDraft : meeting.liveNotes?.text;
  const updated = meeting.liveNotes?.updatedAt ? new Date(meeting.liveNotes.updatedAt) : undefined;
  const updatedTime = updated && !Number.isNaN(updated.getTime()) ? updated.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '';

  async function rebuild() {
    if (!window.confirm(t('rebuildNotesConfirm'))) return;
    setBusy(true); setError(null);
    try { await getAssist().rebuildNotes(meeting.id); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }
  async function retry() {
    setBusy(true); setError(null);
    try { await getAssist().retryNotes(meeting.id); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }
  return <section class="card live-notes-panel" aria-label={t('liveNotes')}>
    <div class="section-heading"><h2><NotebookPen size={19} />{t('liveNotes')}</h2></div>
    <label class="check-field"><input type="checkbox" checked={enabled} onChange={event => onToggle(event.currentTarget.checked)} />{t('liveNotesEnable')}</label>
    <p class="muted small">{t(enabled ? 'liveNotesHint' : 'liveNotesOffHint')}</p>
    {assist.blockedBy === 'llm-not-configured' && <p class="notice"><span>{t('assistNeedsModel')} <a href="#/settings">{t('configure')}</a></span></p>}
    <ErrorNotice error={error} onDismiss={() => setError(null)} />
    {meeting.liveNotesError && <p class="danger-text small" role="alert">{t('liveNotesFailed')} {t(errorKey(meeting.liveNotesError))} <button disabled={!enabled || busy || streaming} onClick={() => void retry()}>{t('retryNotes')}</button></p>}
    {text && <SafeMarkdown text={text} />}
    {streaming && <p class="muted small" role="status">{t('updatingNotes')}</p>}
    {!text && !streaming && enabled && !meeting.liveNotesError && <p class="muted small">{t('liveNotesWaiting')}</p>}
    {meeting.liveNotes && updatedTime && <p class="muted small">{t('liveNotesUpdated', { time: updatedTime, count: meeting.liveNotes.segmentCount })}</p>}
    <div class="button-row">{!enabled && <button onClick={() => onToggle(true)}>{t('enableLiveNotes')}</button>}<button disabled={!enabled || busy || streaming} onClick={() => void rebuild()}><RotateCcw size={15} />{t('rebuildNotes')}</button></div>
  </section>;
}
