import { AppError } from "../../types";
import type { AudioChunk } from "../../types";
import type { CaptureHandle } from "./capture";
import { pickRecorderMimeType } from "./mime";
export interface SegmenterOptions {
  minMs?: number;
  maxMs?: number;
  silenceMs?: number;
  startOffsetMs?: number;
  mimeType?: string;
  onChunk(chunk: AudioChunk): void;
  onCheckpoint?(chunk: AudioChunk): void;
  onLevel?(level: number): void;
  onError?(error: AppError): void;
}
export interface Segmenter {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
  readonly elapsedMs: number;
  readonly state: "idle" | "recording" | "paused" | "stopped";
}
export function createSegmenter(capture: Pick<CaptureHandle, "stream" | "analyser">, opts: SegmenterOptions): Segmenter {
  const limits = {
    minMs: Math.max(1, opts.minMs ?? 20000),
    maxMs: Math.max(1, opts.maxMs ?? 45000),
    silenceMs: Math.max(0, opts.silenceMs ?? 700),
  };
  const mime = opts.mimeType ?? pickRecorderMimeType();
  const offset = opts.startOffsetMs ?? 0;
  const samples = new Float32Array(capture.analyser.fftSize);
  let state: Segmenter["state"] = "idle";
  let accumulated = 0;
  let runningSince = 0;
  let lastTick = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let vad = initialVadState();
  let active: Recording | undefined;
  let nextId = 0;
  let nextEmit = 0;
  let stopping: Promise<void> | undefined;
  const records = new Map<number, Recording>();
  const pending = new Set<Promise<void>>();

  interface Recording {
    id: number;
    recorder: MediaRecorder;
    parts: Blob[];
    startMs: number;
    endMs?: number;
    speechMs: number | undefined;
    coverageGap: boolean;
    final: boolean;
    ready: boolean;
    done: Promise<void>;
    resolve(): void;
  }
  const elapsed = () => offset + accumulated + (state === "recording" ? performance.now() - runningSince : 0);
  const asError = (cause: unknown) => cause instanceof AppError ? cause
    : new AppError((cause as { name?: string })?.name === "NotSupportedError" || typeof MediaRecorder === "undefined"
      ? "recorder-unsupported" : "unknown", undefined, { cause });
  const report = (cause: unknown) => opts.onError?.(asError(cause));
  const checkCoverage = () => {
    if (active && state === "recording" && performance.now() - lastTick > 1500) active.coverageGap = true;
  };
  const tracks = capture.stream.getTracks?.() ?? [];
  const trackEnded = () => { report(new AppError("mic-unavailable")); void stop(); };
  const freeze = () => {
    checkCoverage();
    if (state === "recording") accumulated += performance.now() - runningSince;
    state = "stopped";
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    for (const track of tracks) track.removeEventListener("ended", trackEnded);
  };
  const seal = (record: Recording, endMs: number, final: boolean) => {
    record.endMs = endMs;
    checkCoverage();
    record.speechMs = record.coverageGap ? undefined : vad.speechMs;
    record.final = final;
  };
  const drain = () => {
    while (records.get(nextEmit)?.ready) {
      const record = records.get(nextEmit)!;
      records.delete(nextEmit++);
      const duration = record.endMs! - record.startMs;
      if (record.parts.length && !(record.final && duration < 300 && record.speechMs === 0)) {
        const mimeType = record.recorder.mimeType || record.parts[0].type || mime || "audio/webm";
        const blob = new Blob(record.parts, { type: mimeType });
        try {
          opts.onChunk({ startMs: record.startMs, endMs: record.endMs!, speechMs: record.speechMs, blob, mimeType });
        } catch (cause) { report(cause); }
      }
      record.parts = [];
    }
  };
  const finish = (record: Recording) => {
    if (record.ready) return;
    const unexpected = active === record;
    // A source/recorder may stop itself without an explicit stop() call.
    if (active === record) {
      seal(record, elapsed(), true);
      active = undefined;
      freeze();
    }
    record.ready = true;
    record.recorder.ondataavailable = null;
    record.recorder.onstop = null;
    record.recorder.onerror = null;
    drain();
    pending.delete(record.done);
    record.resolve();
    if (unexpected) report(new AppError("unknown", "recorder-stopped"));
  };
  const open = (): Recording => {
    if (typeof MediaRecorder === "undefined") throw new AppError("recorder-unsupported");
    const recorder = new MediaRecorder(capture.stream, mime ? { mimeType: mime } : undefined);
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    const record: Recording = {
      id: nextId, recorder, parts: [], startMs: 0, speechMs: 0, coverageGap: false, final: false, ready: false, done, resolve,
    };
    recorder.ondataavailable = event => {
      if (!event.data.size) return;
      record.parts.push(event.data);
      if (active !== record || record.endMs !== undefined) return;
      checkCoverage();
      const mimeType = recorder.mimeType || event.data.type || mime || "audio/webm";
      try {
        opts.onCheckpoint?.({ startMs: record.startMs, endMs: elapsed(), mimeType,
          blob: new Blob(record.parts, { type: mimeType }), speechMs: record.coverageGap ? undefined : vad.speechMs });
      } catch (cause) { report(cause); void stop(); }
    };
    recorder.onstop = () => finish(record);
    recorder.onerror = event => {
      report((event as Event & { error?: DOMException }).error ?? event);
      void stop();
    };
    try { recorder.start(4000); }
    catch (cause) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* Start failed. */ } }
      throw cause;
    }
    record.startMs = elapsed();
    records.set(nextId++, record);
    pending.add(done);
    return record;
  };
  const endRecorder = (record: Recording) => {
    try {
      // Inactive after an error still has queued dataavailable/stop events.
      if (record.recorder.state !== "inactive") record.recorder.stop();
    } catch (cause) { report(cause); finish(record); }
  };
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    checkCoverage();
    const end = elapsed();
    const record = active;
    active = undefined;
    freeze();
    if (record) {
      seal(record, end, true);
      endRecorder(record);
    }
    stopping = Promise.all([...pending]).then(() => {});
    return stopping;
  };
  const tick = () => {
    if (state !== "recording" || !active) return;
    try {
      const now = performance.now();
      checkCoverage();
      capture.analyser.getFloatTimeDomainData(samples);
      const level = rms(samples);
      vad = stepVad(vad, level, now - lastTick);
      lastTick = now;
      opts.onLevel?.(Math.min(1, level * 4));
      if (state !== "recording" || !active) return;
      if (shouldCut({ segmentMs: elapsed() - active.startMs, silentMs: vad.silentMs }, limits)) {
        const previous = active;
        // Both recorders briefly own the same stream: never stop before starting.
        const next = open();
        seal(previous, next.startMs, false);
        active = next;
        vad = { ...vad, silentMs: 0, speechMs: 0 };
        endRecorder(previous);
      }
    } catch (cause) { report(cause); void stop(); }
  };
  return {
    get state() { return state; },
    get elapsedMs() { return elapsed(); },
    start() {
      if (state !== "idle") return;
      state = "recording";
      runningSince = lastTick = performance.now();
      try {
        active = open();
        for (const track of tracks) track.addEventListener("ended", trackEnded);
        timer = setInterval(tick, 100);
      } catch (cause) {
        freeze();
        const error = asError(cause);
        report(error);
        throw error;
      }
    },
    pause() {
      if (state !== "recording" || !active) return;
      try {
        checkCoverage();
        active.recorder.pause();
        accumulated += performance.now() - runningSince;
        state = "paused";
        vad = { ...vad, silentMs: 0 };
      } catch (cause) { report(cause); void stop(); }
    },
    resume() {
      if (state !== "paused" || !active) return;
      try {
        active.recorder.resume();
        runningSince = lastTick = performance.now();
        state = "recording";
      } catch (cause) { report(cause); void stop(); }
    },
    stop,
  };
}

export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}
export type VadState = { noiseFloor: number; silentMs: number; speechMs: number };
export function initialVadState(): VadState { return { noiseFloor: 0.003, silentMs: 0, speechMs: 0 }; }

export function stepVad(state: VadState, frameRms: number, frameMs: number): VadState & { speaking: boolean } {
  const dt = Math.max(0, Number.isFinite(frameMs) ? frameMs : 0);
  const level = Math.max(0, Number.isFinite(frameRms) ? frameRms : 0);
  const speaking = level > Math.max(0.01, state.noiseFloor * 3);
  // Never train the floor on speech; falling noise adapts much faster than rising noise.
  const adaptationMs = Math.min(dt, 200);
  const tau = level < state.noiseFloor ? 200 : 10000;
  const noiseFloor = !speaking || level < state.noiseFloor
    ? state.noiseFloor + (level - state.noiseFloor) * (1 - Math.exp(-adaptationMs / tau))
    : state.noiseFloor;
  return {
    noiseFloor,
    // Missing frames prove nothing about silence. Restart its evidence after a gap.
    silentMs: speaking ? 0 : dt > 250 ? Math.min(dt, 100) : state.silentMs + dt,
    speechMs: state.speechMs + (speaking ? dt : 0),
    speaking,
  };
}

export function shouldCut(p: { segmentMs: number; silentMs: number }, o: { minMs: number; maxMs: number; silenceMs: number }): boolean {
  return p.segmentMs >= o.maxMs || (p.segmentMs >= o.minMs && p.silentMs >= o.silenceMs);
}
