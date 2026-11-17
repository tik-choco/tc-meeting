import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionForMime, isRecordingSupported, pickRecorderMimeType } from "./mime";

afterEach(() => vi.unstubAllGlobals());

describe("MIME support", () => {
  it.each([
    ["audio/webm;codecs=opus", "webm"], [" AUDIO/MP4 ; codecs=abc", "mp4"],
    ["audio/ogg;codecs=opus", "ogg"], ["application/ogg", "ogg"],
    ["audio/x-wav", "wav"], ["audio/wave", "wav"], ["audio/wav", "wav"],
    ["audio/mpeg", "mp3"], ["audio/mp3", "mp3"], ["audio/x-m4a", "m4a"],
    ["audio/m4a", "m4a"], ["unknown", "webm"], ["", "webm"],
  ])("maps %s to %s", (mime, extension) => expect(extensionForMime(mime)).toBe(extension));

  it("prefers supported formats in contract order", () => {
    const supported = vi.fn((mime: string) => mime === "audio/mp4" || mime.startsWith("audio/ogg"));
    vi.stubGlobal("MediaRecorder", { isTypeSupported: supported });
    expect(pickRecorderMimeType()).toBe("audio/mp4");
    expect(supported.mock.calls.map(([mime]) => mime)).toEqual([
      "audio/webm;codecs=opus", "audio/webm", "audio/mp4",
    ]);
  });

  it("uses the browser default when no explicit format is supported", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    expect(pickRecorderMimeType()).toBe("");
    vi.stubGlobal("MediaRecorder", undefined);
    expect(pickRecorderMimeType()).toBe("");
    expect(isRecordingSupported()).toBe(false);
  });

  it("requires capture, recording, and an audio context, including the prefixed fallback", () => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia() {} } });
    vi.stubGlobal("MediaRecorder", class {});
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", class {});
    expect(isRecordingSupported()).toBe(true);
    vi.stubGlobal("webkitAudioContext", undefined);
    expect(isRecordingSupported()).toBe(false);
  });
});
