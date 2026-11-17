import { AppError, BLOCKING_STT_ERRORS } from "../types";
import type { AppErrorCode, Segment, TranscribeFn } from "../types";
import { browserLocks, resetTranscribing, subscribeDb, getMeeting, getSegment, getSegmentAudio, listMeetings, listSegments, updateSegment } from "./db";
import type { LockProvider } from "./db";
import { segmentFileName } from "./ids";
import { isLikelyHallucination, normalizeTranscript, promptTail } from "./transcript";

export type QueueState = { pending: number; active: number; failed: number; paused: boolean; blockedBy?: AppErrorCode; lastError?: string };
export interface TranscriptionQueue {
  enqueue(segmentId: string): void;
  resumeAll(): Promise<void>;
  retrySegment(segmentId: string): Promise<void>;
  retryFailed(meetingId: string): Promise<void>;
  pause(): void;
  resume(): void;
  getState(): QueueState;
  subscribe(cb: (state: QueueState) => void): () => void;
  dispose(): void;
}
export function createTranscriptionQueue(opts: {
  transcribe: TranscribeFn;
  locks?: LockProvider | null;
  concurrency?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): TranscriptionQueue {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 2) || 2);
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 4) || 4);
  const retryBaseMs = Math.max(1, opts.retryBaseMs ?? 2000);
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const waiting = new Map<string, number>();
  const running = new Map<string, AbortController>();
  const failed = new Set<string>();
  const listeners = new Set<(state: QueueState) => void>();
  const locks = opts.locks === undefined ? browserLocks() : opts.locks;
  let leader = !locks;
  let generation = 0;
  let unsubscribeDb: (() => void) | undefined;
  let releaseLeader: (() => void) | undefined;
  const leadershipAbort = new AbortController();
  let paused = false;
  let disposed = false;
  let blockedBy: AppErrorCode | undefined;
  let lastError: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function getState(): QueueState {
    return { pending: waiting.size, active: running.size, failed: failed.size, paused, blockedBy, lastError };
  }
  function emit(): void {
    for (const cb of listeners) { try { cb(getState()); } catch { /* Observers do not own jobs. */ } }
  }
  function cancelTimer(): void {
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
  }
  function pump(): void {
    cancelTimer();
    if (paused || disposed || !leader) return;
    for (const [id, readyAt] of waiting) {
      if (running.size >= concurrency) break;
      if (readyAt > now()) continue;
      waiting.delete(id);
      const controller = new AbortController();
      running.set(id, controller);
      const dispatchedGeneration = generation;
      void run(id, controller, dispatchedGeneration).catch(error => {
        // Storage failures must not become unhandled rejections or hot retry loops.
        lastError = error instanceof Error ? error.message : "unknown";
        if (dispatchedGeneration === generation && error instanceof AppError) blockedBy = error.code;
        if (!disposed) waiting.set(id, now());
        if (dispatchedGeneration === generation) paused = true;
      }).finally(() => {
        running.delete(id);
        if (disposed && !running.size) releaseLeader?.();
        emit();
        pump();
      });
    }
    if (running.size < concurrency && waiting.size) {
      const soonest = Math.min(...waiting.values());
      timer = setTimer(() => { timer = undefined; pump(); }, Math.max(0, soonest - now()));
    }
    emit();
  }
  async function finish(segment: Segment, status: "done" | "empty", text: string, keepAudio: boolean,
    via?: Segment["via"]): Promise<void> {
    await updateSegment(segment.id, current =>
      !current.edited && current.status === segment.status ? {
        ...current, status, text, error: undefined, via, transcribedAt: new Date(now()).toISOString(),
      } : undefined, !keepAudio);
  }
  async function run(id: string, controller: AbortController, dispatchedGeneration: number): Promise<void> {
    const initial = await getSegment(id);
    if (!initial || initial.edited || initial.status !== "pending") {
      if (initial?.status === "failed") failed.add(id);
      return;
    }
    const meeting = await getMeeting(initial.meetingId);
    if (!meeting || disposed) return;
    if (initial.speechMs !== undefined && initial.speechMs < 300) {
      await finish(initial, "empty", "", meeting.keepAudio);
      return;
    }
    const segment = await updateSegment(id, current =>
      current.status === "pending" && !current.edited && !disposed ? { ...current, status: "transcribing", error: undefined } : undefined);
    if (!segment) return;
    try {
      const audio = await getSegmentAudio(id);
      if (!audio) {
        const updated = await updateSegment(id, current =>
          !current.edited && current.status === "transcribing" ? { ...current, status: "failed", error: "audio-missing", hasAudio: false } : undefined);
        if (updated) failed.add(id);
        return;
      }
      if (controller.signal.aborted) throw new AppError("aborted");
      const previous = (await listSegments(segment.meetingId)).filter(s => s.seq < segment.seq).at(-1);
      const result = await opts.transcribe({
        audio, mimeType: segment.mimeType, fileName: segmentFileName(segment.seq, segment.mimeType),
        language: meeting.language, prompt: previous?.status === "done" ? promptTail(previous.text) : "", signal: controller.signal,
      });
      if (controller.signal.aborted) throw new AppError("aborted");
      const text = normalizeTranscript(result.text);
      const empty = !text || isLikelyHallucination(text, segment.speechMs, segment.endMs - segment.startMs);
      await finish(segment, empty ? "empty" : "done", empty ? "" : text, meeting.keepAudio, result.via);
      failed.delete(id);
    } catch (error) {
      const code = error instanceof AppError ? error.code : error instanceof DOMException && error.name === "AbortError" ? "aborted" : undefined;
      const blocking = code !== undefined && BLOCKING_STT_ERRORS.includes(code);
      const aborted = code === "aborted";
      const detail = error instanceof Error ? error.message : "stt-failed";
      const updated = await updateSegment(id, current => {
        if (current.edited || current.status !== "transcribing") return undefined;
        const attempts = current.attempts + (blocking || aborted ? 0 : 1);
        return { ...current, attempts, status: !blocking && !aborted && attempts >= maxAttempts ? "failed" : "pending",
          error: blocking || aborted ? undefined : detail };
      });
      if (!updated) return;
      if (!blocking || dispatchedGeneration === generation) lastError = detail;
      if (blocking && dispatchedGeneration === generation) { paused = true; blockedBy = code; }
      if (updated.status === "failed") failed.add(id);
      else if (!disposed) {
        // Aborted work remains resumable, with no attempt consumed.
        if (aborted && dispatchedGeneration === generation) paused = true;
        const delay = blocking || aborted ? 0 : Math.min(60000, retryBaseMs * 2 ** (updated.attempts - 1));
        waiting.set(id, now() + delay);
      }
    }
  }
  function enqueue(id: string): void {
    if (disposed || !leader || waiting.has(id) || running.has(id)) return;
    failed.delete(id);
    waiting.set(id, now());
    pump();
  }
  async function resumeAll(): Promise<void> {
    if (disposed || !leader) return;
    const meetings = await listMeetings();
    for (const meeting of meetings) {
      for (const segment of await listSegments(meeting.id)) {
        if (disposed || !leader) return;
        if (!meeting.keepAudio && (segment.status === "done" || segment.status === "empty") && segment.hasAudio) {
          await updateSegment(segment.id, current =>
            current.status === "done" || current.status === "empty" ? { ...current } : undefined, true);
        }
        if (segment.status === "failed") failed.add(segment.id);
        else if (segment.status === "pending" && !segment.edited) enqueue(segment.id);
      }
    }
    emit();
  }
  async function retrySegment(id: string): Promise<void> {
    if (disposed || running.has(id)) return;
    const updated = await updateSegment(id, current => !current.edited && current.status !== "transcribing"
      ? { ...current, status: "pending", attempts: 0, error: undefined } : undefined);
    if (updated) {
      failed.delete(id);
      waiting.delete(id);
      enqueue(id);
    }
  }
  if (locks) {
    void locks.request("tc-meeting:queue-leader", { signal: leadershipAbort.signal }, async () => {
      if (disposed) return;
      const held = new Promise<void>(resolve => { releaseLeader = resolve; });
      try {
        await resetTranscribing();
        if (disposed) return;
        leader = true;
        unsubscribeDb = subscribeDb(change => {
          if (change.kind !== "segment" || disposed) return;
          const refresh = async () => {
            if (change.segmentId) {
              const segment = await getSegment(change.segmentId);
              if (segment?.status === "pending" && !segment.edited) enqueue(segment.id);
            } else await resumeAll();
          };
          void refresh().catch(error => { lastError = error instanceof Error ? error.message : "unknown"; emit(); });
        });
        try { await resumeAll(); }
        catch (error) {
          lastError = error instanceof Error ? error.message : "unknown";
          paused = true;
          emit();
        }
        await held;
      } finally { leader = false; unsubscribeDb?.(); }
    }).catch(error => {
      if (disposed) return;
      lastError = error instanceof Error ? error.message : "unknown";
      paused = true;
      emit();
    });
  }
  return {
    enqueue, resumeAll, retrySegment,
    async retryFailed(meetingId) {
      for (const segment of await listSegments(meetingId)) {
        if (segment.status === "failed") await retrySegment(segment.id);
      }
    },
    pause() { if (!disposed) { paused = true; cancelTimer(); emit(); } },
    resume() { if (!disposed) { generation++; paused = false; blockedBy = undefined; lastError = undefined; pump(); } },
    getState,
    subscribe(cb) { listeners.add(cb); cb(getState()); return () => { listeners.delete(cb); }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      leadershipAbort.abort();
      unsubscribeDb?.();
      if (!running.size) releaseLeader?.();
      paused = true;
      cancelTimer();
      waiting.clear();
      for (const controller of running.values()) controller.abort();
      listeners.clear();
    },
  };
}
