import { memo } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { LoaderCircle, Pencil, Play, RotateCcw, Square, Volume2 } from 'lucide-preact';
import type { Segment, SegmentProofread, SegmentTranslation } from '../types';
import type { Translate } from '../i18n';
import { errorKey } from '../i18n';
import { formatClock } from '../lib/format';
import { getSegmentAudio, updateSegment } from '../lib/db';
import { getQueue } from '../lib/session';
import { getAssist } from '../lib/assist';
import { diffWords } from '../lib/textDiff';
import { getSpeechState, speak, stopSpeech } from '../lib/speech';

export function validSegmentTranslation(segment: Segment, targetLanguage: string): SegmentTranslation | undefined {
  const translation = segment.translation;
  if (segment.status !== 'done' || !targetLanguage || !translation || translation.lang !== targetLanguage || translation.source !== segment.text || translation.error || typeof translation.text !== 'string' || !translation.text.trim()) return undefined;
  return translation;
}

export function validSegmentProofread(segment: Segment): SegmentProofread | undefined {
  const proofread = segment.proofread;
  if (segment.status !== 'done' || !proofread || proofread.source !== segment.text || proofread.error || typeof proofread.text !== 'string' || !proofread.text.trim()) return undefined;
  return proofread;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const result = [];
  const lower = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  let offset = 0;
  let position = lower.indexOf(needle);
  while (position >= 0) {
    result.push(text.slice(offset, position), <mark key={position}>{text.slice(position, position + query.length)}</mark>);
    offset = position + query.length;
    position = lower.indexOf(needle, offset);
  }
  result.push(text.slice(offset));
  return <>{result}</>;
}
function CorrectionDiff({ before, after, query }: { before: string; after: string; query: string }) {
  const parts = useMemo(() => diffWords(before, after), [before, after]);
  return <>{parts.map((part, index) => {
    // Preserve the corrected spacing without drawing attention to whitespace-only edits.
    if (!part.text.trim() && part.kind !== 'same') return part.kind === 'added' ? part.text : null;
    if (part.kind === 'removed') return <del key={index}>{part.text}</del>;
    if (part.kind === 'added') return <ins key={index}><Highlight text={part.text} query={query} /></ins>;
    return <Highlight key={index} text={part.text} query={query} />;
  })}</>;
}
interface Props { segment: Segment; query: string; t: Translate; onError(error: unknown): void; targetLanguage?: string; translationOnly?: boolean; proofreadEnabled?: boolean; language?: string; speaking?: boolean; speechLoading?: boolean; speechHeadphones?: boolean }
export const SegmentRow = memo(function SegmentRow({ segment, query, t, onError, targetLanguage = '', translationOnly = false, proofreadEnabled = false, language = '', speaking = false, speechLoading = false, speechHeadphones = false }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(segment.text);
  const [busy, setBusy] = useState(false);
  const [retryingTranslation, setRetryingTranslation] = useState(false);
  const [retryingProofread, setRetryingProofread] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const translation = validSegmentTranslation(segment, targetLanguage);
  const proofread = validSegmentProofread(segment);
  const proofreadChanged = !!proofread && segment.text.replace(/\s+/gu, ' ').trim() !== proofread.text.replace(/\s+/gu, ' ').trim();
  const needsProofread = proofreadEnabled && segment.status === 'done' && !!segment.text.trim();
  const proofreadFailed = needsProofread && segment.proofread?.source === segment.text && !!segment.proofread.error;
  const showOriginal = !translationOnly || !targetLanguage;
  const needsTranslation = !!targetLanguage && segment.status === 'done' && !!segment.text.trim();
  const translationFailed = needsTranslation && segment.translation?.source === segment.text && segment.translation.lang === targetLanguage && !!segment.translation.error;
  useEffect(() => { if (!editing) setDraft(segment.text); }, [segment.text, editing]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (urlRef.current) URL.revokeObjectURL(urlRef.current); if (getSpeechState().activeId === `seg:${segment.id}`) stopSpeech(); }; }, [segment.id]);
  useEffect(() => {
    if (!segment.hasAudio && urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; setAudioUrl(null); }
  }, [segment.hasAudio]);
  async function save() {
    setBusy(true);
    try {
      const latest = await updateSegment(segment.id, current => ({ ...current, text: draft.trim(), edited: true }));
      if (!latest) { onError({ code: 'not-found' }); return; }
      if (mounted.current) setEditing(false);
    }
    catch (cause) { onError(cause); }
    finally { setBusy(false); }
  }
  async function play() {
    stopSpeech();
    try {
      const blob = await getSegmentAudio(segment.id);
      if (!mounted.current) return;
      if (!blob) { onError({ code: 'not-found' }); return; }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(blob); setAudioUrl(urlRef.current);
    } catch (cause) { onError(cause); }
  }
  async function retry() {
    try { const queue = getQueue(); await queue.retrySegment(segment.id); queue.resume(); }
    catch (cause) { onError(cause); }
  }
  async function retryTranslation() {
    setRetryingTranslation(true);
    try { await getAssist().retryTranslation(segment.id); }
    catch (cause) { onError(cause); }
    finally { if (mounted.current) setRetryingTranslation(false); }
  }
  async function retryProofread() {
    setRetryingProofread(true);
    try { await getAssist().retryProofread(segment.id); }
    catch (cause) { onError(cause); }
    finally { if (mounted.current) setRetryingProofread(false); }
  }
  return <article data-segment-id={segment.id} class={`segment segment-${segment.status}${speaking ? ' segment-speaking' : ''}`}>
    <div class="segment-meta"><time class="clock">[{formatClock(segment.startMs)}]</time>{segment.edited && <span class="edited-label">{t('edited')}</span>}<div class="segment-actions">{segment.hasAudio && <button class="icon-button" aria-label={t('play')} onClick={() => void play()}><Play size={15} /></button>}<button class="icon-button" aria-label={t('edit')} onClick={() => { setDraft(segment.text); setEditing(true); }}><Pencil size={15} /></button>{segment.hasAudio && !segment.edited && segment.status !== 'transcribing' && <button class="icon-button" aria-label={t('retry')} onClick={() => void retry()}><RotateCcw size={15} /></button>}</div></div>
    {editing ? <div class="segment-editor"><textarea aria-label={t('edit')} value={draft} onInput={event => setDraft(event.currentTarget.value)} rows={4} /><div class="button-row"><button class="primary" disabled={busy} onClick={() => void save()}>{t('save')}</button><button disabled={busy} onClick={() => setEditing(false)}>{t('cancel')}</button></div></div> : showOriginal && <button class="transcript-text" onClick={() => setEditing(true)} aria-label={`${t('edit')}: ${formatClock(segment.startMs)}`}>{segment.text ? <Highlight text={segment.text} query={query} /> : <span class="segment-placeholder">{t(segment.status)}</span>}</button>}
    {showOriginal && (proofread || needsProofread) && <div class="segment-correction" lang={language || undefined} dir="auto"><div class="correction-body"><span class="correction-reserve" aria-hidden="true">{segment.text}{'\n\u00a0'}</span><div class="correction-content" role="group" aria-label={t('correction')} tabIndex={proofreadChanged ? 0 : undefined}>{proofread ? proofreadChanged ? <CorrectionDiff before={segment.text} after={proofread.text} query={query} /> : <span class="segment-placeholder">{t('noCorrections')}</span> : proofreadFailed ? <span class="correction-error danger-text small">{t('proofreadFailed')} <button disabled={retryingProofread} onClick={() => void retryProofread()}>{t('proofreadRetry')}</button></span> : <span class="segment-placeholder" role="status">{t('proofreading')}</span>}</div></div>{proofread && <div class="correction-speech"><button class={`icon-button${speechLoading ? ' speech-loading' : ''}`} aria-label={t(speaking ? 'stopReading' : 'readCorrection')} title={speechLoading ? t('ttsLoading') : undefined} aria-pressed={speaking} aria-busy={speechLoading} onClick={() => speaking ? stopSpeech() : speak(`seg:${segment.id}`, [proofread.text], language)}>{speechLoading ? <LoaderCircle size={15} class="speech-spinner" /> : speaking ? <Square size={15} /> : <Volume2 size={15} />}</button>{speechHeadphones && <span class="small muted">{t('ttsHeadphones')}</span>}</div>}</div>}
    {translation && <p class="segment-translation" lang={translation.lang} dir="auto"><Highlight text={translation.text} query={query} /></p>}
    {needsTranslation && !translation && (translationFailed ? <p class="translation-error danger-text small">{t('translationFailed')} <button disabled={retryingTranslation} onClick={() => void retryTranslation()}>{t('translationRetry')}</button></p> : <p class="segment-placeholder translation-pending" role="status">{t('translating')}</p>)}
    {translationOnly && targetLanguage && !editing && !needsTranslation && !translation && <p class="segment-placeholder">{t(segment.status)}</p>}
    {segment.status === 'failed' && <p class="danger-text small">{t(errorKey(segment.error))}</p>}
    {audioUrl && <audio class="segment-audio" controls autoPlay src={audioUrl} aria-label={t('play')} onPlay={() => stopSpeech()} />}
  </article>;
}, (previous, next) => previous.query === next.query && previous.t === next.t && previous.onError === next.onError && previous.targetLanguage === next.targetLanguage && previous.translationOnly === next.translationOnly && previous.proofreadEnabled === next.proofreadEnabled && previous.language === next.language && previous.speaking === next.speaking && previous.speechLoading === next.speechLoading && previous.speechHeadphones === next.speechHeadphones &&
  previous.segment.id === next.segment.id && previous.segment.text === next.segment.text && previous.segment.status === next.segment.status && previous.segment.edited === next.segment.edited && previous.segment.hasAudio === next.segment.hasAudio && previous.segment.error === next.segment.error && previous.segment.attempts === next.segment.attempts && previous.segment.startMs === next.segment.startMs && previous.segment.endMs === next.segment.endMs &&
  previous.segment.translation?.lang === next.segment.translation?.lang && previous.segment.translation?.source === next.segment.translation?.source && previous.segment.translation?.text === next.segment.translation?.text && previous.segment.translation?.error === next.segment.translation?.error && previous.segment.translation?.at === next.segment.translation?.at &&
  previous.segment.proofread?.source === next.segment.proofread?.source && previous.segment.proofread?.text === next.segment.proofread?.text && previous.segment.proofread?.error === next.segment.proofread?.error && previous.segment.proofread?.at === next.segment.proofread?.at);
