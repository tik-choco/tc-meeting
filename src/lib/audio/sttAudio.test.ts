import { describe, expect, it, vi } from "vitest";
import { prepareSttAudio } from "./sttAudio";

function fakeBuffer(channels: number[][], sampleRate = 16000): AudioBuffer {
  return { numberOfChannels: channels.length, length: channels[0].length, sampleRate,
    getChannelData: (i: number) => Float32Array.from(channels[i]) } as unknown as AudioBuffer;
}

describe("prepareSttAudio", () => {
  it("re-encodes compressed recorder chunks as 16-bit mono WAV, averaging channels", async () => {
    const decodeAudioData = vi.fn(async () => fakeBuffer([[0.5, -0.5, 0], [0.5, 0.5, 0]]));
    const result = await prepareSttAudio(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" }),
      "audio/webm;codecs=opus", "segment-000003.webm", () => ({ decodeAudioData }));
    expect(decodeAudioData).toHaveBeenCalledOnce();
    expect(result.mimeType).toBe("audio/wav");
    expect(result.fileName).toBe("segment-000003.wav");
    const view = new DataView(await result.audio.arrayBuffer());
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(6); // 3 samples
    expect(view.getInt16(44, true)).toBe(Math.round(0.5 * 32767));
    expect(view.getInt16(46, true)).toBe(0);
  });

  it("keeps WAV, empty audio, and undecodable audio unchanged", async () => {
    const wav = new Blob([new Uint8Array([1])], { type: "audio/wav" });
    const never = vi.fn(() => { throw new Error("should not decode"); });
    expect((await prepareSttAudio(wav, "audio/wav", "a.wav", never)).audio).toBe(wav);
    const empty = new Blob([], { type: "audio/webm" });
    expect((await prepareSttAudio(empty, "audio/webm", "a.webm", never)).audio).toBe(empty);
    const webm = new Blob([new Uint8Array([9])], { type: "audio/webm" });
    const failed = await prepareSttAudio(webm, "audio/webm", "a.webm", () => ({ decodeAudioData: async () => { throw new Error("bad"); } }));
    expect(failed).toEqual({ audio: webm, mimeType: "audio/webm", fileName: "a.webm" });
    expect((await prepareSttAudio(webm, "audio/webm", "a.webm", () => undefined)).audio).toBe(webm);
  });
});
