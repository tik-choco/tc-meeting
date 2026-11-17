/// <reference types="node" />
import "fake-indexeddb/auto";
import { Blob as NativeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../types";
import type { AudioChunk, TranscribeInput } from "../types";
import { __setDbName, addSegmentWithAudio, getMeeting, getSegmentAudio, listMeetings, listSegments, putMeeting } from "./db";
import type { CaptureHandle } from "./audio/capture";
import type { Segmenter, SegmenterOptions } from "./audio/segmenter";
import type { splitAudioFile as splitAudioFileFn } from "./audio/fileImport";
import { __setSessionDeps, continueMeeting, getQueue, getRecordingState, importAudioFile, initSession,
  pauseRecording, resumeRecording, startNewMeeting, stopRecording, subscribeRecording, CHUNK_PROFILES } from "./session";

// Session tests supply STT explicitly and never start the application network stack.
vi.mock("./ai/stt", () => ({ transcribe: vi.fn() }));
const options = { title: "Meeting", language: "ja", source: "mic" as const, keepAudio: true };
let callbacks: SegmenterOptions;
let ended: (reason: "mic" | "tab") => void;
let elapsed = 0;
let phase: Segmenter["state"];
let finalChunk: AudioChunk | undefined;
let gate: Promise<void> | undefined;
let capture: CaptureHandle;
let segmenter: Segmenter;
const releaseWake = vi.fn();
const wakeLock = vi.fn(() => releaseWake);
const transcribe = vi.fn(async (_input: TranscribeInput) => ({ text: "transcript", via: "api" as const }));
const unsubscribers: (() => void)[] = [];
function chunk(startMs: number, endMs: number): AudioChunk {
  return { startMs, endMs, blob: new Blob([`${startMs}-${endMs}`], { type: "audio/wav" }), mimeType: "audio/wav", speechMs: endMs - startMs };
}
function configure(overrides: Parameters<typeof __setSessionDeps>[0] = {}): void {
  __setSessionDeps({
    startCapture: vi.fn(async () => capture),
    createSegmenter: vi.fn((_capture, opts) => { callbacks = opts; elapsed = opts.startOffsetMs ?? 0; return segmenter; }),
    splitAudioFile: vi.fn(async () => ({ durationMs: 0 })),
    holdWakeLock: wakeLock, pickRecorderMimeType: () => "audio/wav", transcribe, ...overrides,
  });
}
beforeEach(async () => {
  vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("BroadcastChannel", undefined);
  await __setDbName(`session-${crypto.randomUUID()}`);
  vi.clearAllMocks();
  elapsed = 0; phase = "idle"; finalChunk = undefined; gate = undefined;
  capture = { stream: {} as MediaStream, analyser: {} as AnalyserNode,
    onEnded: cb => { ended = cb; }, stop: vi.fn() };
  segmenter = {
    start: vi.fn(() => { phase = "recording"; }),
    pause: vi.fn(() => { phase = "paused"; }),
    resume: vi.fn(() => { phase = "recording"; }),
    stop: vi.fn(async () => { if (gate) await gate; if (finalChunk) callbacks.onChunk(finalChunk); phase = "stopped"; }),
    get elapsedMs() { return elapsed; }, get state() { return phase; },
  };
  configure();
});
afterEach(async () => {
  await stopRecording().catch(() => {});
  getQueue().dispose();
  await vi.waitFor(() => expect(getQueue().getState().active).toBe(0), { interval: 5 });
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  __setSessionDeps({ transcribe });
  await __setDbName(`unused-${crypto.randomUUID()}`);
  vi.unstubAllGlobals();
});

describe("recording session", () => {
  it("wires the stored fast profile into new and continued live capture, leaving imports standard", async () => {
    getQueue().pause();
    const id = await startNewMeeting({ ...options, chunkProfile: "fast" });
    expect(CHUNK_PROFILES).toEqual({ standard: { minMs: 20000, maxMs: 45000, silenceMs: 700 },
      fast: { minMs: 6000, maxMs: 15000, silenceMs: 500 } });
    expect(callbacks).toMatchObject(CHUNK_PROFILES.fast);
    expect((await getMeeting(id))?.chunkProfile).toBe("fast");
    callbacks.onChunk(chunk(0, 6000));
    await stopRecording();
    await continueMeeting(id, { source: "mic+tab" });
    expect(callbacks).toMatchObject({ ...CHUNK_PROFILES.fast, startOffsetMs: 6000 });
    await stopRecording();
    const splitAudioFile = vi.fn<typeof splitAudioFileFn>(async () => ({ durationMs: 0 }));
    const createSegmenter = vi.fn(() => segmenter);
    configure({ splitAudioFile, createSegmenter });
    const imported = await importAudioFile(new File(["audio"], "meeting.wav"), options);
    expect((await getMeeting(imported))?.chunkProfile).toBeUndefined();
    expect(createSegmenter).not.toHaveBeenCalled();
    expect(splitAudioFile.mock.calls[0]).toHaveLength(2);
    expect(splitAudioFile.mock.calls[0][1]).not.toHaveProperty("minMs");
    expect(splitAudioFile.mock.calls[0][1]).not.toHaveProperty("maxMs");
  });
  it.each([undefined, "standard"] as const)("uses standard live chunking for profile %s", async chunkProfile => {
    const id = await startNewMeeting({ ...options, chunkProfile });
    expect(callbacks).toMatchObject(CHUNK_PROFILES.standard);
    const stored = await getMeeting(id);
    if (chunkProfile === undefined) expect(stored).not.toHaveProperty("chunkProfile");
    else expect(stored?.chunkProfile).toBe("standard");
    await stopRecording();
    await continueMeeting(id, { source: "mic" });
    expect(callbacks).toMatchObject(CHUNK_PROFILES.standard);
  });
  it("stores assist options for new recordings and imports and preserves them on continuation", async () => {
    getQueue().pause();
    const assist = { translateTo: "ja", liveNotes: true };
    const id = await startNewMeeting({ ...options, assist });
    expect((await getMeeting(id))?.assist).toEqual(assist);
    await stopRecording();
    await continueMeeting(id, { source: "mic" });
    expect((await getMeeting(id))?.assist).toEqual(assist);
    await stopRecording();
    const imported = await importAudioFile(new File(["audio"], "meeting.wav"), { ...options, assist });
    expect((await getMeeting(imported))?.assist).toEqual(assist);
  });
  it("creates a meeting before capture and persists bursts and the final flush in timeline order", async () => {
    configure({ startCapture: async () => {
      expect(await listMeetings()).toMatchObject([{ status: "recording", nextSeq: 0, durationMs: 0 }]);
      return capture;
    } });
    getQueue().pause();
    const id = await startNewMeeting(options);
    expect(getRecordingState()).toMatchObject({ phase: "recording", meetingId: id });
    callbacks.onChunk(chunk(0, 30000)); callbacks.onChunk(chunk(30000, 60000)); callbacks.onChunk(chunk(60000, 90000));
    finalChunk = chunk(90000, 91000); elapsed = 91000;
    let allowStop!: () => void;
    gate = new Promise<void>(resolve => { allowStop = resolve; });
    const stopped = stopRecording();
    expect(getRecordingState().phase).toBe("stopping");
    allowStop(); await stopped;
    const segments = await listSegments(id);
    expect(segments.map(s => [s.seq, s.startMs, s.endMs])).toEqual([[0, 0, 30000], [1, 30000, 60000], [2, 60000, 90000], [3, 90000, 91000]]);
    expect(segments.every(s => s.status === "pending")).toBe(true);
    expect(await getMeeting(id)).toMatchObject({ status: "stopped", durationMs: 91000, nextSeq: 4 });
    for (const s of segments) expect(await getSegmentAudio(s.id)).toBeDefined();
    expect(segmenter.stop).toHaveBeenCalledOnce();
    expect(capture.stop).toHaveBeenCalledOnce(); expect(releaseWake).toHaveBeenCalledOnce();
    expect(getRecordingState()).toMatchObject({ phase: "idle", meetingId: null, elapsedMs: 91000 });
  });
  it("maps pause/resume to the segmenter and serializes status updates before stopping", async () => {
    const id = await startNewMeeting(options);
    pauseRecording(); expect(segmenter.pause).toHaveBeenCalledOnce();
    expect(getRecordingState().phase).toBe("paused");
    await vi.waitFor(async () => expect((await getMeeting(id))?.status).toBe("paused"), { interval: 5 });
    resumeRecording(); expect(segmenter.resume).toHaveBeenCalledOnce();
    expect(getRecordingState().phase).toBe("recording");
    pauseRecording(); resumeRecording();
    await stopRecording();
    expect((await getMeeting(id))?.status).toBe("stopped");
    expect(releaseWake).toHaveBeenCalledOnce();
  });
  it("appends continued recordings at the previous duration and next sequence", async () => {
    getQueue().pause();
    const id = await startNewMeeting(options);
    callbacks.onChunk(chunk(0, 30000)); await stopRecording();
    await continueMeeting(id, { source: "mic+tab" });
    expect(callbacks.startOffsetMs).toBe(30000);
    callbacks.onChunk(chunk(30000, 45000)); await stopRecording();
    expect((await listSegments(id)).map(s => s.seq)).toEqual([0, 1]);
    expect(await getMeeting(id)).toMatchObject({ durationMs: 45000, nextSeq: 2, status: "stopped", source: "mic+tab" });
  });
  it("keeps recording when tab audio ends and gracefully stops with a localized mic error", async () => {
    getQueue().pause(); const id = await startNewMeeting({ ...options, source: "mic+tab" });
    ended("tab"); expect(getRecordingState()).toMatchObject({ tabEnded: true, phase: "recording" });
    finalChunk = chunk(0, 1000);
    ended("mic");
    await vi.waitFor(() => expect(getRecordingState().phase).toBe("idle"), { interval: 5 });
    expect(getRecordingState().error?.code).toBe("mic-unavailable");
    expect(await getMeeting(id)).toMatchObject({ status: "stopped", nextSeq: 1, durationMs: 1000 });
    expect(releaseWake).toHaveBeenCalledOnce();
  });
  it("rejects simultaneous starts and coalesces stops made during startup", async () => {
    let allowCapture!: (capture: CaptureHandle) => void;
    configure({ startCapture: () => new Promise<CaptureHandle>(resolve => { allowCapture = resolve; }) });
    const started = startNewMeeting(options);
    await expect(startNewMeeting(options)).rejects.toMatchObject({ code: "already-recording" });
    await expect(continueMeeting("other", { source: "mic" })).rejects.toMatchObject({ code: "already-recording" });
    await vi.waitFor(() => expect(allowCapture).toBeTypeOf("function"), { interval: 5 });
    const stop1 = stopRecording(); const stop2 = stopRecording();
    allowCapture(capture); await started; await Promise.all([stop1, stop2]);
    expect(segmenter.stop).toHaveBeenCalledOnce();
    expect(getRecordingState().phase).toBe("idle");
  });
  it("cleans up capture and wake locks when startup fails, and handles missing meetings", async () => {
    configure({ createSegmenter: () => { throw new AppError("recorder-unsupported"); } });
    await expect(startNewMeeting(options)).rejects.toMatchObject({ code: "recorder-unsupported" });
    expect(capture.stop).toHaveBeenCalledOnce(); expect(releaseWake).toHaveBeenCalledOnce();
    expect(getRecordingState()).toMatchObject({ phase: "idle", error: { code: "recorder-unsupported" } });
    expect((await listMeetings())[0].status).toBe("stopped");
    await expect(continueMeeting("missing", { source: "mic" })).rejects.toMatchObject({ code: "not-found" });
  });
  it("publishes level and elapsed changes at most about four times per second", async () => {
    const cb = vi.fn(); unsubscribers.push(subscribeRecording(cb));
    await startNewMeeting(options); const baseline = cb.mock.calls.length;
    elapsed = 1234;
    for (let i = 0; i < 100; i++) callbacks.onLevel?.(0.7);
    expect(cb.mock.calls.length - baseline).toBeLessThanOrEqual(1);
    expect(getRecordingState()).toMatchObject({ elapsedMs: 1234, level: 0.7 });
    await vi.waitFor(() => expect(cb).toHaveBeenLastCalledWith(expect.objectContaining({ elapsedMs: 1234, level: 0.7 })), { interval: 20, timeout: 600 });
  });
  it("only transcribes a chunk after its audio is readable from persistent storage", async () => {
    const durableTranscribe = vi.fn(async (input: TranscribeInput) => {
      const id = getRecordingState().meetingId;
      expect(await getSegmentAudio(`${id}:000000`)).toBeDefined();
      expect(await input.audio.text()).toBe("0-30000");
      return { text: "saved first", via: "api" as const };
    });
    configure({ transcribe: durableTranscribe });
    const id = await startNewMeeting(options); callbacks.onChunk(chunk(0, 30000));
    await vi.waitFor(async () => expect((await listSegments(id))[0]?.text).toBe("saved first"), { interval: 5 });
    expect(durableTranscribe).toHaveBeenCalledOnce();
  });
  it("initializes recovery and queue resumption only once", async () => {
    const now = new Date().toISOString();
    await putMeeting({ id: "old", title: "Old", language: "", source: "mic", keepAudio: true,
      createdAt: now, updatedAt: now, nextSeq: 0, durationMs: 0, status: "recording" });
    await addSegmentWithAudio({ id: "old:000000", meetingId: "old", seq: 0, startMs: 0, endMs: 30000,
      status: "transcribing", text: "", edited: false, attempts: 1, mimeType: "audio/wav", hasAudio: true }, new Blob(["audio"]));
    const first = initSession(); expect(initSession()).toBe(first); await first;
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce(), { interval: 5 });
    expect(await getMeeting("old")).toMatchObject({ status: "interrupted", nextSeq: 1, durationMs: 30000 });
    await initSession(); expect(transcribe).toHaveBeenCalledOnce();
  });
});

describe("file imports", () => {
  it("persists ordered chunks, reports meeting-scoped progress, and stops on completion", async () => {
    configure({ splitAudioFile: async (_file, opts) => {
      expect((await listMeetings())[0].status).toBe("importing");
      await opts.onChunk(chunk(0, 30000)); opts.onProgress?.(0.5);
      await opts.onChunk(chunk(30000, 40000)); opts.onProgress?.(1);
      return { durationMs: 40000 };
    } });
    getQueue().pause(); const onProgress = vi.fn();
    const id = await importAudioFile(new File(["audio"], "input.wav"), { ...options, onProgress });
    expect(await getMeeting(id)).toMatchObject({ status: "stopped", source: "file", durationMs: 40000, nextSeq: 2 });
    expect((await listSegments(id)).map(s => s.seq)).toEqual([0, 1]);
    expect(onProgress.mock.calls).toEqual([[{ meetingId: id, ratio: 0.5 }], [{ meetingId: id, ratio: 1 }]]);
    expect(getRecordingState().phase).toBe("idle");
  });
  it("retains imported chunks and returns the stopped meeting after abort", async () => {
    const controller = new AbortController();
    configure({ splitAudioFile: async (_file, opts) => {
      expect(opts.signal).toBe(controller.signal);
      await opts.onChunk(chunk(0, 30000)); controller.abort(); throw new AppError("aborted");
    } });
    getQueue().pause();
    const id = await importAudioFile(new File(["audio"], "input.wav"), { ...options, signal: controller.signal });
    expect(await getMeeting(id)).toMatchObject({ status: "stopped", nextSeq: 1, durationMs: 30000 });
    expect(await getSegmentAudio(`${id}:000000`)).toBeDefined();
  });
  it("marks failed imports stopped and propagates decode errors", async () => {
    configure({ splitAudioFile: async () => { throw new AppError("decode-failed"); } });
    await expect(importAudioFile(new File(["bad"], "input.wav"), options)).rejects.toMatchObject({ code: "decode-failed" });
    expect((await listMeetings())[0].status).toBe("stopped");
  });
});

it("serializes checkpoints before finalization and clears the draft on final chunk commit", async () => {
  const db = await import("./db");
  getQueue().pause();
  const id = await startNewMeeting(options);
  callbacks.onCheckpoint?.(chunk(0, 4000));
  callbacks.onCheckpoint?.(chunk(0, 8000));
  await vi.waitFor(async () => expect(await db.getDraft(id)).toMatchObject({ endMs: 8000 }), { interval: 5 });
  callbacks.onChunk(chunk(0, 9000));
  await stopRecording();
  expect(await db.getDraft(id)).toBeUndefined();
  expect(await listSegments(id)).toMatchObject([{ seq: 0, startMs: 0, endMs: 9000 }]);
  expect(await getMeeting(id)).toMatchObject({ nextSeq: 1, durationMs: 9000, status: "stopped" });
});
