import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TTS_TEXT_CHARS } from '@tik-choco/mistai';
import { emptyLlmConfig, LLM_CONFIG_KEY, NETWORK_VOICE_AUTO_MODEL, networkProviderBaseUrl, saveLlmConfig } from '@tik-choco/mistai/llm-config';
import { rooms } from './network';
import { getTtsEngine, isLangMismatchedPrefixedVoice, subscribeTtsConfig, synthesizeSpeech, ttsCacheKey } from './tts';

vi.mock('./network', () => ({ rooms: { requestRoomTts: vi.fn() } }));
function configure(baseUrl = 'https://api.example.test/v1///', options: { model?: string; voice?: string; speed?: number; apiKey?: string } = {}) {
  const config = emptyLlmConfig();
  config.providers = [{ id: 'p', label: 'Example', baseUrl, apiKey: options.apiKey ?? '' }];
  config.tts = { providerId: 'p', model: 'speech-model', ...options };
  saveLlmConfig(config);
  return config;
}
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('TTS configuration', () => {
  it('resolves browser, unresolved, API, network and empty rooms', () => {
    expect(getTtsEngine()).toBe('browser');
    const config = emptyLlmConfig();
    config.tts = { providerId: 'missing', model: 'speech-model' };
    saveLlmConfig(config);
    expect(getTtsEngine()).toBe('browser');
    configure(); expect(getTtsEngine()).toBe('api');
    configure(networkProviderBaseUrl('room')); expect(getTtsEngine()).toBe('network');
    configure('mist-network://'); expect(getTtsEngine()).toBe('browser');
  });
  it('uses the shared resolver default-provider fallback', () => {
    const config = configure();
    config.defaultModel = { providerId: 'p', model: 'default-model' };
    config.tts = { model: 'speech-model' };
    saveLlmConfig(config);
    expect(getTtsEngine()).toBe('api');
  });
  it('subscribes to local and cross-tab config changes and unsubscribes', () => {
    const cb = vi.fn(); const off = subscribeTtsConfig(cb);
    configure(); window.dispatchEvent(new StorageEvent('storage', { key: LLM_CONFIG_KEY }));
    expect(cb).toHaveBeenCalledTimes(2);
    off(); configure(); expect(cb).toHaveBeenCalledTimes(2);
  });
  it('keys audio by voice settings/language/text without the API key or delimiter collisions', () => {
    configure(undefined, { apiKey: 'private-key', voice: 'voice-a', speed: 1.2 });
    const key = ttsCacheKey('hello', 'en');
    expect(key).not.toContain('private-key');
    configure(undefined, { apiKey: 'replacement', voice: 'voice-a', speed: 1.2 });
    expect(ttsCacheKey('hello', 'en')).toBe(key);
    for (const options of [{ voice: 'voice-b', speed: 1.2 }, { voice: 'voice-a', speed: 1.4 }, { model: 'other' }]) {
      configure(undefined, options); expect(ttsCacheKey('hello', 'en')).not.toBe(key);
    }
    configure(undefined, { voice: 'voice-a', speed: 1.2 });
    expect(ttsCacheKey('hello', 'ja')).not.toBe(key);
    expect(ttsCacheKey('changed', 'en')).not.toBe(key);
    expect(ttsCacheKey('b|c', 'a')).not.toBe(ttsCacheKey('c', 'a|b'));
    configure(networkProviderBaseUrl('room')); expect(ttsCacheKey('hello', 'en')).not.toBe(key);
  });
  it.each([['a', 'en'], ['b', 'en'], ['j', 'ja'], ['z', 'zh'], ['e', 'es'], ['f', 'fr'], ['h', 'hi'], ['i', 'it'], ['p', 'pt']])('recognizes language prefix %s', (prefix, lang) => {
    expect(isLangMismatchedPrefixedVoice(`${prefix}f_test`, lang)).toBe(false);
    expect(isLangMismatchedPrefixedVoice(`${prefix}m_test`, 'de')).toBe(true);
  });
  it('normalizes tags/case and keeps automatic, unknown and multilingual voices', () => {
    expect(isLangMismatchedPrefixedVoice(' ZM_test ', ' zh-TW ')).toBe(false);
    expect(isLangMismatchedPrefixedVoice('JF_test', 'en-US')).toBe(true);
    for (const voice of [undefined, '', 'generic-voice', 'qf_test']) expect(isLangMismatchedPrefixedVoice(voice, 'en')).toBe(false);
    expect(isLangMismatchedPrefixedVoice('jf_test', '')).toBe(false);
  });
});

describe('TTS requests', () => {
  it('posts JSON, configured voice/speed, authorization and signal; caps text', async () => {
    configure(undefined, { voice: 'voice-test', speed: 1.25, apiKey: ' secret ' });
    const fetchMock = vi.fn().mockResolvedValue(new Response('audio')); vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const blob = await synthesizeSpeech('x'.repeat(MAX_TTS_TEXT_CHARS + 20), 'ja', controller.signal);
    expect(blob.size).toBeGreaterThan(0);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/audio/speech');
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' }, signal: controller.signal });
    expect(JSON.parse(init.body)).toEqual({ model: 'speech-model', input: 'x'.repeat(MAX_TTS_TEXT_CHARS), voice: 'voice-test', speed: 1.25, response_format: 'mp3' });
  });
  it('omits unset voice, invalid speed and empty authorization', async () => {
    configure(undefined, { speed: 99 });
    const fetchMock = vi.fn().mockResolvedValue(new Response('audio')); vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeech('hello', '');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'speech-model', input: 'hello', response_format: 'mp3' });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
  });
  it('keeps configured API voice even when its language prefix differs', async () => {
    configure(undefined, { voice: 'jf_test' });
    const fetchMock = vi.fn().mockResolvedValue(new Response('audio')); vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeech('hello', 'en');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).voice).toBe('jf_test');
  });
  it('sends room params including lang/speed and suppresses mismatched global voices', async () => {
    configure(networkProviderBaseUrl('room-a'), { model: NETWORK_VOICE_AUTO_MODEL, voice: 'jf_test', speed: 1.5 });
    vi.mocked(rooms.requestRoomTts).mockResolvedValue(new Blob(['audio']));
    await synthesizeSpeech('hello', 'en');
    expect(rooms.requestRoomTts).toHaveBeenLastCalledWith('room-a', { text: 'hello', model: undefined, lang: 'en', speed: 1.5 });
    await synthesizeSpeech('hello', 'ja');
    expect(rooms.requestRoomTts).toHaveBeenLastCalledWith('room-a', { text: 'hello', model: undefined, voice: 'jf_test', lang: 'ja', speed: 1.5 });
    configure(networkProviderBaseUrl('room-b'), { model: 'other-model', voice: 'generic-voice' });
    await synthesizeSpeech('hello', '');
    expect(rooms.requestRoomTts).toHaveBeenLastCalledWith('room-b', { text: 'hello', model: 'other-model', voice: 'generic-voice' });
    configure(networkProviderBaseUrl('room-b'), { speed: -1 });
    await synthesizeSpeech('x'.repeat(4100), '');
    expect(rooms.requestRoomTts).toHaveBeenLastCalledWith('room-b', { text: 'x'.repeat(MAX_TTS_TEXT_CHARS), model: 'speech-model' });
  });
  it('rejects the browser transport without a request', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(synthesizeSpeech('hi', '')).rejects.toMatchObject({ code: 'tts-unsupported' });
    expect(fetchMock).not.toHaveBeenCalled(); expect(rooms.requestRoomTts).not.toHaveBeenCalled();
  });
  it('maps errors safely and retains causes without echoing remote secrets', async () => {
    configure();
    const cause = new Error('https://private.example/?key=secret');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(cause).mockResolvedValueOnce(new Response('secret', { status: 401 })).mockResolvedValueOnce(new Response('')));
    await expect(synthesizeSpeech('hi', '')).rejects.toMatchObject({ code: 'tts-failed', message: 'tts-failed', cause });
    await expect(synthesizeSpeech('hi', '')).rejects.toMatchObject({ code: 'tts-failed', message: 'tts-failed', cause: { status: 401 } });
    await expect(synthesizeSpeech('hi', '')).rejects.toMatchObject({ code: 'tts-failed' });
    configure(networkProviderBaseUrl('room'));
    vi.mocked(rooms.requestRoomTts).mockRejectedValue(cause);
    await expect(synthesizeSpeech('hi', '')).rejects.toMatchObject({ code: 'tts-failed', message: 'tts-failed', cause });
  });
  it.each(['api', 'network'])('aborts pending %s promptly and does not start pre-aborted requests', async engine => {
    configure(engine === 'api' ? undefined : networkProviderBaseUrl('room'));
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {})); vi.stubGlobal('fetch', fetchMock);
    vi.mocked(rooms.requestRoomTts).mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const result = synthesizeSpeech('hi', '', controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ code: 'aborted', message: 'aborted' });
    const request = engine === 'api' ? fetchMock : rooms.requestRoomTts;
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    controller.abort(new Error('private cancellation reason'));
    await assertion;
    await expect(synthesizeSpeech('hi', '', controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('maps upstream AbortError without a signal', async () => {
    configure(); const cause = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));
    await expect(synthesizeSpeech('hi', '')).rejects.toMatchObject({ code: 'aborted', cause });
  });
});
