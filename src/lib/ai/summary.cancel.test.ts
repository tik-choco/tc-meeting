// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyLlmConfig, saveLlmConfig } from '@tik-choco/mistai/llm-config';
import { summarizeMeeting } from './summary';

vi.mock('./network', () => ({ rooms: { requestRoomChat: vi.fn() } }));

beforeEach(() => {
  localStorage.clear();
  const config = emptyLlmConfig();
  config.providers = [{ id: 'p', label: 'Fake API', baseUrl: 'https://no-network.invalid/v1', apiKey: 'fake' }];
  config.defaultModel = { providerId: 'p', model: 'fake-chat' };
  saveLlmConfig(config);
});
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('cancelling a direct-API summary must abort its HTTP request, releasing provider work', async () => {
  let finish!: (response: Response) => void;
  const deferred = new Promise<Response>(resolve => { finish = resolve; });
  const fakeFetch = vi.fn<typeof fetch>().mockReturnValue(deferred);
  vi.stubGlobal('fetch', fakeFetch);
  const controller = new AbortController();
  const summary = summarizeMeeting({ title: 'Review', locale: 'en', segments: [{ startMs: 0, text: 'Budget approved.', status: 'done' }], signal: controller.signal });
  const rejected = expect(summary).rejects.toMatchObject({ code: 'aborted' });
  try {
    await vi.waitFor(() => expect(fakeFetch).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(fakeFetch.mock.calls[0][1]?.signal?.aborted, 'Cancel must reach the underlying fetch, not only reject the wrapper').toBe(true);
  } finally {
    // Settle the fake HTTP request even when the regression assertion fails.
    finish(new Response(JSON.stringify({ choices: [{ message: { content: 'Late minutes' } }] }), { status: 200 }));
    await deferred;
    await Promise.resolve();
  }
});
