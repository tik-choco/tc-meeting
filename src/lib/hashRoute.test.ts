import { afterEach, describe, expect, it } from 'vitest';
import { onHashChange, parseHash, readHash, routeHash, writeHash } from './hashRoute';
afterEach(() => history.replaceState(null, '', '#/'));
describe('hash routes', () => {
  it('parses home, settings and encoded meeting ids', () => {
    expect(parseHash('#/')).toEqual({ page: 'home' });
    expect(parseHash('#/settings')).toEqual({ page: 'settings' });
    expect(parseHash('#/m/hello%20world')).toEqual({ page: 'meeting', id: 'hello world' });
    const route = { page: 'meeting', id: 'meeting?#1' } as const;
    expect(parseHash(routeHash(route))).toEqual(route);
  });
  it('returns home for unknown, malformed or ambiguous paths', () => {
    for (const hash of ['', '#', '#unknown', '#/other', '#/m/', '#/m/%ZZ', '#/m/a/b', '#/m/%2F', '#/m/%00', '#/settings/extra']) expect(parseHash(hash)).toEqual({ page: 'home' });
  });
  it('reads and writes routes and unsubscribes hash listeners', () => {
    writeHash({ page: 'settings' });
    expect(readHash()).toEqual({ page: 'settings' });
    let calls = 0;
    const off = onHashChange(() => calls++);
    window.dispatchEvent(new Event('hashchange'));
    expect(calls).toBe(1);
    off(); window.dispatchEvent(new Event('hashchange'));
    expect(calls).toBe(1);
  });
});
