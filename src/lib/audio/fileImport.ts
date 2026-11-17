import { AppError } from "../../types";
import type { AudioChunk } from "../../types";
import { initialVadState, rms, stepVad } from "./segmenter";
import { encodeWavPcm16 } from "./wav";
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
// Decoding itself is browser-owned and cannot be cancelled or bounded before it completes.
export const MAX_DECODED_BYTES = 1.5 * 1024 * 1024 * 1024;
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AppError("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
export async function splitAudioFile(file: Blob, opts: {
  minMs?: number;
  maxMs?: number;
  sampleRate?: number;
  signal?: AbortSignal;
  onProgress?(ratio: number): void;
  onChunk(chunk: AudioChunk): Promise<void>;
}): Promise<{ durationMs: number }> {
  const checkAbort = () => { if (opts.signal?.aborted) throw new AppError("aborted"); };
  checkAbort();
  if (file.size > MAX_IMPORT_BYTES) throw new AppError("file-too-large");
  const sampleRate = opts.sampleRate ?? 16000;
  const limits = { minMs: opts.minMs ?? 20000, maxMs: opts.maxMs ?? 45000 };
  findCutPoints(new Float32Array(), sampleRate, limits); // Validate before decoding/allocating.
  opts.onProgress?.(0);
  let decoded: AudioBuffer | undefined;
  try {
    const Context = globalThis.OfflineAudioContext
      ?? (globalThis as typeof globalThis & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!Context) throw new AppError("decode-failed");
    const context = new Context(1, 1, sampleRate);
    let encoded: ArrayBuffer | undefined = await abortable(file.arrayBuffer(), opts.signal);
    checkAbort();
    const decoding = context.decodeAudioData(encoded);
    encoded = undefined;
    decoded = await abortable(decoding, opts.signal);
    checkAbort();
    if (decoded.length * decoded.numberOfChannels * Float32Array.BYTES_PER_ELEMENT > MAX_DECODED_BYTES) {
      decoded = undefined;
      throw new AppError("file-too-large");
    }
  } catch (cause) {
    decoded = undefined;
    checkAbort();
    if (cause instanceof AppError) throw cause;
    throw new AppError("decode-failed", undefined, { cause });
  }
  // Only one bounded mono window exists alongside the decoded channels. Persist
  // each chunk before downmixing the next; never allocate a whole-file mono copy.
  const length = decoded.length;
  const durationMs = length / sampleRate * 1000;
  const windowSize = Math.floor(limits.maxMs * sampleRate / 1000) + 5 * sampleRate + 1;
  const frameSize = Math.max(1, Math.round(sampleRate / 10));
  let vad = initialVadState();
  try {
    for (let start = 0; start < length;) {
      checkAbort();
      let mono: Float32Array | undefined = new Float32Array(Math.min(windowSize, length - start));
      for (let channel = 0; channel < decoded!.numberOfChannels; channel++) {
        const data = decoded!.getChannelData(channel);
        for (let i = 0; i < mono.length; i++) mono[i] += data[start + i] / decoded!.numberOfChannels;
      }
      const count = findCutPoints(mono, sampleRate, limits)[1];
      const end = start + count;
      vad = { ...vad, silentMs: 0, speechMs: 0 };
      for (let frame = 0; frame < count; frame += frameSize) {
        const window = mono.subarray(frame, Math.min(count, frame + frameSize));
        vad = stepVad(vad, rms(window), window.length / sampleRate * 1000);
      }
      const blob = encodeWavPcm16(mono.subarray(0, count), sampleRate);
      mono = undefined;
      if (end === length) decoded = undefined;
      await opts.onChunk({ startMs: start / sampleRate * 1000, endMs: end / sampleRate * 1000,
        blob, mimeType: "audio/wav", speechMs: vad.speechMs });
      checkAbort();
      opts.onProgress?.(end / length);
      start = end;
      if (start < length) await abortable(new Promise<void>(resolve => setTimeout(resolve, 0)), opts.signal);
    }
    checkAbort();
    if (!length) opts.onProgress?.(1);
    return { durationMs };
  } finally { decoded = undefined; }
}

/**
 * Includes the initial zero and final sample count. Search with a sliding sum
 * rather than a full-length energy array: multi-hour PCM is already large.
 * Cut at the end of the quietest complete 100 ms window; ties prefer later cuts.
 */
export function findCutPoints(samples: Float32Array, sampleRate: number, o: { minMs: number; maxMs: number }): number[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(o.minMs)
    || !Number.isFinite(o.maxMs) || o.minMs <= 0 || o.maxMs < o.minMs) throw new AppError("decode-failed");
  const min = Math.max(1, Math.ceil(o.minMs * sampleRate / 1000));
  const max = Math.max(min, Math.floor(o.maxMs * sampleRate / 1000));
  const windowSize = Math.max(1, Math.min(Math.round(sampleRate / 10), max - min));
  const cuts = [0];
  let previous = 0;
  while (samples.length - previous > max) {
    const lower = previous + min;
    const upper = previous + max;
    const firstEnd = Math.min(upper, lower + windowSize);
    const width = Math.max(1, firstEnd - lower);
    let energy = 0;
    for (let i = firstEnd - width; i < firstEnd; i++) energy += samples[i] * samples[i];
    let best = firstEnd;
    let bestEnergy = energy;
    for (let end = firstEnd + 1; end <= upper; end++) {
      energy += samples[end - 1] * samples[end - 1] - samples[end - width - 1] * samples[end - width - 1];
      if (energy <= bestEnergy + 1e-12) { bestEnergy = energy; best = end; }
    }
    cuts.push(best);
    previous = best;
  }
  if (samples.length > previous) {
    const tail = samples.length - previous;
    if (cuts.length > 1 && tail < 5 * sampleRate
      && samples.length - cuts[cuts.length - 2] <= max + 5 * sampleRate) cuts.pop();
    cuts.push(samples.length);
  }
  return cuts;
}
