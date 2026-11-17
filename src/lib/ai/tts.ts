import { isTtsSpeed, MAX_TTS_TEXT_CHARS } from '@tik-choco/mistai';
import { isNetworkProviderBaseUrl, networkVoiceModelParam, resolveVoice, roomIdFromBaseUrl, subscribeLlmConfig } from '@tik-choco/mistai/llm-config';
import { AppError } from '../../types';
import { rooms } from './network';
import { loadSharedConfig } from './settings';

export type TtsEngine = 'api' | 'network' | 'browser';

function engineFor(target: ReturnType<typeof resolveVoice>): TtsEngine {
  if (!target) return 'browser';
  if (!isNetworkProviderBaseUrl(target.baseUrl)) return 'api';
  return roomIdFromBaseUrl(target.baseUrl).trim() ? 'network' : 'browser';
}

export function getTtsEngine(): TtsEngine {
  return engineFor(resolveVoice(loadSharedConfig(), 'tts'));
}

export function subscribeTtsConfig(cb: () => void): () => void {
  return subscribeLlmConfig(() => cb());
}

const PREFIX_LANG: Record<string, string> = { a: 'en', b: 'en', j: 'ja', z: 'zh', e: 'es', f: 'fr', h: 'hi', i: 'it', p: 'pt' };
export function isLangMismatchedPrefixedVoice(voice: string | undefined, lang: string): boolean {
  const primary = lang.trim().split('-')[0].toLowerCase();
  const match = /^([a-z])[fm]_/i.exec(voice?.trim() ?? '');
  const voiceLang = match && PREFIX_LANG[match[1].toLowerCase()];
  return !!primary && !!voiceLang && primary !== voiceLang;
}

export function ttsCacheKey(text: string, lang: string): string {
  const target = resolveVoice(loadSharedConfig(), 'tts');
  // Structured fields avoid delimiter collisions. Credentials never enter the cache.
  return JSON.stringify([engineFor(target), target?.baseUrl ?? '', target?.model ?? '', target?.voice ?? '',
    isTtsSpeed(target?.speed) ? target.speed : null, lang, text]);
}

// Network requests cannot be canceled on the wire; cancellation only stops waiting.
function withAbort<T>(signal: AbortSignal | undefined, start: () => Promise<T>): Promise<T> {
  if (!signal) return start();
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(new AppError('aborted', undefined, { cause: signal.reason })); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    Promise.resolve().then(() => {
      if (signal.aborted) throw new AppError('aborted');
      return start();
    }).then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => {
      signal.removeEventListener('abort', onAbort); reject(error);
    });
  });
}

export async function synthesizeSpeech(text: string, lang: string, signal?: AbortSignal): Promise<Blob> {
  if (signal?.aborted) throw new AppError('aborted', undefined, { cause: signal.reason });
  const target = resolveVoice(loadSharedConfig(), 'tts');
  const engine = engineFor(target);
  if (!target || engine === 'browser') throw new AppError('tts-unsupported');
  const input = text.slice(0, MAX_TTS_TEXT_CHARS);
  const speed = isTtsSpeed(target.speed) ? { speed: target.speed } : {};
  try {
    const blob = await withAbort(signal, async () => {
      if (engine === 'network') {
        const voice = isLangMismatchedPrefixedVoice(target.voice, lang) ? undefined : target.voice;
        return rooms.requestRoomTts(roomIdFromBaseUrl(target.baseUrl).trim(), {
          text: input, model: networkVoiceModelParam(target.model),
          ...(voice ? { voice } : {}), ...(lang.trim() ? { lang: lang.trim() } : {}), ...speed,
        });
      }
      const apiKey = target.apiKey.trim();
      const response = await fetch(`${target.baseUrl.trim().replace(/\/+$/, '')}/audio/speech`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: target.model, input, response_format: 'mp3', ...(target.voice ? { voice: target.voice } : {}), ...speed }),
        signal,
      });
      // Do not copy remote bodies or fetch messages: they can contain credentials/URLs.
      if (!response.ok) throw new AppError('tts-failed', undefined, { cause: { status: response.status } });
      const audio = await response.blob();
      if (!audio.size) throw new AppError('tts-failed');
      return audio;
    });
    if (signal?.aborted) throw new AppError('aborted', undefined, { cause: signal.reason });
    return blob;
  } catch (cause) {
    if (signal?.aborted || (cause instanceof Error && cause.name === 'AbortError') || (cause instanceof AppError && cause.code === 'aborted')) {
      throw new AppError('aborted', undefined, { cause });
    }
    if (cause instanceof AppError && cause.code === 'tts-failed') throw cause;
    throw new AppError('tts-failed', undefined, { cause });
  }
}
