import { AppError } from "../types";
import type { AppErrorCode, Locale, Meeting, Segment } from "../types";
import { browserLocks, getMeeting, getSegment, listMeetings, listSegments, subscribeDb, updateMeeting, updateMeetingIfSegments, updateSegment } from "./db";
import type { LockProvider } from "./db";
import { translateChunk } from "./ai/translate";
import { proofreadChunk } from "./ai/proofread";
import { LIVE_NOTES_BATCH_CHARS, updateLiveNotes } from "./ai/liveNotes";
import { subscribeLocalSettings } from "./ai/settings";
import { subscribeLlmConfig } from "@tik-choco/mistai/llm-config";
import { formatClock } from "./format";
import { promptTail } from "./transcript";

export type AssistState = {
  leader: boolean;
  translatePending: number;
  translateActive: number;
  proofreadPending: number;
  proofreadActive: number;
  notesMeetingId: string | null;
  notesDraft: string;
  blockedBy?: AppErrorCode;
  lastError?: string;
};
export interface AssistWorker {
  getState(): AssistState;
  subscribe(cb: (state: AssistState) => void): () => void;
  setLocale(locale: Locale): void;
  retryTranslation(segmentId: string): Promise<void>;
  retryProofread(segmentId: string): Promise<void>;
  rebuildNotes(meetingId: string): Promise<void>;
  retryNotes(meetingId: string): Promise<void>;
  kick(): void;
  dispose(): void;
}
type Retry = { attempts: number; readyAt: number };
type JobKind = "translate" | "proofread";
type SegmentJob = Retry & { kind: JobKind; id: string; meetingId: string; seq: number; source: string; lang: string };
const jobKey = (job: Pick<SegmentJob, "kind" | "id">): string => `${job.kind}:${job.id}`;
type NotesJob = Retry & { meeting: Meeting; segments: Segment[]; throughSeq: number; signature: string; locale: Locale };
const through = (meeting: Meeting): number => meeting.liveNotes?.throughSeq ?? -1;
const detail = (error: unknown): AppErrorCode => errorCode(error) ?? "llm-failed";
const errorCode = (error: unknown): AppErrorCode | undefined => error instanceof AppError ? error.code
  : error instanceof DOMException && error.name === "AbortError" ? "aborted" : undefined;
function needsTranslation(segment: Segment, lang: string): boolean {
  const value = segment.translation;
  return !!lang && segment.status === "done" && !!segment.text.trim()
    && !(value?.source === segment.text && value.lang === lang && (value.error || value.text.trim()));
}
function needsProofread(segment: Segment, enabled: boolean): boolean {
  const value = segment.proofread;
  return enabled && segment.status === "done" && !!segment.text.trim()
    && !(value?.source === segment.text && (value.error || value.text.trim()));
}

export function createAssistWorker(opts: {
  locks?: LockProvider | null;
  translate?: typeof translateChunk;
  proofread?: typeof proofreadChunk;
  updateNotes?: typeof updateLiveNotes;
  locale?: Locale;
  concurrency?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  notesMinNewSegments?: number;
  notesMinNewMs?: number;
  /** Per-attempt deadlines: a stalled request must not hold a slot forever. */
  translateTimeoutMs?: number;
  proofreadTimeoutMs?: number;
  notesTimeoutMs?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): AssistWorker {
  const translate = opts.translate ?? translateChunk;
  const proofread = opts.proofread ?? proofreadChunk;
  const updateNotes = opts.updateNotes ?? updateLiveNotes;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 3) || 3);
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 3) || 3);
  const minSegments = Math.max(1, Math.floor(opts.notesMinNewSegments ?? 2) || 2);
  const minNewMs = Math.max(0, opts.notesMinNewMs ?? 40000);
  const retryBaseMs = Math.max(1, opts.retryBaseMs ?? 2000);
  const translateTimeoutMs = Math.max(1, opts.translateTimeoutMs ?? 90_000);
  const proofreadTimeoutMs = Math.max(1, opts.proofreadTimeoutMs ?? 90_000);
  const notesTimeoutMs = Math.max(1, opts.notesTimeoutMs ?? 240_000);
  const locks = opts.locks === undefined ? browserLocks() : opts.locks;
  const waiting = new Map<string, SegmentJob>();
  const running = new Map<string, { job: SegmentJob; controller: AbortController }>();
  const notesWaiting = new Map<string, NotesJob>();
  const notesFailed = new Map<string, string>();
  const notesRequests = new Map<string, string | undefined>();
  const liveMeetings = new Set<string>();
  // Drain a whole live prefix once it crosses the threshold, including a short last batch.
  const drainThrough = new Map<string, number>();
  const deleted = new Set<string>();
  const dirty = new Map<string, Set<string> | null>();
  const listeners = new Set<(state: AssistState) => void>();
  const leadershipAbort = new AbortController();
  let locale = opts.locale ?? "en";
  let leader = false;
  let disposed = false;
  let halted = false;
  let generation = 0;
  let blockedBy: AppErrorCode | undefined;
  let lastError: string | undefined;
  let notesActive: { job: NotesJob; controller: AbortController } | undefined;
  let notesDraft = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scanning = false;
  let scanAll = false;
  let releaseLeader: (() => void) | undefined;
  let unsubscribeDb: (() => void) | undefined;
  const unsubscribeSettings = subscribeLocalSettings(kick);
  const unsubscribeShared = subscribeLlmConfig(kick);
  const idleState = (): AssistState => ({ leader: false, translatePending: 0, translateActive: 0,
    proofreadPending: 0, proofreadActive: 0, notesMeetingId: null, notesDraft: "" });
  let remoteState: AssistState | undefined;
  let channel: BroadcastChannel | undefined;
  let remoteTimer: ReturnType<typeof setTimeout> | undefined;
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let lastBroadcast = -Infinity;
  let lastStatus = "";
  let pageHidden = false;

  function post(message: unknown): void {
    try { channel?.postMessage(message); } catch { /* Cross-tab status is best effort. */ }
  }
  function broadcast(force = false): void {
    if (!channel || !leader || disposed || pageHidden) return;
    const state = getState();
    const status = JSON.stringify({ ...state, notesDraft: "" });
    if (!force && status === lastStatus && now() - lastBroadcast < 250) {
      broadcastTimer ??= setTimer(() => { broadcastTimer = undefined; broadcast(true); }, 250 - (now() - lastBroadcast));
      return;
    }
    if (broadcastTimer !== undefined) { clearTimer(broadcastTimer); broadcastTimer = undefined; }
    lastStatus = status; lastBroadcast = now(); post({ kind: "state", state });
  }
  function heartbeat(): void {
    if (!channel || disposed || !leader) return;
    broadcast(true);
    heartbeatTimer = setTimer(heartbeat, 5000);
  }
  function pagehide(): void { if (leader) post({ kind: "state", state: idleState() }); pageHidden = true; }
  function pageshow(): void { pageHidden = false; broadcast(true); }
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel("tc-meeting-assist-v1");
      channel.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (disposed || !data || typeof data !== "object") return;
        const message = data as { kind?: string; state?: AssistState };
        if (leader) {
          if (message.kind === "snapshot") broadcast(true);
          if (message.kind === "kick") kick();
        } else if (message.kind === "state" && message.state
          && typeof message.state.translatePending === "number" && typeof message.state.translateActive === "number"
          && (message.state.proofreadPending === undefined || typeof message.state.proofreadPending === "number")
          && (message.state.proofreadActive === undefined || typeof message.state.proofreadActive === "number")
          && (message.state.notesMeetingId === null || typeof message.state.notesMeetingId === "string")
          && typeof message.state.notesDraft === "string") {
          remoteState = { ...message.state, leader: false,
            proofreadPending: message.state.proofreadPending ?? 0, proofreadActive: message.state.proofreadActive ?? 0 };
          if (remoteTimer !== undefined) clearTimer(remoteTimer);
          remoteTimer = setTimer(() => { remoteTimer = undefined; remoteState = undefined; emit(); }, 15000);
          emit();
        }
      };
      post({ kind: "snapshot" });
    } catch { /* Work can continue without a status channel. */ }
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", pageshow);
  }

  function getState(): AssistState {
    if (!leader && !disposed) return remoteState ?? idleState();
    return { leader: leader && !disposed,
      translatePending: [...waiting.values()].filter(job => job.kind === "translate").length,
      translateActive: [...running.values()].filter(({ job }) => job.kind === "translate").length,
      proofreadPending: [...waiting.values()].filter(job => job.kind === "proofread").length,
      proofreadActive: [...running.values()].filter(({ job }) => job.kind === "proofread").length,
      notesMeetingId: notesActive?.job.meeting.id ?? null, notesDraft, blockedBy, lastError };
  }
  function emit(): void {
    for (const cb of listeners) { try { cb(getState()); } catch { /* Observers do not own work. */ } }
    broadcast();
  }
  function cancelTimer(): void {
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
  }
  function releaseIfIdle(): void {
    if (disposed && !running.size && !notesActive) releaseLeader?.();
  }
  function fatal(error: unknown): void {
    if (disposed) return;
    lastError = detail(error); halted = true; cancelTimer(); emit();
  }
  function refresh(id: string, segmentId?: string): void {
    if (disposed || !leader || deleted.has(id)) return;
    if (!segmentId) dirty.set(id, null);
    else if (dirty.get(id) !== null) {
      const ids = dirty.get(id) ?? new Set<string>();
      ids.add(segmentId); dirty.set(id, ids);
    }
    scan();
  }
  function scan(): void {
    if (disposed || !leader || scanning) return;
    scanning = true;
    void (async () => {
      while (!disposed && (scanAll || dirty.size)) {
        if (scanAll) {
          scanAll = false;
          for (const meeting of await listMeetings()) if (!deleted.has(meeting.id)) dirty.set(meeting.id, null);
        }
        const entry = dirty.entries().next().value;
        if (!entry) continue;
        const [id, ids] = entry;
        dirty.delete(id);
        const meeting = await getMeeting(id);
        if (!meeting || deleted.has(id) || disposed) { dropMeeting(id); continue; }
        const segments = await listSegments(id);
        if (disposed || deleted.has(id)) continue;
        if (meeting.status === "recording" || meeting.status === "paused") liveMeetings.add(id);
        else liveMeetings.delete(id);
        if (meeting.liveNotesRequest !== notesRequests.get(id)) {
          if (notesActive?.job.meeting.id === id) notesActive.controller.abort();
          notesWaiting.delete(id); notesFailed.delete(id);
          drainThrough.set(id, terminalPrefix(meeting, segments).at(-1)?.seq ?? through(meeting));
          generation++; halted = false; blockedBy = undefined; lastError = undefined;
        }
        notesRequests.set(id, meeting.liveNotesRequest);
        for (const segment of segments) {
          if (ids && !ids.has(segment.id)) continue;
          for (const kind of ["proofread", "translate"] as const) {
            const key = jobKey({ kind, id: segment.id });
            if (running.has(key)) continue;
            const lang = kind === "translate" ? meeting.assist?.translateTo ?? "" : meeting.language;
            const needed = kind === "translate" ? needsTranslation(segment, lang) : needsProofread(segment, meeting.assist?.proofread === true);
            if (!needed) { waiting.delete(key); continue; }
            const old = waiting.get(key);
            if (old?.source !== segment.text || old.lang !== lang) waiting.set(key, {
              kind, id: segment.id, meetingId: id, seq: segment.seq, source: segment.text, lang, attempts: 0, readyAt: now(),
            });
          }
        }
        if (!ids) for (const [key, job] of waiting) {
          if (job.meetingId === id && !segments.some(s => s.id === job.id)) waiting.delete(key);
        }
        if (notesActive?.job.meeting.id !== id) planNotes(meeting, segments);
      }
    })().catch(fatal).finally(() => {
      scanning = false;
      if (scanAll || dirty.size) scan(); else pump();
    });
  }
  function terminalPrefix(meeting: Meeting, segments: Segment[]): Segment[] {
    const prefix: Segment[] = [];
    let next = through(meeting) + 1;
    for (const segment of segments) {
      if (segment.seq < next) continue;
      if (segment.seq !== next || segment.status === "pending" || segment.status === "transcribing") break;
      prefix.push(segment); next++;
    }
    return prefix;
  }
  function planNotes(meeting: Meeting, segments: Segment[]): void {
    const id = meeting.id;
    if (!meeting.assist?.liveNotes || meeting.liveNotesError) { notesWaiting.delete(id); drainThrough.delete(id); return; }
    const prefix = terminalPrefix(meeting, segments);
    const count = prefix.filter(s => s.status === "done" && s.text.trim()).length;
    const live = ["recording", "paused", "importing"].includes(meeting.status);
    const enough = count >= minSegments && prefix.length > 0 && prefix.at(-1)!.endMs - prefix[0].startMs >= minNewMs;
    if (!prefix.length || (!meeting.liveNotes && !count)
      || (meeting.liveNotes !== undefined && count > 0 && live && !enough && (drainThrough.get(id) ?? -1) < prefix[0].seq)) {
      notesWaiting.delete(id); return;
    }
    if (enough) drainThrough.set(id, prefix.at(-1)!.seq);
    const batch: Segment[] = [];
    let chars = 0;
    for (const segment of prefix) {
      const size = segment.status === "done" && segment.text.trim() ? lineSize(segment) : 0;
      if (chars && chars + size > LIVE_NOTES_BATCH_CHARS) break;
      batch.push(segment); chars += size;
      if (chars >= LIVE_NOTES_BATCH_CHARS) break;
    }
    const signature = JSON.stringify([through(meeting), meeting.liveNotes?.text, meeting.title, locale,
      batch.map(s => [s.seq, s.status, s.text])]);
    if (notesFailed.get(id) === signature) { notesWaiting.delete(id); return; }
    const old = notesWaiting.get(id);
    // A batch that merely grew (same base notes) keeps its retry budget/backoff: new segments
    // arriving during a provider outage must not reset attempts and fire immediate requests.
    const base = JSON.stringify([through(meeting), meeting.liveNotes?.text, meeting.title, locale]);
    const sameBase = old !== undefined && JSON.stringify([through(old.meeting), old.meeting.liveNotes?.text, old.meeting.title, old.locale]) === base;
    if (old?.signature !== signature) notesWaiting.set(id, {
      meeting, segments: batch, throughSeq: batch.at(-1)!.seq, signature, locale,
      attempts: sameBase ? old.attempts : 0, readyAt: sameBase ? old.readyAt : now(),
    });
  }
  function lineSize(segment: Pick<Segment, "startMs" | "text">): number {
    return segment.text.length + formatClock(segment.startMs).length + 4;
  }
  function dropMeeting(id: string): void {
    dirty.delete(id); notesWaiting.delete(id); notesFailed.delete(id); drainThrough.delete(id); notesRequests.delete(id); liveMeetings.delete(id);
    for (const [key, job] of waiting) if (job.meetingId === id) waiting.delete(key);
    for (const { job, controller } of running.values()) if (job.meetingId === id) controller.abort();
    if (notesActive?.job.meeting.id === id) notesActive.controller.abort();
  }
  /** Run one LLM attempt with its own deadline; a timeout becomes a normal (retryable) llm-failed. */
  async function withDeadline<T>(ms: number, outer: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const inner = new AbortController();
    const forward = () => inner.abort(outer.reason);
    if (outer.aborted) inner.abort(outer.reason); else outer.addEventListener("abort", forward, { once: true });
    let timedOut = false;
    const handle = setTimer(() => { timedOut = true; inner.abort(); }, ms);
    try { return await run(inner.signal); }
    catch (error) {
      if (timedOut && !outer.aborted) throw new AppError("llm-failed", "LLM request timed out", { cause: error });
      throw error;
    } finally { clearTimer(handle); outer.removeEventListener("abort", forward); }
  }
  function handleFailure(error: unknown, job: Retry, dispatchedGeneration: number): "retry" | "failed" {
    const code = errorCode(error);
    if (code === "llm-not-configured" || code === "aborted") {
      if (!disposed && dispatchedGeneration === generation) {
        halted = true;
        if (code === "llm-not-configured") blockedBy = code;
        lastError = detail(error);
      }
      job.readyAt = now(); return "retry";
    }
    lastError = detail(error); job.attempts++;
    job.readyAt = now() + Math.min(60000, retryBaseMs * 2 ** (job.attempts - 1));
    return job.attempts >= maxAttempts ? "failed" : "retry";
  }
  async function runSegment(job: SegmentJob, controller: AbortController, dispatchedGeneration: number): Promise<void> {
    const segment = await getSegment(job.id);
    const meeting = await getMeeting(job.meetingId);
    if (controller.signal.aborted || !segment || !meeting || segment.text !== job.source) return;
    if (job.kind === "translate" ? meeting.assist?.translateTo !== job.lang || !needsTranslation(segment, job.lang)
      : meeting.language !== job.lang || !needsProofread(segment, meeting.assist?.proofread === true)) return;
    const previous = (await listSegments(job.meetingId)).filter(s => s.seq < segment.seq && s.status === "done").at(-1);
    let text = "";
    let error: string | undefined;
    try {
      if (controller.signal.aborted) return;
      const context = previous ? promptTail(previous.text, 300) : "";
      text = (await withDeadline(job.kind === "translate" ? translateTimeoutMs : proofreadTimeoutMs, controller.signal,
        signal => job.kind === "translate" ? translate({ text: job.source, targetLang: job.lang, context, signal })
          : proofread({ text: job.source, language: job.lang, context, signal }))).trim();
      if (controller.signal.aborted) return;
      if (!text) throw new AppError("llm-failed");
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (handleFailure(failure, job, dispatchedGeneration) === "retry") { waiting.set(jobKey(job), job); return; }
      error = detail(failure);
    }
    const value = { source: job.source, text, error, at: new Date(now()).toISOString() };
    await updateSegment(job.id, current => !controller.signal.aborted && current.status === "done" && current.text === job.source
      ? job.kind === "translate" ? { ...current, translation: { ...value, lang: job.lang } } : { ...current, proofread: value } : undefined);
  }
  async function runNotes(job: NotesJob, controller: AbortController, dispatchedGeneration: number): Promise<void> {
    const id = job.meeting.id;
    const latest = await getMeeting(id);
    if (!latest || !notesWriteAllowed(latest, job, controller)) return;
    let text = job.meeting.liveNotes?.text ?? "";
    const done = job.segments.filter(s => s.status === "done" && s.text.trim());
    // Oversized edited segments need several calls; commit their seq only after all parts succeed.
    const batches: Pick<Segment, "startMs" | "text">[][] = [];
    let batch: Pick<Segment, "startMs" | "text">[] = [];
    let chars = 0;
    for (const segment of done) {
      const limit = Math.max(1, LIVE_NOTES_BATCH_CHARS - lineSize({ ...segment, text: "" }));
      for (let offset = 0; offset < segment.text.length; offset += limit) {
        const part = { startMs: segment.startMs, text: segment.text.slice(offset, offset + limit) };
        const size = lineSize(part);
        if (chars && chars + size > LIVE_NOTES_BATCH_CHARS) { batches.push(batch); batch = []; chars = 0; }
        batch.push(part); chars += size;
      }
    }
    if (batch.length) batches.push(batch);
    try {
      for (const segments of batches) {
        if (controller.signal.aborted) return;
        const previous = text;
        text = (await withDeadline(notesTimeoutMs, controller.signal, signal => updateNotes({ title: job.meeting.title, previous, segments,
          locale: job.locale, signal, onDelta(full) {
            if (disposed || controller.signal.aborted || notesActive?.job !== job) return;
            notesDraft = full; emit();
          } }))).trim();
        if (controller.signal.aborted) return;
        if (!text) throw new AppError("llm-failed");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (handleFailure(error, job, dispatchedGeneration) === "retry") notesWaiting.set(id, job);
      else {
        if (!await batchUnchanged(job, controller)) return;
        notesFailed.set(id, job.signature);
        await updateMeetingIfSegments(id, job.segments, current => notesWriteAllowed(current, job, controller)
          ? { ...current, liveNotesError: detail(error) } : undefined);
      }
      return;
    }
    // Segments are re-validated inside the same transaction as the notes write (cross-tab edits).
    await updateMeetingIfSegments(id, job.segments, current => notesWriteAllowed(current, job, controller)
      ? { ...current, liveNotesError: undefined, updatedAt: new Date(now()).toISOString(), liveNotes: { text, throughSeq: job.throughSeq,
        segmentCount: (job.meeting.liveNotes?.segmentCount ?? 0) + done.length,
        locale: job.locale, updatedAt: new Date(now()).toISOString() } } : undefined);
  }
  function notesWriteAllowed(current: Meeting, job: NotesJob, controller: AbortController): boolean {
    return !controller.signal.aborted && !!current.assist?.liveNotes
      && current.liveNotesRequest === job.meeting.liveNotesRequest
      && through(current) === through(job.meeting) && current.liveNotes?.text === job.meeting.liveNotes?.text;
  }
  async function batchUnchanged(job: NotesJob, controller: AbortController): Promise<boolean> {
    const latest = await listSegments(job.meeting.id);
    return !controller.signal.aborted && job.segments.every(original => latest.some(current =>
      current.id === original.id && current.seq === original.seq && current.status === original.status && current.text === original.text));
  }
  function pump(): void {
    cancelTimer();
    if (disposed || !leader || halted || scanning) return;
    const ordered = [...waiting.entries()].sort(([, a], [, b]) =>
      Number(liveMeetings.has(b.meetingId)) - Number(liveMeetings.has(a.meetingId))
      || a.meetingId.localeCompare(b.meetingId)
      || (liveMeetings.has(a.meetingId) ? b.seq - a.seq : a.seq - b.seq)
      || Number(a.kind === "translate") - Number(b.kind === "translate"));
    for (const [id, job] of ordered) {
      if (running.size >= concurrency) break;
      if (running.has(id) || job.readyAt > now()) continue;
      waiting.delete(id);
      const controller = new AbortController();
      running.set(id, { job, controller });
      void runSegment(job, controller, generation).catch(fatal).finally(() => {
        running.delete(id); refresh(job.meetingId, job.id); releaseIfIdle(); emit(); pump();
      });
    }
    if (!notesActive) for (const [id, job] of notesWaiting) {
      if (job.readyAt > now()) continue;
      notesWaiting.delete(id);
      const controller = new AbortController();
      notesActive = { job, controller }; notesDraft = "";
      void runNotes(job, controller, generation).catch(fatal).finally(() => {
        notesActive = undefined; notesDraft = ""; refresh(id); releaseIfIdle(); emit(); pump();
      });
      break;
    }
    const times = [...waiting.values()].filter(job => !running.has(jobKey(job)) && running.size < concurrency).map(job => job.readyAt);
    if (!notesActive) times.push(...[...notesWaiting.values()].map(job => job.readyAt));
    if (times.length) timer = setTimer(() => { timer = undefined; pump(); }, Math.max(0, Math.min(...times) - now()));
    emit();
  }
  function kick(): void {
    if (disposed) return;
    if (!leader) post({ kind: "kick" });
    generation++; halted = false; blockedBy = undefined; lastError = undefined; notesFailed.clear();
    if (leader) { scanAll = true; scan(); }
    emit();
  }
  function startLeader(): void {
    if (disposed) return;
    leader = true;
    remoteState = undefined;
    if (remoteTimer !== undefined) { clearTimer(remoteTimer); remoteTimer = undefined; }
    heartbeat();
    unsubscribeDb = subscribeDb(change => {
      if (disposed) return;
      if (change.kind === "meeting-deleted") { deleted.add(change.meetingId); dropMeeting(change.meetingId); emit(); pump(); }
      else {
        deleted.delete(change.meetingId);
        const active = notesActive;
        if (change.kind === "segment" && active?.job.meeting.id === change.meetingId) {
          const original = change.segmentId ? active.job.segments.find(segment => segment.id === change.segmentId) : undefined;
          if (!change.segmentId) active.controller.abort();
          else if (original) {
            // Assist writes touch the same record; only a transcript change invalidates the batch.
            void getSegment(original.id).then(current => {
              if (!current || current.seq !== original.seq || current.status !== original.status || current.text !== original.text) active.controller.abort();
            }, () => active.controller.abort());
          }
        }
        refresh(change.meetingId, change.kind === "segment" ? change.segmentId : undefined);
      }
    });
    scanAll = true; scan(); emit();
  }
  if (locks) {
    void Promise.resolve().then(() => locks.request("tc-meeting:assist-leader", { signal: leadershipAbort.signal }, async () => {
      if (disposed) return;
      const held = new Promise<void>(resolve => { releaseLeader = resolve; });
      try { startLeader(); await held; }
      finally { leader = false; unsubscribeDb?.(); }
    })).catch(fatal);
  } else startLeader();

  async function requestNotes(id: string, rebuild: boolean): Promise<void> {
    if (disposed) return;
    await updateMeeting(id, current => ({ ...current,
      liveNotes: rebuild ? undefined : current.liveNotes, liveNotesError: undefined,
      // Strictly increase even for requests in the same millisecond or from another tab.
      liveNotesRequest: new Date(Math.max(now(), (Date.parse(current.liveNotesRequest ?? "") || 0) + 1)).toISOString(),
    }));
  }
  async function retrySegment(id: string, kind: JobKind): Promise<void> {
    if (disposed) return;
    const key = jobKey({ kind, id });
    running.get(key)?.controller.abort(); waiting.delete(key);
    const segment = await updateSegment(id, current => kind === "translate"
      ? { ...current, translation: undefined } : { ...current, proofread: undefined });
    if (segment) refresh(segment.meetingId, id);
  }

  return {
    getState,
    subscribe(cb) {
      listeners.add(cb); try { cb(getState()); } catch { /* Isolate initial delivery too. */ }
      return () => { listeners.delete(cb); };
    },
    setLocale(value) { if (!disposed && locale !== value) { locale = value; if (leader) { scanAll = true; scan(); } } },
    retryTranslation: id => retrySegment(id, "translate"),
    retryProofread: id => retrySegment(id, "proofread"),
    rebuildNotes: id => requestNotes(id, true),
    retryNotes: id => requestNotes(id, false),
    kick,
    dispose() {
      if (disposed) return;
      if (leader) post({ kind: "state", state: idleState() });
      disposed = true; leadershipAbort.abort(); unsubscribeDb?.(); unsubscribeSettings(); unsubscribeShared(); cancelTimer();
      for (const handle of [remoteTimer, broadcastTimer, heartbeatTimer]) if (handle !== undefined) clearTimer(handle);
      channel?.close();
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", pagehide); window.removeEventListener("pageshow", pageshow);
      }
      waiting.clear(); notesWaiting.clear(); dirty.clear(); listeners.clear();
      for (const { controller } of running.values()) controller.abort();
      notesActive?.controller.abort(); releaseIfIdle();
    },
  };
}

let singleton: AssistWorker | undefined;
/** App-wide worker (lazy); browser locks keep all tabs on one assist dispatcher. */
export function getAssist(): AssistWorker {
  singleton ??= createAssistWorker({});
  return singleton;
}
