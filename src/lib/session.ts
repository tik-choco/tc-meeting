import { AppError } from "../types";
import type { AudioChunk, CaptureSource, ChunkProfile, Meeting, MeetingAssist } from "../types";
import type { LockProvider } from "./db";
import { acquireRecordingLock, browserLocks, putDraft, addSegmentWithAudio, getMeeting, putMeeting, recoverInterrupted, updateMeeting } from "./db";
import { newId, segmentId } from "./ids";
import { createTranscriptionQueue } from "./queue";
import type { TranscriptionQueue } from "./queue";
import { startCapture } from "./audio/capture";
import type { CaptureHandle } from "./audio/capture";
import { createSegmenter } from "./audio/segmenter";
import type { Segmenter } from "./audio/segmenter";
import { splitAudioFile } from "./audio/fileImport";
import { holdWakeLock } from "./audio/wakeLock";
import { pickRecorderMimeType } from "./audio/mime";
import { transcribe } from "./ai/stt";

export type RecordingPhase = "idle" | "starting" | "recording" | "paused" | "stopping";
export type RecordingState = { phase: RecordingPhase; meetingId: string | null; elapsedMs: number; level: number; error?: AppError; tabEnded?: boolean };
export type ImportProgress = { meetingId: string; ratio: number };
export const CHUNK_PROFILES: Readonly<Record<ChunkProfile, { minMs: number; maxMs: number; silenceMs: number }>> = {
  standard: { minMs: 20000, maxMs: 45000, silenceMs: 700 },
  fast: { minMs: 6000, maxMs: 15000, silenceMs: 500 },
};
export interface SessionDeps {
  locks?: LockProvider | null;
  startCapture: typeof startCapture;
  createSegmenter: typeof createSegmenter;
  splitAudioFile: typeof splitAudioFile;
  holdWakeLock: typeof holdWakeLock;
  pickRecorderMimeType: typeof pickRecorderMimeType;
  transcribe: typeof transcribe;
}
const defaults: SessionDeps = { startCapture, createSegmenter, splitAudioFile, holdWakeLock, pickRecorderMimeType, transcribe };
let deps = { ...defaults };
let state: RecordingState = { phase: "idle", meetingId: null, elapsedMs: 0, level: 0 };
const listeners = new Set<(s: RecordingState) => void>();
let queue: TranscriptionQueue | undefined;
let initialized: Promise<void> | undefined;
let starting: Promise<void> | undefined;
let stopping: Promise<void> | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let lastNotification = 0;
type Timeline = { meetingId: string; nextSeq: number; chain: Promise<void> };
type Live = Timeline & { capture?: CaptureHandle; segmenter?: Segmenter; releaseWake?: () => void; releaseRec?: () => void };
let live: Live | undefined;

const asError = (error: unknown): AppError => error instanceof AppError ? error : new AppError("unknown", undefined, { cause: error });
const timestamp = () => new Date().toISOString();
function emit(force = true): void {
  if (!force && Date.now() - lastNotification < 250) return;
  lastNotification = Date.now();
  for (const cb of listeners) { try { cb({ ...state }); } catch { /* Observers do not own capture. */ } }
}
function progress(): void {
  if (live?.segmenter) state = { ...state, elapsedMs: live.segmenter.elapsedMs };
  emit(false);
}
function requireIdle(): void { if (state.phase !== "idle") throw new AppError("already-recording"); }
function makeMeeting(opts: { title: string; language: string; keepAudio: boolean; assist?: MeetingAssist; chunkProfile?: ChunkProfile }, source: Meeting["source"], status: Meeting["status"]): Meeting {
  const now = timestamp();
  return { id: newId(), ...opts, source, status, createdAt: now, updatedAt: now, durationMs: 0, nextSeq: 0 };
}
export function getQueue(): TranscriptionQueue {
  queue ??= createTranscriptionQueue({ locks: deps.locks, transcribe: input => deps.transcribe(input) });
  return queue;
}
export function initSession(): Promise<void> {
  initialized ??= (async () => { await recoverInterrupted({ locks: deps.locks }); await getQueue().resumeAll(); })()
    .catch(error => { initialized = undefined; throw error; });
  return initialized;
}
export function getRecordingState(): RecordingState { return { ...state }; }
export function subscribeRecording(cb: (s: RecordingState) => void): () => void {
  listeners.add(cb); cb(getRecordingState());
  return () => { listeners.delete(cb); };
}
async function persistChunk(timeline: Timeline, chunk: AudioChunk): Promise<void> {
  const seq = timeline.nextSeq;
  const id = segmentId(timeline.meetingId, seq);
  // Never start STT until both audio and its metadata are durable.
  await addSegmentWithAudio({
    id, meetingId: timeline.meetingId, seq, startMs: chunk.startMs, endMs: chunk.endMs,
    status: "pending", text: "", edited: false, attempts: 0, mimeType: chunk.mimeType,
    hasAudio: true, speechMs: chunk.speechMs,
  }, chunk.blob, true);
  timeline.nextSeq = seq + 1;
  getQueue().enqueue(id);
}
function appendChunk(timeline: Timeline, chunk: AudioChunk): Promise<void> {
  timeline.chain = timeline.chain.then(() => persistChunk(timeline, chunk));
  return timeline.chain;
}
function reportLiveError(error: unknown): void {
  state = { ...state, error: asError(error) };
  emit();
  void stopRecording().catch(() => { /* stopRecording already publishes the error. */ });
}
function observeChain(current: Live): void {
  void current.chain.catch(error => { if (live === current) reportLiveError(error); });
}
function release(current: Live): void {
  if (ticker !== undefined) clearInterval(ticker);
  ticker = undefined;
  try { current.capture?.stop(); } finally { try { current.releaseWake?.(); } finally { current.releaseRec?.(); } }
}
async function begin(meeting: Meeting, opts: { source: CaptureSource; micDeviceId?: string }, releaseRec: () => void): Promise<void> {
  const current: Live = { releaseRec, meetingId: meeting.id, nextSeq: meeting.nextSeq, chain: Promise.resolve() };
  live = current;
  state = { ...state, meetingId: meeting.id, elapsedMs: meeting.durationMs };
  emit();
  current.capture = await deps.startCapture(opts);
  current.releaseWake = deps.holdWakeLock();
  current.segmenter = deps.createSegmenter(current.capture, {
    ...CHUNK_PROFILES[meeting.chunkProfile ?? "standard"],
    startOffsetMs: meeting.durationMs, mimeType: deps.pickRecorderMimeType(),
    onChunk(chunk) {
      if (live !== current) return;
      void appendChunk(current, chunk); observeChain(current);
    },
    onCheckpoint(chunk) {
      if (live !== current) return;
      current.chain = current.chain.then(() => putDraft(current.meetingId, chunk));
      observeChain(current);
    },
    onLevel(level) {
      if (live !== current) return;
      state = { ...state, level: Math.max(0, Math.min(1, level)), elapsedMs: current.segmenter?.elapsedMs ?? state.elapsedMs };
      emit(false);
    },
    onError(error) { if (live === current) reportLiveError(error); },
  });
  current.capture.onEnded(reason => {
    if (live !== current || state.phase === "stopping" || state.phase === "idle") return;
    if (reason === "tab") { state = { ...state, tabEnded: true }; emit(); }
    else reportLiveError(new AppError("mic-unavailable"));
  });
  current.segmenter.start();
  state = { ...state, phase: "recording" };
  emit();
  ticker = setInterval(progress, 250);
}
async function startFailed(error: unknown, meetingId?: string): Promise<never> {
  const appError = asError(error);
  if (live) {
    try { await live.segmenter?.stop(); await live.chain; } catch { /* Preserve the startup error. */ }
    try { release(live); } catch { /* Preserve the startup error. */ }
  }
  live = undefined;
  if (meetingId) {
    try { await updateMeeting(meetingId, current => ({ ...current, status: "stopped", updatedAt: timestamp() })); } catch { /* Recovery repairs interrupted metadata. */ }
  }
  state = { ...state, phase: "idle", meetingId: null, level: 0, error: appError };
  emit();
  throw appError;
}
export async function startNewMeeting(opts: { title: string; language: string; source: CaptureSource; micDeviceId?: string; keepAudio: boolean; assist?: MeetingAssist; chunkProfile?: ChunkProfile }): Promise<string> {
  requireIdle();
  state = { phase: "starting", meetingId: null, elapsedMs: 0, level: 0 };
  emit();
  let meeting: Meeting | undefined;
  let releaseRec: (() => void) | undefined;
  const task = (async () => {
    try {
      await initSession();
      meeting = makeMeeting({ title: opts.title, language: opts.language, keepAudio: opts.keepAudio, assist: opts.assist }, opts.source, "recording");
      if (opts.chunkProfile !== undefined) meeting.chunkProfile = opts.chunkProfile;
      releaseRec = await acquireRecordingLock(meeting.id, deps.locks);
      await putMeeting(meeting);
      await begin(meeting, opts, releaseRec);
    } catch (error) { try { await startFailed(error, meeting?.id); } finally { releaseRec?.(); } }
  })();
  starting = task;
  try { await task; return meeting!.id; } finally { if (starting === task) starting = undefined; }
}
export async function continueMeeting(meetingId: string, opts: { source: CaptureSource; micDeviceId?: string }): Promise<void> {
  requireIdle();
  let releaseRec: (() => void) | undefined;
  state = { phase: "starting", meetingId, elapsedMs: 0, level: 0 };
  emit();
  const task = (async () => {
    try {
      await initSession();
      const locks = deps.locks === undefined ? browserLocks() : deps.locks;
      if (locks) await recoverInterrupted({ locks });
      releaseRec = await acquireRecordingLock(meetingId, deps.locks);
      if (!await getMeeting(meetingId)) throw new AppError("not-found");
      const meeting = await updateMeeting(meetingId, current => ({ ...current, source: opts.source, status: "recording", updatedAt: timestamp() }));
      if (!meeting) throw new AppError("not-found");
      await begin(meeting, opts, releaseRec);
    } catch (error) { try { await startFailed(error, releaseRec ? meetingId : undefined); } finally { releaseRec?.(); } }
  })();
  starting = task;
  try { await task; } finally { if (starting === task) starting = undefined; }
}
function setLiveStatus(status: "paused" | "recording"): void {
  const current = live;
  if (!current) return;
  current.chain = current.chain.then(async () => {
    await updateMeeting(current.meetingId, meeting => ({ ...meeting, status, updatedAt: timestamp() }));
  });
  observeChain(current);
}
export function pauseRecording(): void {
  if (state.phase !== "recording" || !live?.segmenter) return;
  live.segmenter.pause();
  state = { ...state, phase: "paused", elapsedMs: live.segmenter.elapsedMs, level: 0 };
  setLiveStatus("paused");
  emit();
}
export function resumeRecording(): void {
  if (state.phase !== "paused" || !live?.segmenter) return;
  live.segmenter.resume();
  state = { ...state, phase: "recording" };
  setLiveStatus("recording");
  emit();
}
export async function stopRecording(): Promise<void> {
  if (stopping) return stopping;
  if (starting) { try { await starting; } catch { return; } }
  if (stopping) return stopping;
  const current = live;
  if (!current) return;
  state = { ...state, phase: "stopping", elapsedMs: current.segmenter?.elapsedMs ?? state.elapsedMs, level: 0 };
  emit();
  const task = (async () => {
    let failure: unknown;
    try { await current.segmenter?.stop(); } catch (error) { failure = error; }
    try { await current.chain; } catch (error) { failure ??= error; }
    try {
      const meeting = await updateMeeting(current.meetingId, value => ({ ...value, status: "stopped", updatedAt: timestamp() }));
      if (meeting) state = { ...state, elapsedMs: meeting.durationMs };
    } catch (error) { failure ??= error; }
    finally {
      try { release(current); } catch (error) { failure ??= error; }
      live = undefined;
      state = { ...state, phase: "idle", meetingId: null, level: 0, ...(failure ? { error: asError(failure) } : {}) };
      emit();
    }
    if (failure) throw asError(failure);
  })();
  stopping = task;
  try { await task; } finally { if (stopping === task) stopping = undefined; }
}
export async function importAudioFile(file: File, opts: { title: string; language: string; keepAudio: boolean; assist?: MeetingAssist; signal?: AbortSignal; onProgress?: (p: ImportProgress) => void }): Promise<string> {
  await initSession();
  const meeting = makeMeeting({ title: opts.title, language: opts.language, keepAudio: opts.keepAudio, assist: opts.assist }, "file", "importing");
  const releaseRec = await acquireRecordingLock(meeting.id, deps.locks);
  try { await putMeeting(meeting); } catch (error) { releaseRec(); throw error; }
  const timeline: Timeline = { meetingId: meeting.id, nextSeq: 0, chain: Promise.resolve() };
  let failure: unknown;
  try {
    if (opts.signal?.aborted) throw new AppError("aborted");
    const result = await deps.splitAudioFile(file, {
      signal: opts.signal,
      onChunk: chunk => appendChunk(timeline, chunk),
      onProgress: ratio => opts.onProgress?.({ meetingId: meeting.id, ratio: Math.max(0, Math.min(1, ratio)) }),
    });
    await timeline.chain;
    await updateMeeting(meeting.id, current => ({ ...current, durationMs: Math.max(current.durationMs, result.durationMs), updatedAt: timestamp() }));
  } catch (error) {
    if (!(error instanceof AppError && error.code === "aborted") && !(error instanceof DOMException && error.name === "AbortError")) failure = error;
  } finally {
    try { await timeline.chain; } catch (error) { failure ??= error; }
    try { await updateMeeting(meeting.id, current => ({ ...current, status: "stopped", updatedAt: timestamp() })); }
    finally { releaseRec(); }
  }
  if (failure) throw asError(failure);
  return meeting.id;
}
/** Replace browser dependencies only while idle. Names match the contract modules. */
export function __setSessionDeps(overrides: Partial<SessionDeps>): void {
  requireIdle();
  deps = { ...defaults, ...overrides };
  queue?.dispose();
  queue = undefined;
  initialized = undefined;
  state = { phase: "idle", meetingId: null, elapsedMs: 0, level: 0 };
}
