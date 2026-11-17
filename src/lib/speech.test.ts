import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyLlmConfig, saveLlmConfig } from '@tik-choco/mistai/llm-config';

const tts = vi.hoisted(() => ({ engine: 'api', synthesize: vi.fn(), key: vi.fn((text: string, lang: string) => JSON.stringify([lang, text])) }));
vi.mock('./ai/tts', () => ({ getTtsEngine: () => tts.engine, synthesizeSpeech: tts.synthesize, ttsCacheKey: tts.key }));

class TestAudio {
  static instances: TestAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
  src: string;
  constructor(src: string) { this.src = src; TestAudio.instances.push(this); }
}
class TestUtterance {
  lang = ''; rate = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  text: string;
  constructor(text: string) { this.text = text; }
}
let speech: typeof import('./speech');
let utterances: TestUtterance[];
const synthesis = { speak: vi.fn(), cancel: vi.fn() };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear();
  tts.engine = 'api'; tts.synthesize.mockReset().mockResolvedValue(new Blob(['audio']));
  TestAudio.instances = []; utterances = [];
  synthesis.speak.mockImplementation((utterance: TestUtterance) => utterances.push(utterance));
  vi.stubGlobal('speechSynthesis', synthesis); vi.stubGlobal('SpeechSynthesisUtterance', TestUtterance); vi.stubGlobal('Audio', TestAudio);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:audio-${TestAudio.instances.length}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  speech = await import('./speech');
});
afterEach(() => { speech.stopSpeech(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('speech items and cache', () => {
  it('filters blank items while preserving original indices and text', () => {
    expect(speech.speechItems(['', ' first ', ' \n ', 'second'])).toEqual([{ text: ' first ', index: 1 }, { text: 'second', index: 3 }]);
  });
  it('evicts the least recently used blob, refreshes on get/set, and caps at 24', () => {
    const cache = speech.createSpeechCache(); const blob = new Blob(['audio']);
    for (let i = 0; i < 24; i++) cache.set(`${i}`, blob);
    expect(cache.get('0')).toBe(blob);
    cache.set('24', blob);
    expect(cache.get('1')).toBeUndefined(); expect(cache.get('0')).toBe(blob);
    cache.set('2', new Blob(['replacement'])); cache.set('25', blob);
    expect(cache.get('3')).toBeUndefined(); expect(cache.get('2')?.size).toBe(11);
    const empty = speech.createSpeechCache(0); empty.set('x', blob); expect(empty.get('x')).toBeUndefined();
  });
});

describe('singleton playback', () => {
  it('publishes state, toggles during loading, and leaves empty sequences idle', async () => {
    const cb = vi.fn(); const off = speech.subscribeSpeech(cb);
    tts.synthesize.mockReturnValue(new Promise(() => {}));
    speech.speak('one', ['', 'hello'], 'en');
    expect(speech.getSpeechState()).toMatchObject({ activeId: 'one', loading: true, itemIndex: 1 });
    const signal = tts.synthesize.mock.calls[0][2] as AbortSignal;
    speech.speak('one', ['hello'], 'en');
    expect(signal.aborted).toBe(true); expect(speech.getSpeechState()).toMatchObject({ activeId: null, loading: false });
    off(); const count = cb.mock.calls.length;
    speech.speak('empty', [' ', ''], 'en'); await flush();
    expect(speech.getSpeechState().activeId).toBeNull(); expect(cb).toHaveBeenCalledTimes(count);
  });
  it('prefetches one item, maps sequence indices, revokes URLs and replays from cache', async () => {
    speech.speak('all', ['', 'first', ' ', 'second'], 'en'); await flush();
    expect(tts.synthesize.mock.calls.map(call => call[0])).toEqual(['first', 'second']);
    expect(TestAudio.instances).toHaveLength(1);
    expect(speech.getSpeechState()).toMatchObject({ activeId: 'all', loading: false, itemIndex: 1 });
    TestAudio.instances[0].onended!(); await flush();
    expect(speech.getSpeechState()).toMatchObject({ itemIndex: 3 }); expect(TestAudio.instances).toHaveLength(2);
    TestAudio.instances[1].onended!(); await flush();
    expect(speech.getSpeechState().activeId).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    speech.speak('all', ['first', 'second'], 'en'); await flush();
    expect(tts.synthesize).toHaveBeenCalledTimes(2);
    speech.stopSpeech(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });
  it('stopping a pending fetch cannot resurrect audio, errors, or fallback', async () => {
    let finish!: (blob: Blob) => void;
    tts.synthesize.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    speech.speak('old', ['late'], 'en'); speech.stopSpeech();
    expect(tts.synthesize.mock.calls[0][2].aborted).toBe(true);
    finish(new Blob(['late'])); await flush();
    expect(TestAudio.instances).toHaveLength(0); expect(utterances).toHaveLength(0);
    expect(speech.getSpeechState()).toMatchObject({ activeId: null, fallback: false, error: null });
    speech.speak('replay', ['late'], 'en'); await flush();
    expect(tts.synthesize).toHaveBeenCalledTimes(2); // Stale responses are not cached.
  });
  it('another speak aborts old fetch and rejects late failures without changing new playback', async () => {
    let reject!: (error: Error) => void;
    tts.synthesize.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    speech.speak('old', ['old'], 'en'); speech.speak('new', ['new'], 'ja'); await flush();
    reject(new Error('late failure')); await flush();
    expect(tts.synthesize.mock.calls[0][2].aborted).toBe(true);
    expect(speech.getSpeechState()).toMatchObject({ activeId: 'new', fallback: false, error: null });
    expect(utterances).toHaveLength(0); expect(TestAudio.instances).toHaveLength(1);
  });
  it('stops playing audio, aborts prefetch and ignores late events', async () => {
    let finish!: (blob: Blob) => void;
    tts.synthesize.mockResolvedValueOnce(new Blob(['first'])).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    speech.speak('all', ['first', 'late'], 'en'); await flush();
    const ended = TestAudio.instances[0].onended!;
    speech.stopSpeech(); ended(); finish(new Blob(['late'])); await flush();
    expect(TestAudio.instances[0].pause).toHaveBeenCalled(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(TestAudio.instances).toHaveLength(1); expect(speech.getSpeechState().activeId).toBeNull();
  });
  it('falls back from a failed prefetch to only the remaining browser items', async () => {
    tts.synthesize.mockResolvedValueOnce(new Blob(['first'])).mockRejectedValueOnce(new Error('failed'));
    speech.speak('all', ['first', '', 'second', 'third'], 'en'); await flush();
    expect(utterances).toHaveLength(0);
    TestAudio.instances[0].onended!(); await flush();
    expect(speech.getSpeechState()).toMatchObject({ activeId: 'all', fallback: true, itemIndex: 2, loading: false });
    expect(utterances[0]).toMatchObject({ text: 'second', lang: 'en' });
    utterances[0].onend!(); expect(utterances[1].text).toBe('third');
    utterances[1].onend!(); expect(speech.getSpeechState()).toMatchObject({ activeId: null, fallback: true, error: null });
    speech.clearSpeechError(); expect(speech.getSpeechState().fallback).toBe(false);
  });
  it('falls back on audio playback failure and releases the failed audio', async () => {
    speech.speak('one', ['hello'], 'ja'); await flush();
    TestAudio.instances[0].onerror!(); await flush();
    expect(utterances[0]).toMatchObject({ text: 'hello', lang: 'ja' });
    expect(speech.getSpeechState().fallback).toBe(true); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
  it('reports a localized-code error when neither configured nor browser playback works', async () => {
    vi.stubGlobal('speechSynthesis', undefined); tts.synthesize.mockRejectedValue(new Error('secret'));
    speech.speak('one', ['hello'], ''); await flush();
    expect(speech.getSpeechState()).toMatchObject({ activeId: null, loading: false, error: { code: 'tts-failed', message: 'tts-failed' } });
    speech.clearSpeechError(); expect(speech.getSpeechState().error).toBeNull();
  });
  it('chains browser utterances with configured speed and auto language omitted', () => {
    tts.engine = 'browser';
    const config = emptyLlmConfig(); config.tts = { model: '', speed: 1.5 }; saveLlmConfig(config);
    speech.speak('browser', ['', 'one', 'two'], '');
    expect(utterances[0]).toMatchObject({ text: 'one', lang: '', rate: 1.5 });
    expect(speech.getSpeechState().itemIndex).toBe(1);
    utterances[0].onend!(); expect(speech.getSpeechState().itemIndex).toBe(2);
    utterances[1].onend!(); expect(speech.getSpeechState().activeId).toBeNull();
    expect(tts.synthesize).not.toHaveBeenCalled();
  });
  it.each(['canceled', 'interrupted'])('ignores browser %s errors and does not continue after stop', error => {
    tts.engine = 'browser'; speech.speak('browser', ['one', 'two'], 'en');
    const lateEnd = utterances[0].onend!;
    utterances[0].onerror!({ error });
    expect(speech.getSpeechState().error).toBeNull();
    speech.stopSpeech(); lateEnd();
    expect(utterances).toHaveLength(1); expect(speech.getSpeechState().activeId).toBeNull();
  });
  it('reports browser voice errors and unsupported browsers', () => {
    tts.engine = 'browser'; speech.speak('one', ['hello'], 'en');
    utterances[0].onerror!({ error: 'voice-unavailable' });
    expect(speech.getSpeechState()).toMatchObject({ activeId: null, error: { code: 'tts-failed' } });
    vi.stubGlobal('speechSynthesis', undefined); speech.speak('two', ['hello'], 'en');
    expect(speech.getSpeechState()).toMatchObject({ activeId: null, error: { code: 'tts-failed' } });
  });
});
