import { AppError } from "../../types";
import type { CaptureSource } from "../../types";
import { audioContextConstructor } from "./mime";
export interface CaptureHandle {
  stream: MediaStream;
  analyser: AnalyserNode;
  onEnded(cb: (reason: "mic" | "tab") => void): void;
  stop(): void;
}
function captureError(cause: unknown): AppError {
  if (cause instanceof AppError) return cause;
  const name = (cause as { name?: string })?.name;
  return new AppError(name === "NotAllowedError" || name === "SecurityError" ? "mic-denied"
    : name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError"
      ? "mic-unavailable" : "unknown", undefined, { cause });
}

export async function startCapture(opts: { source: CaptureSource; micDeviceId?: string }): Promise<CaptureHandle> {
  const Context = audioContextConstructor();
  if (!Context || !navigator.mediaDevices?.getUserMedia) throw new AppError("recorder-unsupported");
  const streams: MediaStream[] = [];
  const nodes: AudioNode[] = [];
  const listeners: (() => void)[] = [];
  const subscribers = new Set<(reason: "mic" | "tab") => void>();
  const ended = new Set<"mic" | "tab">();
  let context: AudioContext | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const remove of listeners) remove();
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    for (const node of nodes) { try { node.disconnect(); } catch { /* Already detached. */ } }
    subscribers.clear();
    if (context) {
      context.onstatechange = null;
      if (context.state !== "closed") void context.close().catch(() => {});
    }
  };
  try {
    // Resume during the initiating gesture, before permission prompts settle.
    context = new Context();
    const keepRunning = () => {
      if (!stopped && (context!.state === "suspended" || String(context!.state) === "interrupted")) {
        void context!.resume().catch(() => {});
      }
    };
    context.onstatechange = keepRunning;
    const resumed = context.state === "suspended" ? context.resume() : Promise.resolve();
    // Permissions can take time; keep early rejection handled until setup awaits it.
    void resumed.catch(() => {});
    let tab: MediaStream | undefined;
    if (opts.source === "mic+tab") {
      if (!navigator.mediaDevices.getDisplayMedia) throw new AppError("tab-audio-missing");
      tab = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      streams.push(tab);
      for (const track of tab.getVideoTracks()) track.stop();
      if (!tab.getAudioTracks().length) throw new AppError("tab-audio-missing");
    }
    const mic = await navigator.mediaDevices.getUserMedia({ audio: {
      ...(opts.micDeviceId ? { deviceId: { exact: opts.micDeviceId } } : {}),
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    } });
    streams.push(mic);
    if (!mic.getAudioTracks().length) throw new AppError("mic-unavailable");
    const analyser = context.createAnalyser();
    nodes.push(analyser);
    analyser.fftSize = 2048;
    const destination = context.createMediaStreamDestination();
    nodes.push(destination);
    streams.push(destination.stream);
    // A silent hardware output keeps the graph rendering without monitoring the mic.
    const silent = context.createGain();
    nodes.push(silent);
    silent.gain.value = 0;
    analyser.connect(destination);
    analyser.connect(silent);
    silent.connect(context.destination);
    const connect = (stream: MediaStream, reason: "mic" | "tab") => {
      const source = context!.createMediaStreamSource(stream);
      nodes.push(source);
      source.connect(analyser);
      const notify = () => {
        if (stopped || ended.has(reason)) return;
        ended.add(reason);
        source.disconnect();
        for (const cb of subscribers) cb(reason);
      };
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", notify);
        listeners.push(() => track.removeEventListener("ended", notify));
        if (track.readyState === "ended") notify();
      }
    };
    connect(mic, "mic");
    if (tab) connect(tab, "tab");
    await resumed;
    keepRunning();
    return { stream: destination.stream, analyser, stop, onEnded(cb) {
      subscribers.add(cb);
      for (const reason of ended) cb(reason);
    } };
  } catch (cause) {
    stop();
    throw captureError(cause);
  }
}

export async function listMicDevices(): Promise<{ deviceId: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput")
      .map(({ deviceId, label }) => ({ deviceId, label }));
  } catch (cause) { throw captureError(cause); }
}
