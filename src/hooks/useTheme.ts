import { useEffect, useState } from 'preact/hooks';
export type Theme = 'light' | 'dark';
const KEY = 'tc-meeting:theme';
function loadTheme(): Theme { try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } }
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(KEY, theme); } catch { /* The theme still works without storage. */ }
  }, [theme]);
  useEffect(() => {
    const listener = (event: StorageEvent) => { if (event.key === KEY) setTheme(event.newValue === 'dark' ? 'dark' : 'light'); };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }, []);
  return { theme, setTheme, toggleTheme: () => setTheme(value => value === 'light' ? 'dark' : 'light') };
}
