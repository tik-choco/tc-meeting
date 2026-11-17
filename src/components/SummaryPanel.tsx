import { useEffect, useRef, useState } from 'preact/hooks';
import { Sparkles } from 'lucide-preact';
import type { Meeting, Segment } from '../types';
import { AppError } from '../types';
import { updateMeeting } from '../lib/db';
import { summarizeMeeting } from '../lib/ai/summary';
import { useLocale } from '../hooks/useLocale';
import { ErrorNotice } from './ErrorNotice';
import { SafeMarkdown } from './SafeMarkdown';
export function SummaryPanel({ meeting, segments }: { meeting: Meeting; segments: Segment[] }) {
  const { t, locale } = useLocale();
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState('');
  const [progress, setProgress] = useState<{ stage: 'map' | 'reduce'; done: number; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  const doneCount = segments.filter(segment => segment.status === 'done').length;
  useEffect(() => () => controller.current?.abort(), [meeting.id]);
  async function generate() {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(null); setStream(''); setProgress(null);
    try {
      const text = await summarizeMeeting({ title: meeting.title, segments, locale, signal: current.signal, onProgress: setProgress, onDelta: setStream });
      if (!current.signal.aborted) {
        await updateMeeting(meeting.id, latest => {
          // Check inside the write transaction, after any wait for IndexedDB.
          if (current.signal.aborted) throw new AppError('aborted');
          const createdAt = new Date().toISOString();
          return { ...latest, updatedAt: createdAt, summary: { text, createdAt, segmentCount: doneCount } };
        });
      }
    } catch (cause) { if (!current.signal.aborted) setError(cause); }
    finally { controller.current = null; setBusy(false); setStream(''); setProgress(null); }
  }
  return <section class="card summary-panel"><div class="section-heading"><h2><Sparkles size={19} />{t('summary')}</h2></div><p class="muted small">{t('summaryHint')}</p><ErrorNotice error={error} onDismiss={() => setError(null)} />
    {meeting.summary && meeting.summary.segmentCount !== doneCount && <p class="notice small">{t('stale')}</p>}
    {(busy ? stream : meeting.summary?.text) && <SafeMarkdown text={busy ? stream : meeting.summary?.text ?? ''} />}
    {busy && <p class="muted small" role="status">{progress ? t(progress.stage === 'map' ? 'mapProgress' : 'reduceProgress', { done: progress.done, total: progress.total }) : t('generating')}</p>}
    <div class="button-row">{busy ? <button onClick={() => controller.current?.abort()}>{t('cancel')}</button> : <button class="primary" disabled={!doneCount} onClick={() => void generate()}><Sparkles size={16} />{t(meeting.summary ? 'regenerate' : 'generate')}</button>}</div>
  </section>;
}
