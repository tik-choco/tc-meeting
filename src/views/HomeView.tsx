import { useRef, useState } from 'preact/hooks';
import { ArrowUpRight, AudioLines, FileAudio, Mic, Trash2 } from 'lucide-preact';
import { useLocale } from '../hooks/useLocale';
import { useMeetings } from '../hooks/useMeetings';
import { useRecordingState } from '../hooks/useRecordingState';
import { loadPrefs, savePrefs } from '../lib/prefs';
import { deleteMeeting } from '../lib/db';
import { startNewMeeting } from '../lib/session';
import { isRecordingSupported } from '../lib/audio/mime';
import { formatClock } from '../lib/format';
import { routeHash, writeHash } from '../lib/hashRoute';
import { RecordingFields } from '../components/HomeFields';
import { SttBanner } from '../components/SttBanner';
import { ErrorNotice } from '../components/ErrorNotice';
import type { useImporter } from '../hooks/useImporter';

export function HomeView({ importer }: { importer: ReturnType<typeof useImporter> }) {
  const { t, locale } = useLocale();
  const { items, loading, error: dbError } = useMeetings();
  const recording = useRecordingState();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  let supported = false;
  try { supported = isRecordingSupported(); } catch { /* The integration may still be initializing. */ }
  const active = recording.phase !== 'idle';
  function persistDefaults() {
    savePrefs({ defaultLanguage: prefs.defaultLanguage, defaultSource: prefs.defaultSource, micDeviceId: prefs.micDeviceId, keepAudio: prefs.keepAudio, translateTo: prefs.translateTo, liveNotes: prefs.liveNotes, proofread: prefs.proofread, chunkProfile: prefs.chunkProfile });
  }
  function defaultTitle() { return `${t('meeting')} ${new Date().toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}`; }
  async function start() {
    setBusy(true); setError(null);
    try {
      persistDefaults();
      const id = await startNewMeeting({ title: title.trim() || defaultTitle(), language: prefs.defaultLanguage, source: prefs.defaultSource, micDeviceId: prefs.micDeviceId || undefined, keepAudio: prefs.keepAudio, chunkProfile: prefs.chunkProfile, assist: { translateTo: prefs.translateTo, liveNotes: prefs.liveNotes, proofread: prefs.proofread } });
      writeHash({ page: 'meeting', id });
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!window.confirm(t('deleteConfirm'))) return;
    try { await deleteMeeting(id); } catch (cause) { setError(cause); }
  }
  return <div class="page home-page">
    <SttBanner />
    <div class="home-grid">
      <section class="card new-meeting"><div class="section-heading"><h2>{t('newMeeting')}</h2><Mic size={21} /></div>
        <form onSubmit={event => { event.preventDefault(); void start(); }}>
          <label class="field"><span>{t('title')}</span><input value={title} placeholder={defaultTitle()} maxLength={300} onInput={event => setTitle(event.currentTarget.value)} /></label>
          <RecordingFields prefs={prefs} onChange={setPrefs} />
          {!supported && <p class="muted">{t('recordingUnsupported')}</p>}
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
          <button class="primary start-button" type="submit" disabled={busy || active || !!importer.progress || !supported}><Mic size={20} />{busy ? t('loading') : t('start')}</button>
        </form>
      </section>
      <section class="card import-card"><div class="import-symbol"><FileAudio size={32} /></div><h2>{t('importAudio')}</h2><p class="muted">{t('importingHint')}</p>
        <input ref={fileRef} type="file" accept="audio/*,video/*" hidden aria-label={t('importAudio')} onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
          if (file) { persistDefaults(); void importer.start(file, { title: title.trim() || file.name.replace(/\.[^.]+$/, '') || defaultTitle(), language: prefs.defaultLanguage, keepAudio: prefs.keepAudio, assist: { translateTo: prefs.translateTo, liveNotes: prefs.liveNotes, proofread: prefs.proofread } }); }
        }} />
        <button disabled={!!importer.progress || busy || active} onClick={() => fileRef.current?.click()}><FileAudio size={18} />{t('importAudio')}</button>
      </section>
    </div>
    <section class="meeting-list"><div class="section-heading"><h2>{t('yourMeetings')}</h2><span class="count">{items.length}</span></div><ErrorNotice error={dbError} />
      {loading ? <p class="muted" role="status">{t('loading')}</p> : !items.length ? <div class="empty-state"><AudioLines size={30} /><h3>{t('emptyMeetings')}</h3><p>{t('emptyMeetingsHint')}</p></div> : items.map(({ meeting, done, total }) => <article class="meeting-card" key={meeting.id}>
        <a class="meeting-link" href={routeHash({ page: 'meeting', id: meeting.id })}><div class="meeting-icon"><AudioLines size={20} /></div><div class="meeting-info"><h3>{meeting.title}</h3><div class="meeting-meta"><time dateTime={meeting.createdAt}>{new Date(meeting.createdAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}</time><span>{formatClock(meeting.durationMs)}</span><span>{t('progress', { done, total })}</span></div></div><span class={`badge status-${meeting.status}`}>{t(meeting.status)}</span><ArrowUpRight size={18} aria-label={t('open')} /></a>
        <button class="icon-button danger-text" aria-label={`${t('delete')}: ${meeting.title}`} disabled={recording.meetingId === meeting.id || meeting.status === 'recording' || meeting.status === 'paused' || meeting.status === 'importing'} onClick={() => void remove(meeting.id)}><Trash2 size={17} /></button>
      </article>)}
    </section>
  </div>;
}
