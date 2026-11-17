import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioChunk } from "../../types";
import { createSegmenter, initialVadState, rms, shouldCut, stepVad } from "./segmenter";
import type { Segmenter, SegmenterOptions } from "./segmenter";

describe("VAD helpers", () => {
  it("calculates RMS for empty, signed, and constant samples", () => {
    expect(rms(new Float32Array())).toBe(0);
    expect(rms(new Float32Array([-1, 1, -1, 1]))).toBe(1);
    expect(rms(new Float32Array([0, 1]))).toBeCloseTo(Math.SQRT1_2);
  });
  it("uses the absolute speech threshold and accumulates actual frame durations", () => {
    const first = stepVad(initialVadState(), 0.005, 73);
    expect(first.speaking).toBe(false);
    expect(first.silentMs).toBe(73);
    const second = stepVad(first, 0.1, 127);
    expect(second.speaking).toBe(true);
    expect(second.silentMs).toBe(0);
    expect(second.speechMs).toBe(127);
    expect(second.noiseFloor).toBe(first.noiseFloor);
    expect(stepVad({ noiseFloor: 0.1, silentMs: 0, speechMs: 0 }, 0.2, 100).speaking).toBe(false);
  });
  it("adapts down faster than up and never learns sustained speech as noise", () => {
    const start = { noiseFloor: 0.004, silentMs: 0, speechMs: 0 };
    const rise = stepVad(start, 0.008, 100).noiseFloor - start.noiseFloor;
    const fall = start.noiseFloor - stepVad(start, 0, 100).noiseFloor;
    expect(fall).toBeGreaterThan(rise * 10);
    let vad = initialVadState();
    for (let i = 0; i < 1000; i++) vad = stepVad(vad, 0.2, 100);
    expect(vad.noiseFloor).toBe(initialVadState().noiseFloor);
    expect(vad.speechMs).toBe(100000);
  });
  it("does not infer a long silence across a missing frame gap", () => {
    const next = stepVad({ noiseFloor: 0.003, silentMs: 600, speechMs: 200 }, 0, 30000);
    expect(next.silentMs).toBe(100);
    expect(next.speechMs).toBe(200);
  });
  it("cuts after minimum plus silence, or at maximum irrespective of silence", () => {
    const limits = { minMs: 20000, maxMs: 45000, silenceMs: 700 };
    expect(shouldCut({ segmentMs: 19999, silentMs: 900 }, limits)).toBe(false);
    expect(shouldCut({ segmentMs: 20000, silentMs: 699 }, limits)).toBe(false);
    expect(shouldCut({ segmentMs: 20000, silentMs: 700 }, limits)).toBe(true);
    expect(shouldCut({ segmentMs: 60000, silentMs: 0 }, limits)).toBe(true);
  });
});

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static events: string[] = [];
  static delays: number[] = [];
  static failStart = false;
  timeslice?: number;
  static isTypeSupported() { return true; }
  readonly id = FakeRecorder.instances.length;
  mimeType = "audio/test";
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error: DOMException }) => void) | null = null;
  constructor() { FakeRecorder.instances.push(this); }
  start(timeslice?: number) {
    this.timeslice = timeslice;
    if (FakeRecorder.failStart) throw new DOMException("", "NotSupportedError");
    this.state = "recording";
    FakeRecorder.events.push("start:" + this.id);
  }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    FakeRecorder.events.push("stop:" + this.id);
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(["header:" + this.id]) });
      this.onstop?.();
    }, FakeRecorder.delays[this.id] ?? 0);
  }
}
class FakeAnalyser {
  fftSize = 2048;
  level = 0.1;
  getFloatTimeDomainData(samples: Float32Array) { samples.fill(this.level); }
}

describe("live segmenter", () => {
  let analyser: FakeAnalyser;
  let chunks: AudioChunk[];
  let live: Segmenter;
  function create(options: Partial<SegmenterOptions> = {}) {
    live = createSegmenter({ stream: {} as MediaStream, analyser: analyser as unknown as AnalyserNode }, {
      minMs: 500, maxMs: 1000, silenceMs: 300, onChunk: chunk => chunks.push(chunk), ...options,
    });
    return live;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    FakeRecorder.instances = [];
    FakeRecorder.events = [];
    FakeRecorder.delays = [];
    FakeRecorder.failStart = false;
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    analyser = new FakeAnalyser();
    chunks = [];
  });
  afterEach(async () => {
    if (live) {
      const stopping = live.stop();
      await vi.runAllTimersAsync();
      await stopping;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it("overlaps rotation, emits complete files in order, and waits for final delivery", async () => {
    FakeRecorder.delays = [1500, 0, 0];
    create().start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeRecorder.events.slice(0, 5)).toEqual(["start:0", "start:1", "stop:0", "start:2", "stop:1"]);
    expect(chunks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    let resolved = false;
    const stopping = live.stop().then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await stopping;
    expect(chunks.map(c => [c.startMs, c.endMs])).toEqual([[0, 1000], [1000, 2000], [2000, 2400]]);
    expect(await Promise.all(chunks.map(c => c.blob.text()))).toEqual(["header:0", "header:1", "header:2"]);
    expect(chunks.every(c => c.mimeType === "audio/test")).toBe(true);
  });
  it("excludes pauses from both the clock and the same recorder's timeline", async () => {
    create({ startOffsetMs: 5000 }).start();
    await vi.advanceTimersByTimeAsync(400);
    live.pause();
    expect(live.state).toBe("paused");
    await vi.advanceTimersByTimeAsync(10000);
    expect(live.elapsedMs).toBe(5400);
    expect(FakeRecorder.instances).toHaveLength(1);
    live.resume();
    await vi.advanceTimersByTimeAsync(400);
    const stopping = live.stop();
    await vi.runAllTimersAsync();
    await stopping;
    expect(chunks.map(c => [c.startMs, c.endMs])).toEqual([[5000, 5800]]);
    expect(chunks[0].speechMs).toBe(800);
    expect(live.elapsedMs).toBe(5800);
    await vi.advanceTimersByTimeAsync(1000);
    expect(live.elapsedMs).toBe(5800);
  });
  it("does not cut on a delayed silent frame, but enforces max duration on the next delayed tick", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    analyser.level = 0;
    create({ minMs: 20000, maxMs: 45000, silenceMs: 700 }).start();
    now = 30000;
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeRecorder.instances).toHaveLength(1);
    now = 60000;
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeRecorder.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(chunks[0].endMs).toBe(60000);
  });
  it("cuts at the first sustained silence after minimum duration", async () => {
    create({ maxMs: 5000 }).start();
    await vi.advanceTimersByTimeAsync(300);
    analyser.level = 0;
    await vi.advanceTimersByTimeAsync(301);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].endMs).toBe(600);
    expect(chunks[0].speechMs).toBe(300);
  });
  it("flushes while paused and makes repeated stop calls share completion", async () => {
    create().start();
    await vi.advanceTimersByTimeAsync(400);
    live.pause();
    await vi.advanceTimersByTimeAsync(1000);
    const first = live.stop();
    expect(live.stop()).toBe(first);
    await vi.runAllTimersAsync();
    await first;
    expect(chunks[0].endMs).toBe(400);
    expect(live.state).toBe("stopped");
  });
  it("skips a sub-300 ms silent final tail but preserves a speech tail", async () => {
    analyser.level = 0;
    create().start();
    await vi.advanceTimersByTimeAsync(200);
    let stopping = live.stop();
    await vi.runAllTimersAsync();
    await stopping;
    expect(chunks).toHaveLength(0);
    analyser.level = 0.1;
    create().start();
    await vi.advanceTimersByTimeAsync(100);
    stopping = live.stop();
    await vi.runAllTimersAsync();
    await stopping;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].speechMs).toBe(100);
  });
  it("maps unsupported starts and runtime recorder errors to AppError", async () => {
    const onError = vi.fn();
    FakeRecorder.failStart = true;
    create({ onError });
    expect(() => live.start()).toThrow(expect.objectContaining({ code: "recorder-unsupported" }));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "recorder-unsupported" }));
    FakeRecorder.failStart = false;
    create({ onError }).start();
    await vi.advanceTimersByTimeAsync(400);
    FakeRecorder.instances.at(-1)!.onerror?.({ error: new DOMException("", "UnknownError") });
    await vi.runAllTimersAsync();
    await live.stop();
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ code: "unknown" }));
    expect(chunks).toHaveLength(1);
  });
  it("flushes the existing chunk when the replacement recorder cannot start", async () => {
    const onError = vi.fn();
    create({ onError }).start();
    await vi.advanceTimersByTimeAsync(500);
    FakeRecorder.failStart = true;
    await vi.advanceTimersByTimeAsync(501);
    await live.stop();
    expect(live.state).toBe("stopped");
    expect(chunks.map(c => [c.startMs, c.endMs])).toEqual([[0, 1000]]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "recorder-unsupported" }));
  });
  it("waits for final data when an errored recorder is already inactive", async () => {
    const onError = vi.fn();
    create({ onError }).start();
    await vi.advanceTimersByTimeAsync(400);
    const recorder = FakeRecorder.instances[0];
    recorder.state = "inactive";
    recorder.onerror?.({ error: new DOMException("", "NotSupportedError") });
    let resolved = false;
    const stopping = live.stop().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    recorder.ondataavailable?.({ data: new Blob(["final"]) });
    recorder.onstop?.();
    await stopping;
    expect(chunks).toHaveLength(1);
    expect(await chunks[0].blob.text()).toBe("final");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "recorder-unsupported" }));
  });
  it("checkpoints cumulative timeslice data from one recorder without prematurely emitting a segment", async () => {
    const checkpoints: AudioChunk[] = [];
    create({ minMs: 20000, maxMs: 45000, onCheckpoint: chunk => checkpoints.push(chunk) }).start();
    const recorder = FakeRecorder.instances[0];
    expect(recorder.timeslice).toBe(4000);
    await vi.advanceTimersByTimeAsync(4000);
    recorder.ondataavailable?.({ data: new Blob(["header:first"]) });
    await vi.advanceTimersByTimeAsync(4000);
    recorder.ondataavailable?.({ data: new Blob(["second"]) });
    expect(chunks).toHaveLength(0);
    expect(checkpoints.map(c => c.endMs)).toEqual([4000, 8000]);
    expect(await checkpoints[1].blob.text()).toBe("header:firstsecond");
    expect(checkpoints[1].speechMs).toBe(8000);
    const stopped = live.stop(); await vi.runAllTimersAsync(); await stopped;
    expect(checkpoints).toHaveLength(2);
    expect(await chunks[0].blob.text()).toBe("header:firstsecondheader:0");
  });
  it("marks a gap unknown even if stop occurs before another analyser tick", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    create().start();
    now = 25000;
    const stopped = live.stop(); await vi.runAllTimersAsync(); await stopped;
    expect(chunks[0]).toMatchObject({ endMs: 25000 });
    expect(chunks[0].speechMs).toBeUndefined();
  });
  it("cuts periodic beeps with actual one-second silent gaps after the minimum", async () => {
    create({ minMs: 20000, maxMs: 45000, silenceMs: 700 }).start();
    for (let frame = 0; frame < 220; frame++) {
      analyser.level = frame % 12 < 2 ? 0.06 : 0.0001;
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].endMs).toBeGreaterThanOrEqual(20000);
    expect(chunks[0].endMs).toBeLessThan(22000);
  });
});
