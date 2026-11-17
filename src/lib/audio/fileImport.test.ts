import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioChunk } from "../../types";
import { findCutPoints, MAX_IMPORT_BYTES, splitAudioFile } from "./fileImport";

afterEach(() => vi.unstubAllGlobals());

describe("findCutPoints", () => {
  const limits = { minMs: 20000, maxMs: 45000 };
  it("handles empty and short audio without extra cuts", () => {
    expect(findCutPoints(new Float32Array(), 1000, limits)).toEqual([0]);
    expect(findCutPoints(new Float32Array(1234), 1000, limits)).toEqual([0, 1234]);
  });
  it("chooses the quietest complete 100 ms window within the allowed range", () => {
    const samples = new Float32Array(90000).fill(0.3);
    samples.fill(0, 10000, 10100); // Too early.
    samples.fill(0, 25000, 25100);
    samples.fill(0.1, 35000, 35100); // Quieter than background, louder than the best.
    expect(findCutPoints(samples, 1000, limits)).toEqual([0, 25100, 70100, 90000]);
  });
  it("prefers the latest equal-energy window and merges tails shorter than 5 seconds", () => {
    expect(findCutPoints(new Float32Array(48000), 1000, limits)).toEqual([0, 48000]);
    expect(findCutPoints(new Float32Array(50000), 1000, limits)).toEqual([0, 45000, 50000]);
    expect(findCutPoints(new Float32Array(92000), 1000, limits)).toEqual([0, 45000, 92000]);
  });
  it("covers all samples contiguously with bounded nonfinal pieces", () => {
    const samples = Float32Array.from({ length: 157891 }, (_, i) => Math.sin(i / 30) * 0.3);
    const cuts = findCutPoints(samples, 1000, limits);
    expect(cuts[0]).toBe(0);
    expect(cuts.at(-1)).toBe(samples.length);
    for (let i = 1; i < cuts.length; i++) {
      const length = cuts[i] - cuts[i - 1];
      expect(length).toBeGreaterThan(0);
      expect(length).toBeLessThanOrEqual(50000);
      if (i < cuts.length - 1) {
        expect(length).toBeGreaterThanOrEqual(20000);
        expect(length).toBeLessThanOrEqual(45000);
      }
    }
  });
  it("validates invalid limits and handles an exact min=max cut", () => {
    expect(() => findCutPoints(new Float32Array(5), 0, limits)).toThrow(expect.objectContaining({ code: "decode-failed" }));
    expect(() => findCutPoints(new Float32Array(5), 1000, { minMs: 2, maxMs: 1 })).toThrow();
    expect(findCutPoints(new Float32Array(100000), 1000, { minMs: 45000, maxMs: 45000 }))
      .toEqual([0, 45000, 90000, 100000]);
  });
});

function mockDecode(channels: Float32Array[], fail = false) {
  const decode = vi.fn(async () => {
    if (fail) throw new Error("decoder");
    return {
      length: channels[0].length,
      numberOfChannels: channels.length,
      getChannelData: (channel: number) => channels[channel],
    };
  });
  const construct = vi.fn();
  class Context {
    constructor(channels: number, length: number, sampleRate: number) { construct(channels, length, sampleRate); }
    decodeAudioData = decode;
  }
  vi.stubGlobal("OfflineAudioContext", Context);
  return { decode, construct };
}

describe("splitAudioFile", () => {
  it("decodes offline at the target rate, averages channels, and reports ordered progress", async () => {
    const { construct } = mockDecode([new Float32Array(100000).fill(0.6), new Float32Array(100000).fill(-0.2)]);
    const chunks: AudioChunk[] = [];
    const progress: number[] = [];
    let busy = false;
    const result = await splitAudioFile(new Blob(["input"]), {
      sampleRate: 1000, onProgress: value => progress.push(value),
      async onChunk(chunk) {
        expect(busy).toBe(false);
        busy = true;
        await Promise.resolve();
        chunks.push(chunk);
        busy = false;
      },
    });
    expect(construct).toHaveBeenCalledWith(1, 1, 1000);
    expect(result).toEqual({ durationMs: 100000 });
    expect(chunks.map(c => [c.startMs, c.endMs])).toEqual([[0, 45000], [45000, 90000], [90000, 100000]]);
    expect(chunks.every(c => c.mimeType === "audio/wav" && c.speechMs === c.endMs - c.startMs)).toBe(true);
    const bytes = new DataView(await chunks[0].blob.arrayBuffer());
    expect(bytes.getInt16(44, true)).toBeCloseTo(6553, -1);
    expect(progress).toEqual([0, 0.45, 0.9, 1]);
  });
  it("uses 16 kHz by default and estimates silent chunks", async () => {
    const { construct } = mockDecode([new Float32Array(16000)]);
    const onChunk = vi.fn(async () => {});
    await splitAudioFile(new Blob(["input"]), { onChunk });
    expect(construct).toHaveBeenCalledWith(1, 1, 16000);
    expect(onChunk).toHaveBeenCalledWith(expect.objectContaining({ endMs: 1000, speechMs: 0 }));
  });
  it("aborts before decoding and between chunks", async () => {
    const { decode } = mockDecode([new Float32Array(100000)]);
    const controller = new AbortController();
    controller.abort();
    await expect(splitAudioFile(new Blob(), { signal: controller.signal, onChunk: async () => {} }))
      .rejects.toMatchObject({ code: "aborted" });
    expect(decode).not.toHaveBeenCalled();
    const second = new AbortController();
    const onChunk = vi.fn(async () => { second.abort(); });
    await expect(splitAudioFile(new Blob(), { sampleRate: 1000, signal: second.signal, onChunk }))
      .rejects.toMatchObject({ code: "aborted" });
    expect(onChunk).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized input and wraps decoder failures without wrapping consumer errors", async () => {
    await expect(splitAudioFile({ size: MAX_IMPORT_BYTES + 1 } as Blob, { onChunk: async () => {} }))
      .rejects.toMatchObject({ code: "file-too-large" });
    mockDecode([new Float32Array(10)], true);
    await expect(splitAudioFile(new Blob(), { onChunk: async () => {} })).rejects.toMatchObject({ code: "decode-failed" });
    mockDecode([new Float32Array(10)]);
    const failure = new Error("consumer");
    await expect(splitAudioFile(new Blob(), { onChunk: async () => { throw failure; } })).rejects.toBe(failure);
  });
});

it("rejects decoded float data over the cap before reading channels or allocating mono PCM", async () => {
  const getChannelData = vi.fn(() => { throw new Error("must not allocate/read"); });
  class Context {
    async decodeAudioData() { return { length: 210000000, numberOfChannels: 2, getChannelData }; }
  }
  vi.stubGlobal("OfflineAudioContext", Context);
  const onChunk = vi.fn(async () => {});
  await expect(splitAudioFile(new Blob(["compressed"]), { onChunk })).rejects.toMatchObject({ code: "file-too-large" });
  expect(getChannelData).not.toHaveBeenCalled(); expect(onChunk).not.toHaveBeenCalled();
});

it("downmixes only a bounded first window before awaiting its persistence", async () => {
  let reads = 0;
  let saved = 0;
  const samples = new Proxy({} as Float32Array, {
    get(_target, key) { if (typeof key === "string" && /^\d+$/.test(key)) { reads++; return 0.1; } return undefined; },
  });
  class Context {
    async decodeAudioData() { return { length: 150000, numberOfChannels: 2, getChannelData: () => samples }; }
  }
  vi.stubGlobal("OfflineAudioContext", Context);
  await splitAudioFile(new Blob(["compressed"]), { sampleRate: 1000, onChunk: async () => {
    if (++saved === 1) expect(reads).toBeLessThanOrEqual(100002); // <= 50 s, two channels.
  } });
  expect(saved).toBe(4);
});
