import { useEffect, useState } from 'preact/hooks';
import { AudioLines, House, Moon, Settings, Sun } from 'lucide-preact';
import '@tik-choco/mistai/ui.css';
import { getQueue, initSession } from './lib/session';
import { getAssist } from './lib/assist';
import { onHashChange, readHash } from './lib/hashRoute';
import { LocaleProvider, useLocale } from './hooks/useLocale';
import { useTheme } from './hooks/useTheme';
import { useRecordingState } from './hooks/useRecordingState';
import { useImporter } from './hooks/useImporter';
import { useSttStatus } from './hooks/useSttStatus';
import { HomeView } from './views/HomeView';
import { MeetingView } from './views/MeetingView';
import { SettingsView } from './views/SettingsView';
import { RecordingBar } from './components/RecordingBar';
import { ErrorNotice } from './components/ErrorNotice';
import { ScreenBoundary } from './components/ScreenBoundary';
import { AiConnections } from './components/AiConnections';
import './styles/app.css';
let initialization: Promise<void> | undefined;
export function App() { return <LocaleProvider><AppShell /></LocaleProvider>; }
function AppShell() {
  const { t, locale } = useLocale();
  const { theme, setTheme, toggleTheme } = useTheme();
  const [route, setRoute] = useState(readHash);
  const [error, setError] = useState<unknown>(null);
  const recording = useRecordingState();
  const importer = useImporter();
  const stt = useSttStatus();
  useEffect(() => onHashChange(setRoute), []);
  useEffect(() => {
    let active = true;
    initialization ??= Promise.resolve().then(() => initSession());
    void initialization.then(() => { if (active) getAssist().setLocale(locale); }).catch(cause => { if (active) setError(cause); });
    return () => { active = false; };
  }, [locale]);
  useEffect(() => {
    if (!stt.configured) return;
    try { const queue = getQueue(); queue.resume(); void queue.resumeAll().catch(setError); }
    catch { /* A stub or unavailable queue can recover at session startup. */ }
  }, [stt.configured, stt.transport, stt.model]);
  useEffect(() => {
    if (recording.phase === 'idle' && !importer.progress) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [recording.phase, !!importer.progress]);
  return <div class="app-shell"><header class="app-header"><a class="app-header-brand" href="#/"><AudioLines size={22} />TC Meeting</a><nav class="app-tabs" aria-label={t('home')}><a class={`app-tab ${route.page === 'home' ? 'app-tab-active' : ''}`} href="#/" aria-label={t('home')} aria-current={route.page === 'home' ? 'page' : undefined}><House size={17} /><span>{t('home')}</span></a><a class={`app-tab ${route.page === 'settings' ? 'app-tab-active' : ''}`} href="#/settings" aria-label={t('settings')} aria-current={route.page === 'settings' ? 'page' : undefined}><Settings size={17} /><span>{t('settings')}</span></a></nav><button class="theme-toggle" onClick={toggleTheme} aria-label={t('theme')} title={t('theme')}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button></header>
    <RecordingBar state={recording} onError={setError} />
    {importer.progress && <aside class="import-bar" role="status"><span>{t('importing')}</span><progress value={Math.max(0, Math.min(1, importer.progress.ratio))} max={1} aria-label={t('importing')} /><span class="clock">{Math.round(importer.progress.ratio * 100)}%</span><button onClick={importer.cancel}>{t('cancel')}</button></aside>}
    <main class="app-main" key={route.page === 'meeting' ? route.id : route.page}><div class="global-notices"><ErrorNotice error={error} onDismiss={() => setError(null)} /><ErrorNotice error={importer.error} onDismiss={importer.clearError} /></div><ScreenBoundary>{route.page === 'home' ? <HomeView importer={importer} /> : route.page === 'meeting' ? <MeetingView key={route.id} id={route.id} /> : <SettingsView theme={theme} setTheme={setTheme} />}</ScreenBoundary></main>
    <ScreenBoundary><AiConnections settingsOpen={route.page === 'settings'} /></ScreenBoundary>
  </div>;
}
