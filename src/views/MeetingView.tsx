import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowDown, ArrowLeft, LoaderCircle, Pause, Play, Search, Square, Trash2, Volume2 } from 'lucide-preact';
import { useLocale } from '../hooks/useLocale';
import { useMeeting } from '../hooks/useMeeting';
import { useQueueState } from '../hooks/useQueueState';
import { useAssistState } from '../hooks/useAssistState';
import { continueMeeting, getQueue, pauseRecording, resumeRecording, stopRecording } from '../lib/session';
import { deleteMeetingAudio, updateMeeting } from '../lib/db';
import { formatClock } from '../lib/format';
import { loadPrefs } from '../lib/prefs';
import { isTranslationLanguage } from '../lib/ai/translate';
import { isRecordingSupported } from '../lib/audio/mime';
import type { MeetingAssist } from '../types';
import { errorKey } from '../i18n';
import { ErrorNotice } from '../components/ErrorNotice';
import { LevelMeter } from '../components/LevelMeter';
import { MicSelect, SourceSelect, TranslationSelect } from '../components/CaptureFields';
import { SegmentRow, validSegmentProofread, validSegmentTranslation } from '../components/SegmentRow';
import { LiveNotesPanel } from '../components/LiveNotesPanel';
import { SummaryPanel } from '../components/SummaryPanel';
import { ExportMenu } from '../components/ExportMenu';
import { useSpeechState } from '../hooks/useSpeech';
import { speak, stopSpeech } from '../lib/speech';
import { SpeechNotice } from '../components/SpeechNotice';
export function MeetingView({ id }: { id: string }) {
  const { t, locale } = useLocale();
  const { meeting, segments, loading, error: dbError, recording, live } = useMeeting(id);
  const queue = useQueueState();
  const assist = useAssistState();
  const speech = useSpeechState();
  const readingSegments = useRef<string[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [translationOnly, setTranslationOnly] = useState(false);
  const [capture, setCapture] = useState(() => { const prefs = loadPrefs(); return { source: prefs.defaultSource, micDeviceId: prefs.micDeviceId }; });
  const [following, setFollowing] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const reportError = useCallback((cause: unknown) => setError(cause), []);
  const normalizedQuery = query.trim();
  const targetLanguage = isTranslationLanguage(meeting?.assist?.translateTo) ? meeting.assist.translateTo : '';
  const visibleSegments = useMemo(() => {
    if (!normalizedQuery) return segments;
    const needle = normalizedQuery.toLocaleLowerCase();
    return segments.filter(segment => segment.text.toLocaleLowerCase().includes(needle) || validSegmentProofread(segment)?.text.toLocaleLowerCase().includes(needle) || validSegmentTranslation(segment, targetLanguage)?.text.toLocaleLowerCase().includes(needle));
  }, [segments, normalizedQuery, targetLanguage]);
  const corrections = useMemo(() => visibleSegments.filter(segment => validSegmentProofread(segment)).sort((a, b) => a.seq - b.seq), [visibleSegments]);
  const readingAll = speech.activeId === `all:${id}`;
  const speakingSegment = readingAll && speech.itemIndex !== null ? readingSegments.current[speech.itemIndex] : null;
  const speechHeadphones = live && recording.phase === 'recording' && (meeting?.source === 'mic' || meeting?.source === 'mic+tab');
  useEffect(() => { readingSegments.current = []; return stopSpeech; }, [id]);
  useEffect(() => {
    if (!speakingSegment || normalizedQuery) return;
    const row = Array.from(viewport.current?.querySelectorAll<HTMLElement>('[data-segment-id]') ?? []).find(node => node.dataset.segmentId === speakingSegment);
    row?.scrollIntoView({ block: 'nearest' });
  }, [speakingSegment, normalizedQuery]);
  useEffect(() => { setTitle(meeting?.title ?? ''); }, [meeting?.title]);
  useEffect(() => { if (live && following && !normalizedQuery && !speech.activeId && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [segments, live, following, normalizedQuery, speech.activeId]);
  let supported = false;
  try { supported = isRecordingSupported(); } catch { /* Safe during integration startup. */ }
  async function act(action: () => void | Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }
  async function saveTitle() {
    if (!meeting || !title.trim() || title.trim() === meeting.title) { setTitle(meeting?.title ?? ''); return; }
    const nextTitle = title.trim();
    try { await updateMeeting(id, current => ({ ...current, title: nextTitle, updatedAt: new Date().toISOString() })); }
    catch (cause) { setError(cause); }
  }
  function changeAssist(change: Partial<MeetingAssist>) {
    void updateMeeting(id, current => ({ ...current, assist: { ...current.assist, translateTo: isTranslationLanguage(current.assist?.translateTo) ? current.assist.translateTo : '', liveNotes: current.assist?.liveNotes === true, ...change }, updatedAt: new Date().toISOString() })).catch(setError);
  }
  if (loading) return <div class="page"><p role="status">{t('loading')}</p></div>;
  if (!meeting) return <div class="page"><a href="#/">{t('back')}</a><ErrorNotice error={dbError} /><div class="empty-state">{t('notFound')}</div></div>;
  const canContinue = !live && (meeting.status === 'stopped' || meeting.status === 'interrupted');
  return <div class="page meeting-page">
    <a href="#/" class="back-link"><ArrowLeft size={15} />{t('back')}</a>
    <div class="meeting-heading"><div class="meeting-heading-main"><input class="title-input" aria-label={t('title')} value={title} maxLength={300} onInput={event => setTitle(event.currentTarget.value)} onBlur={() => void saveTitle()} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /><div class="meeting-meta"><span class={`badge status-${meeting.status}`}>{t(meeting.status)}</span>{meeting.chunkProfile === 'fast' && <span class="badge">{t('chunkFastBadge')}</span>}<time dateTime={meeting.createdAt}>{new Date(meeting.createdAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}</time><span class="clock">{formatClock(live ? recording.elapsedMs : meeting.durationMs)}</span></div></div><ExportMenu meeting={meeting} segments={segments} onError={reportError} /></div>
    <ErrorNotice error={error || dbError} onDismiss={() => setError(null)} />
    <ErrorNotice error={recording.error} />
    {live && <section class="card live-controls"><div class="button-row"><strong class="clock">{formatClock(recording.elapsedMs)}</strong><LevelMeter level={recording.level} />{recording.phase === 'recording' || recording.phase === 'paused' ? <button disabled={busy} onClick={() => void act(recording.phase === 'paused' ? resumeRecording : pauseRecording)}>{recording.phase === 'paused' ? <Play size={16} /> : <Pause size={16} />}{t(recording.phase === 'paused' ? 'resume' : 'pause')}</button> : null}<button class="danger-button" disabled={busy || recording.phase === 'starting' || recording.phase === 'stopping'} onClick={() => void act(stopRecording)}><Square size={14} />{t('stop')}</button></div>{recording.tabEnded && <p class="notice">{t('tabEnded')}</p>}</section>}
    {canContinue && <details class="card continue-panel"><summary>{t('continue')}</summary><div class="form-grid"><SourceSelect value={capture.source} onChange={source => setCapture(previous => ({ ...previous, source }))} /><MicSelect value={capture.micDeviceId} onChange={micDeviceId => setCapture(previous => ({ ...previous, micDeviceId }))} /></div><button disabled={busy || !supported || recording.phase !== 'idle'} onClick={() => void act(() => continueMeeting(id, { ...capture, micDeviceId: capture.micDeviceId || undefined }))}><Play size={16} />{t('continue')}</button>{!supported && <p class="muted small">{t('recordingUnsupported')}</p>}</details>}
    <section class="queue-panel" aria-label={t('queue')}><strong>{t('queue')}</strong><div class="queue-counts"><span>{t('pendingCount', { count: queue.pending })}</span><span>{t('activeCount', { count: queue.active })}</span><span class={queue.failed ? 'danger-text' : ''}>{t('failedCount', { count: queue.failed })}</span></div>{queue.paused && <><span class="small muted">{t('queuePaused')}</span><button disabled={busy} onClick={() => void act(async () => { const current = getQueue(); current.resume(); await current.resumeAll(); })}>{t('resume')}</button></>}{queue.blockedBy && <p class="notice">{t(errorKey(queue.blockedBy))} <a href="#/settings">{t('configure')}</a></p>}{segments.some(segment => segment.status === 'failed' && !segment.edited) && <button disabled={busy} onClick={() => void act(async () => { const current = getQueue(); await current.retryFailed(id); current.resume(); })}>{t('retryFailed')}</button>}</section>
    <div class="meeting-columns"><section class="card transcript-panel"><div class="section-heading"><h2>{t('transcript')}</h2><span class="count">{segments.length}</span></div><div class="transcript-settings"><TranslationSelect value={targetLanguage} onChange={value => changeAssist({ translateTo: isTranslationLanguage(value) ? value : '' })} />{targetLanguage && <label class="field"><span>{t('translationDisplay')}</span><select value={translationOnly ? 'translated' : 'both'} onChange={event => setTranslationOnly(event.currentTarget.value === 'translated')}><option value="both">{t('originalAndTranslation')}</option><option value="translated">{t('translationOnly')}</option></select></label>}<label class="check-field"><input type="checkbox" checked={meeting.assist?.proofread === true} onChange={event => changeAssist({ proofread: event.currentTarget.checked })} />{t('proofreadEnable')}</label></div><label class="search-field"><Search size={17} /><input type="search" aria-label={t('search')} placeholder={t('search')} value={query} onInput={event => setQuery(event.currentTarget.value)} /></label>
      {(targetLanguage || meeting.assist?.proofread) && assist.blockedBy === 'llm-not-configured' && <p class="notice">{t('assistNeedsModel')} <a href="#/settings">{t('configure')}</a></p>}
      {(corrections.length > 0 || readingAll) && <div class="button-row speech-controls"><button aria-pressed={readingAll} aria-busy={readingAll && speech.loading} onClick={() => {
        if (readingAll) { stopSpeech(); return; }
        readingSegments.current = corrections.map(segment => segment.id);
        speak(`all:${id}`, corrections.map(segment => validSegmentProofread(segment)!.text), meeting.language);
      }}>{readingAll && speech.loading ? <LoaderCircle size={16} class="speech-spinner" /> : readingAll ? <Square size={16} /> : <Volume2 size={16} />}{t(readingAll ? 'stopReading' : 'readAllCorrections')}</button>{speechHeadphones && <span class="small muted">{t('ttsHeadphones')}</span>}</div>}
      <SpeechNotice speech={speech} />
      <div class="transcript-scroll" ref={viewport} tabIndex={0} aria-label={t('transcript')} onScroll={() => { const node = viewport.current; if (node) setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 80); }}>
        {!visibleSegments.length && <p class="empty-transcript">{t(normalizedQuery ? 'noMatches' : 'noSegments')}</p>}
        {visibleSegments.map(segment => {
          const speaking = speech.activeId === `seg:${segment.id}` || speakingSegment === segment.id;
          return <SegmentRow key={segment.id} segment={segment} query={normalizedQuery} t={t} onError={reportError} targetLanguage={targetLanguage} translationOnly={translationOnly} proofreadEnabled={meeting.assist?.proofread === true} language={meeting.language} speaking={speaking} speechLoading={speaking && speech.loading} speechHeadphones={speechHeadphones} />;
        })}
      </div>{live && !following && <button class="latest-button" onClick={() => { setQuery(''); setFollowing(true); if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }}><ArrowDown size={16} />{t('latest')}</button>}
    </section><div class="meeting-aside"><LiveNotesPanel meeting={meeting} onToggle={enabled => changeAssist({ liveNotes: enabled })} /><SummaryPanel meeting={meeting} segments={segments} /><section class="card audio-panel"><h3>{t('storage')}</h3><p class="muted small">{t('storageHint')}</p><button class="danger-text" disabled={busy || live || meeting.status === 'importing' || !segments.some(segment => segment.hasAudio)} onClick={() => { if (window.confirm(t('deleteAudioConfirm'))) void act(() => deleteMeetingAudio(id)); }}><Trash2 size={15} />{t('deleteAudio')}</button></section></div></div>
  </div>;
}
