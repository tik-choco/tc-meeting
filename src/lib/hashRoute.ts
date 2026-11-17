export type HashState = { page: 'home' } | { page: 'settings' } | { page: 'meeting'; id: string };
export function parseHash(hash: string): HashState {
  const body = hash.replace(/^#/, '');
  if (body === '/settings' || body === '/settings/') return { page: 'settings' };
  const match = /^\/m\/([^/]+)\/?$/.exec(body);
  if (match) {
    try {
      const id = decodeURIComponent(match[1]);
      if (id.trim() && !/[\x00-\x1f/]/.test(id)) return { page: 'meeting', id };
    } catch { /* Malformed links return home. */ }
  }
  return { page: 'home' };
}
export function readHash(): HashState { return parseHash(location.hash); }
export function routeHash(route: HashState): string {
  return route.page === 'meeting' ? `#/m/${encodeURIComponent(route.id)}` : route.page === 'settings' ? '#/settings' : '#/';
}
export function writeHash(route: HashState): void { location.hash = routeHash(route); }
export function onHashChange(cb: (route: HashState) => void): () => void {
  const listener = () => cb(readHash());
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}
