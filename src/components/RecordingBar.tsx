import { Square, ArrowUpRight, AudioLines } from 'lucide-preact';
import type { RecordingState } from '../lib/session';
import { stopRecording } from '../lib/session';
import { formatClock } from '../lib/format';
import { routeHash } from '../lib/hashRoute';
import { useLocale } from '../hooks/useLocale';
import { LevelMeter } from './LevelMeter';
import { ErrorNotice } from './ErrorNotice';
export function RecordingBar({ state, onError }: { state: RecordingState; onError(error: unknown): void }) {
  const { t } = useLocale();
  if (state.phase === 'idle') return <ErrorNotice error={state.error} />;
  async function stop() { try { await stopRecording(); } catch (cause) { onError(cause); } }
  return <><ErrorNotice error={state.error} /><aside class="recording-bar" aria-label={t('recording')}><AudioLines size={18} /><span class={`live-dot ${state.phase === 'paused' ? 'paused' : ''}`} /><span>{t(state.phase === 'paused' ? 'paused' : 'recording')}</span><strong class="clock">{formatClock(state.elapsedMs)}</strong><LevelMeter level={state.level} />{state.meetingId && <a class="button" href={routeHash({ page: 'meeting', id: state.meetingId })} aria-label={t('liveMeeting')}><ArrowUpRight size={17} /><span>{t('open')}</span></a>}<button class="danger-button" disabled={state.phase === 'starting' || state.phase === 'stopping'} onClick={() => void stop()} aria-label={t('stop')}><Square size={14} /><span>{t('stop')}</span></button></aside></>;
}
