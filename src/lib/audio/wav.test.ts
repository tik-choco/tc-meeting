import { describe, expect, it } from "vitest";
import { encodeWavPcm16 } from "./wav";

describe("encodeWavPcm16", () => {
  it("writes a little-endian mono PCM header and clipped signed samples", async () => {
    const blob = encodeWavPcm16(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2, NaN]), 16000);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(60);
    const bytes = await blob.arrayBuffer();
    const view = new DataView(bytes);
    const tag = (start: number, length: number) => new TextDecoder().decode(bytes.slice(start, start + length));
    expect(tag(0, 4)).toBe("RIFF");
    expect(tag(8, 8)).toBe("WAVEfmt ");
    expect(tag(36, 4)).toBe("data");
    expect(view.getUint32(4, true)).toBe(52);
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(16);
    expect(Array.from({ length: 8 }, (_, i) => view.getInt16(44 + i * 2, true)))
      .toEqual([-32768, -32768, -16384, 0, 16384, 32767, 32767, 0]);
  });

  it("encodes empty PCM as a valid empty WAV", async () => {
    const blob = encodeWavPcm16(new Float32Array(), 48000);
    const view = new DataView(await blob.arrayBuffer());
    expect(blob.size).toBe(44);
    expect(view.getUint32(4, true)).toBe(36);
    expect(view.getUint32(40, true)).toBe(0);
  });
});
