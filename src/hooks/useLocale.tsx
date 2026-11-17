import { createContext } from 'preact';
import type { ComponentChildren } from 'preact';
import { useContext, useEffect, useMemo, useState } from 'preact/hooks';
import { detectLocale, loadPrefs, savePrefs, subscribePrefs } from '../lib/prefs';
import type { Locale } from '../types';
import { translator } from '../i18n';
import type { Translate } from '../i18n';
const LocaleContext = createContext<{ locale: Locale; setLocale(locale: Locale): void; t: Translate }>({ locale: 'en', setLocale: () => {}, t: translator('en') });
export function LocaleProvider({ children }: { children: ComponentChildren }) {
  const [locale, setCurrent] = useState<Locale>(() => loadPrefs().locale ?? detectLocale());
  useEffect(() => subscribePrefs(prefs => setCurrent(prefs.locale ?? detectLocale())), []);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const value = useMemo(() => ({ locale, setLocale: (next: Locale) => { setCurrent(next); savePrefs({ locale: next }); }, t: translator(locale) }), [locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
export function useLocale() { return useContext(LocaleContext); }
