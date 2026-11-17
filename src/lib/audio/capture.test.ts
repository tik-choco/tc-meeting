import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listMicDevices, startCapture } from "./capture";

class Track extends EventTarget {
  readyState = "live";
  stop = vi.fn(() => { this.readyState = "ended"; });
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}
function stream(audio: Track[], video: Track[] = []) {
  return {
    getTracks: () => [...audio, ...video], getAudioTracks: () => audio, getVideoTracks: () => video,
  } as unknown as MediaStream;
}
class Node {
  connect = vi.fn();
  disconnect = vi.fn();
  gain = { value: 1 };
  fftSize = 0;
  stream = stream([new Track()]);
}
class Context {
  static instances: Context[] = [];
  state = "suspended";
  onstatechange: (() => void) | null = null;
  destination = new Node();
  analyser = new Node();
  destinationNode = new Node();
  sources: Node[] = [];
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  constructor() { Context.instances.push(this); }
  createAnalyser() { return this.analyser; }
  createGain() { return new Node(); }
  createMediaStreamDestination() { return this.destinationNode; }
  createMediaStreamSource() { const source = new Node(); this.sources.push(source); return source; }
}

describe("capture", () => {
  let mic: Track;
  let tab: Track;
  let video: Track;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let getDisplayMedia: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mic = new Track();
    tab = new Track();
    video = new Track();
    Context.instances = [];
    getUserMedia = vi.fn(async () => stream([mic]));
    getDisplayMedia = vi.fn(async () => stream([tab], [video]));
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, getDisplayMedia } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requests processed mic input, resumes the context, and closes all resources once", async () => {
    const handle = await startCapture({ source: "mic", micDeviceId: "device" });
    const context = Context.instances[0];
    expect(getUserMedia).toHaveBeenCalledWith({ audio: {
      deviceId: { exact: "device" }, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    } });
    expect(context.resume).toHaveBeenCalled();
    expect(handle.analyser.fftSize).toBe(2048);
    expect(handle.stream).toBe(context.destinationNode.stream);
    expect(context.analyser.connect).toHaveBeenCalledWith(context.destinationNode);
    handle.stop();
    handle.stop();
    expect(mic.stop).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(handle.stream.getAudioTracks()[0].readyState).toBe("ended");
  });
  it("stops video immediately, mixes both sources, and preserves mic after tab end", async () => {
    const handle = await startCapture({ source: "mic+tab" });
    const context = Context.instances[0];
    expect(getDisplayMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(video.stop).toHaveBeenCalledTimes(1);
    expect(context.sources).toHaveLength(2);
    const onEnded = vi.fn();
    handle.onEnded(onEnded);
    tab.end();
    tab.end();
    expect(onEnded).toHaveBeenCalledExactlyOnceWith("tab");
    expect(context.sources[1].disconnect).toHaveBeenCalledTimes(1);
    expect(mic.stop).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
    mic.end();
    expect(onEnded).toHaveBeenLastCalledWith("mic");
    handle.stop();
    tab.end();
    expect(onEnded).toHaveBeenCalledTimes(2);
  });
  it("cleans up when the shared stream has no audio", async () => {
    getDisplayMedia.mockResolvedValue(stream([], [video]));
    await expect(startCapture({ source: "mic+tab" })).rejects.toMatchObject({ code: "tab-audio-missing" });
    expect(video.stop).toHaveBeenCalled();
    expect(Context.instances[0].close).toHaveBeenCalledTimes(1);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it.each([
    ["NotAllowedError", "mic-denied"], ["NotFoundError", "mic-unavailable"],
    ["OverconstrainedError", "mic-unavailable"], ["NotReadableError", "mic-unavailable"], ["Other", "unknown"],
  ])("maps %s and closes partially acquired resources", async (name, code) => {
    getUserMedia.mockRejectedValue(new DOMException("", name));
    await expect(startCapture({ source: "mic+tab" })).rejects.toMatchObject({ code });
    expect(tab.stop).toHaveBeenCalled();
    expect(Context.instances[0].close).toHaveBeenCalled();
  });
  it("retries a suspended context and stops retrying after cleanup", async () => {
    const handle = await startCapture({ source: "mic" });
    const context = Context.instances[0];
    context.state = "suspended";
    context.onstatechange?.();
    expect(context.resume).toHaveBeenCalledTimes(2);
    handle.stop();
    expect(context.onstatechange).toBeNull();
  });
  it("waits for initial context resumption before returning capture", async () => {
    let resolve!: () => void;
    const resumed = new Promise<void>(r => { resolve = r; });
    class SuspendedContext extends Context {
      override resume = vi.fn(async () => { await resumed; this.state = "running"; });
    }
    vi.stubGlobal("AudioContext", SuspendedContext);
    let ready = false;
    const pending = startCapture({ source: "mic" }).then(handle => { ready = true; return handle; });
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toBe(false);
    resolve();
    const handle = await pending;
    expect(ready).toBe(true);
    handle.stop();
  });
  it("lists only microphone devices and tolerates absent enumeration", async () => {
    expect(await listMicDevices()).toEqual([]);
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: async () => [
      { kind: "audioinput", deviceId: "mic", label: "" },
      { kind: "videoinput", deviceId: "camera", label: "camera" },
    ] } });
    expect(await listMicDevices()).toEqual([{ deviceId: "mic", label: "" }]);
  });
});
