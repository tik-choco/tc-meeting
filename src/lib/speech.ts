import { isTtsSpeed } from '@tik-choco/mistai';
import { resolveVoice } from '@tik-choco/mistai/llm-config';
import { AppError } from '../types';
import { getTtsEngine, synthesizeSpeech, ttsCacheKey } from './ai/tts';
import { loadSharedConfig } from './ai/settings';

export type SpeechState = { activeId: string | null; loading: boolean; itemIndex: number | null; fallback: boolean; error: unknown };
export type SpeechItem = { text: string; index: number };
export function speechItems(texts: string[]): SpeechItem[] {
  return texts.map((text, index) => ({ text, index })).filter(item => !!item.text.trim());
}

export function createSpeechCache(limit = 24) {
  const entries = new Map<string, Blob>();
  return {
    get(key: string): Blob | undefined {
      const blob = entries.get(key);
      if (blob) { entries.delete(key); entries.set(key, blob); }
      return blob;
    },
    set(key: string, blob: Blob): void {
      entries.delete(key); entries.set(key, blob);
      while (entries.size > Math.max(0, limit)) entries.delete(entries.keys().next().value!);
    },
  };
}

let state: SpeechState = { activeId: null, loading: false, itemIndex: null, fallback: false, error: null };
const listeners = new Set<(state: SpeechState) => void>();
const cache = createSpeechCache();
let generation = 0;
let controller: AbortController | null = null;
let releasePlayback: (() => void) | null = null;

function update(change: Partial<SpeechState>): void {
  state = { ...state, ...change };
  listeners.forEach(cb => cb(state));
}
export function getSpeechState(): SpeechState { return state; }
export function subscribeSpeech(cb: (state: SpeechState) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function clearSpeechError(): void { update({ fallback: false, error: null }); }
export function stopSpeech(): void {
  generation++;
  controller?.abort(); controller = null;
  releasePlayback?.(); releasePlayback = null;
  update({ activeId: null, loading: false, itemIndex: null });
}

function browserSupported(): boolean {
  return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
}

function browserSequence(items: SpeechItem[], lang: string, current: number, speed: number | undefined): void {
  if (current !== generation) return;
  if (!browserSupported()) throw new AppError('tts-failed');
  const synthesis = speechSynthesis;
  synthesis.cancel();
  function playAt(index: number): void {
    if (current !== generation) return;
    if (index === items.length) {
      releasePlayback = null;
      update({ activeId: null, loading: false, itemIndex: null });
      return;
    }
    const utterance = new SpeechSynthesisUtterance(items[index].text);
    if (lang) utterance.lang = lang;
    if (isTtsSpeed(speed)) utterance.rate = speed;
    let settled = false;
    utterance.onend = () => {
      if (settled) return;
      settled = true;
      try { playAt(index + 1); }
      catch (cause) {
        releasePlayback?.(); releasePlayback = null;
        update({ activeId: null, loading: false, itemIndex: null, error: new AppError('tts-failed', undefined, { cause }) });
      }
    };
    utterance.onerror = event => {
      if (settled || current !== generation) return;
      settled = true;
      releasePlayback = null;
      update({ activeId: null, loading: false, itemIndex: null,
        ...(event.error === 'canceled' || event.error === 'interrupted' ? {} : { error: new AppError('tts-failed') }) });
    };
    releasePlayback = () => { settled = true; utterance.onend = null; utterance.onerror = null; synthesis.cancel(); };
    update({ loading: false, itemIndex: items[index].index });
    synthesis.speak(utterance);
  }
  playAt(0);
}

async function playBlob(blob: Blob, current: number): Promise<void> {
  const url = URL.createObjectURL(blob);
  let audio: HTMLAudioElement;
  try { audio = new Audio(url); } catch (cause) { URL.revokeObjectURL(url); throw cause; }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (failed = false) => {
      if (settled) return;
      settled = true;
      audio.onended = null; audio.onerror = null;
      audio.pause(); audio.removeAttribute('src'); audio.load();
      URL.revokeObjectURL(url);
      if (current === generation) releasePlayback = null;
      if (failed) reject(new AppError('tts-failed')); else resolve();
    };
    releasePlayback = () => finish();
    audio.onended = () => finish();
    audio.onerror = () => finish(true);
    try { void audio.play().catch(() => finish(true)); } catch { finish(true); }
  });
}

async function sourceSequence(items: SpeechItem[], lang: string, current: number, signal: AbortSignal, speed: number | undefined): Promise<void> {
  type Result = { blob: Blob } | { error: unknown };
  async function fetchItem(text: string): Promise<Result> {
    try {
      const key = ttsCacheKey(text, lang);
      const cached = cache.get(key);
      if (cached) return { blob: cached };
      const blob = await synthesizeSpeech(text, lang, signal);
      if (current === generation) cache.set(key, blob);
      return { blob };
    } catch (error) { return { error }; }
  }
  let pending = fetchItem(items[0].text);
  for (let index = 0; index < items.length; index++) {
    const result = await pending;
    if (current !== generation) return;
    try {
      if ('error' in result) throw result.error;
      // Keep only one item ahead; rejected prefetches are always handled.
      const next = index + 1 < items.length ? fetchItem(items[index + 1].text) : null;
      update({ loading: false, itemIndex: items[index].index });
      await playBlob(result.blob, current);
      if (current !== generation) return;
      if (next) { pending = next; update({ loading: true, itemIndex: items[index + 1].index }); }
    } catch (cause) {
      if (current !== generation) return;
      controller?.abort();
      update({ loading: false });
      try {
        if (!browserSupported()) throw new AppError('tts-failed');
        update({ fallback: true });
        browserSequence(items.slice(index), lang, current, speed);
      }
      catch { update({ activeId: null, loading: false, itemIndex: null, error: new AppError('tts-failed', undefined, { cause }) }); }
      return;
    }
  }
  if (current === generation) { controller = null; update({ activeId: null, loading: false, itemIndex: null }); }
}

/** Recorded segment audio and read-aloud must never overlap. */
function pauseRecordedAudio(): void {
  if (typeof document === 'undefined') return;
  document.querySelectorAll<HTMLAudioElement>('audio.segment-audio').forEach(audio => audio.pause());
}

export function speak(id: string, texts: string[], lang: string): void {
  if (state.activeId === id) { stopSpeech(); return; }
  stopSpeech();
  clearSpeechError();
  pauseRecordedAudio();
  const items = speechItems(texts);
  if (!items.length) return;
  const current = generation;
  const config = loadSharedConfig();
  const speed = resolveVoice(config, 'tts')?.speed ?? config.tts?.speed;
  update({ activeId: id, loading: true, itemIndex: items[0].index });
  if (getTtsEngine() === 'browser') {
    try { browserSequence(items, lang, current, speed); }
    catch (cause) { update({ activeId: null, loading: false, itemIndex: null, error: new AppError('tts-failed', undefined, { cause }) }); }
  } else {
    controller = new AbortController();
    void sourceSequence(items, lang, current, controller.signal, speed);
  }
}
