import { encodeWavPcm16 } from "./wav";

export const STT_SAMPLE_RATE = 16000;

type DecodingContext = { decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> };
type ContextFactory = () => DecodingContext | undefined;

function defaultContext(): DecodingContext | undefined {
  const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  // An offline context decodes and resamples to its own rate without touching audio output.
  return Offline ? new Offline(1, 1, STT_SAMPLE_RATE) : undefined;
}

function isWav(mimeType: string): boolean {
  return /^audio\/(x-)?(wav|wave)\b/i.test(mimeType.trim());
}

/**
 * Live MediaRecorder chunks are streaming WebM/MP4/Ogg (no duration/cues), which some
 * transcription servers cannot decode ("empty audio"). Re-encode them as 16 kHz mono
 * PCM WAV, which every recognizer accepts and which is what they resample to anyway.
 * Best effort: when decoding is unavailable or fails, the original audio is sent unchanged.
 */
export async function prepareSttAudio(audio: Blob, mimeType: string, fileName: string,
  createContext: ContextFactory = defaultContext): Promise<{ audio: Blob; mimeType: string; fileName: string }> {
  const original = { audio, mimeType, fileName };
  if (isWav(mimeType || audio.type) || !audio.size) return original;
  try {
    const context = createContext();
    if (!context) return original;
    const decoded = await context.decodeAudioData(await audio.arrayBuffer());
    const channels = Math.max(1, decoded.numberOfChannels);
    const samples = new Float32Array(decoded.length);
    for (let channel = 0; channel < channels; channel++) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) samples[i] += data[i] / channels;
    }
    const base = fileName.replace(/\.[^./\\]*$/, "") || "segment";
    return { audio: encodeWavPcm16(samples, decoded.sampleRate), mimeType: "audio/wav", fileName: `${base}.wav` };
  } catch {
    return original;
  }
}
