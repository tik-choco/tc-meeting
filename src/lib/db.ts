import { AppError } from "../types";
import type { AudioChunk, Meeting, Segment } from "../types";
import { segmentId } from "./ids";
export type DbChange = { kind: "meeting" | "segment" | "meeting-deleted"; meetingId: string; segmentId?: string };
let databaseName = "tc-meeting";
let connection: Promise<IDBDatabase> | undefined;
let channel: BroadcastChannel | undefined;
const listeners = new Set<(change: DbChange) => void>();
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const integer = (v: unknown): v is number => nonnegative(v) && Number.isSafeInteger(v);
const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
function isMeeting(v: unknown): v is Meeting {
  if (!record(v)) return false;
  // Optional assist data must never hide an otherwise valid legacy meeting.
  // Discard malformed additions on reads so consumers can safely use their shapes.
  if (v.liveNotesRequest !== undefined && !date(v.liveNotesRequest)) delete v.liveNotesRequest;
  if (v.liveNotesError !== undefined && typeof v.liveNotesError !== "string") delete v.liveNotesError;
  if (v.assist !== undefined && !(record(v.assist) && typeof v.assist.translateTo === "string"
    && typeof v.assist.liveNotes === "boolean")) delete v.assist;
  if (record(v.assist) && v.assist.proofread !== undefined && typeof v.assist.proofread !== "boolean") delete v.assist.proofread;
  if (v.chunkProfile !== undefined && v.chunkProfile !== "standard" && v.chunkProfile !== "fast") delete v.chunkProfile;
  if (v.liveNotes !== undefined && !(record(v.liveNotes) && typeof v.liveNotes.text === "string"
    && typeof v.liveNotes.throughSeq === "number" && Number.isSafeInteger(v.liveNotes.throughSeq) && v.liveNotes.throughSeq >= -1
    && integer(v.liveNotes.segmentCount) && ["en", "ja", "zh-CN", "zh-TW"].includes(v.liveNotes.locale as string)
    && date(v.liveNotes.updatedAt))) delete v.liveNotes;
  return typeof v.id === "string" && !!v.id && typeof v.title === "string" && date(v.createdAt) && date(v.updatedAt)
    && nonnegative(v.durationMs) && ["recording", "paused", "importing", "stopped", "interrupted"].includes(v.status as string)
    && ["mic", "mic+tab", "file"].includes(v.source as string) && typeof v.language === "string"
    && integer(v.nextSeq) && typeof v.keepAudio === "boolean"
    && (v.summary === undefined || (record(v.summary) && typeof v.summary.text === "string"
      && date(v.summary.createdAt) && integer(v.summary.segmentCount)));
}
function isSegment(v: unknown): v is Segment {
  if (!record(v)) return false;
  if (v.translation !== undefined && !(record(v.translation) && typeof v.translation.lang === "string"
    && typeof v.translation.source === "string" && typeof v.translation.text === "string" && date(v.translation.at)
    && (v.translation.error === undefined || typeof v.translation.error === "string"))) delete v.translation;
  if (v.proofread !== undefined && !(record(v.proofread) && typeof v.proofread.source === "string"
    && typeof v.proofread.text === "string" && date(v.proofread.at)
    && (v.proofread.error === undefined || typeof v.proofread.error === "string"))) delete v.proofread;
  return typeof v.id === "string" && !!v.id && typeof v.meetingId === "string" && !!v.meetingId && integer(v.seq)
    && nonnegative(v.startMs) && nonnegative(v.endMs) && v.endMs >= v.startMs
    && ["pending", "transcribing", "done", "empty", "failed"].includes(v.status as string)
    && typeof v.text === "string" && typeof v.edited === "boolean" && integer(v.attempts)
    && typeof v.mimeType === "string" && typeof v.hasAudio === "boolean"
    && (v.error === undefined || typeof v.error === "string") && (v.speechMs === undefined || nonnegative(v.speechMs))
    && (v.transcribedAt === undefined || date(v.transcribedAt)) && (v.via === undefined || v.via === "api" || v.via === "network");
}
function storageError(error: unknown): unknown {
  return record(error) && error.name === "QuotaExceededError" ? new AppError("storage-full", undefined, { cause: error }) : error;
}
function deliver(change: DbChange): void {
  for (const cb of listeners) { try { cb({ ...change }); } catch { /* Observers cannot roll back a committed write. */ } }
}
function getChannel(): BroadcastChannel | undefined {
  if (!channel && typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel("tc-meeting-db-v1");
      channel.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (record(data) && ["meeting", "segment", "meeting-deleted"].includes(data.kind as string)
          && typeof data.meetingId === "string" && (data.segmentId === undefined || typeof data.segmentId === "string")) deliver(data as DbChange);
      };
    } catch { /* Channels are best effort. */ }
  }
  return channel;
}
function notify(change: DbChange): void {
  deliver(change);
  try { getChannel()?.postMessage(change); } catch { /* Best effort across tabs. */ }
}
export function openDb(): Promise<IDBDatabase> {
  if (!connection) {
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("meetings")) db.createObjectStore("meetings", { keyPath: "id" });
        if (!db.objectStoreNames.contains("segments")) db.createObjectStore("segments", { keyPath: "id" }).createIndex("meetingId", "meetingId");
        if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio");
        if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts");
      };
      request.onerror = () => reject(storageError(request.error));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = undefined; };
        db.onclose = () => { connection = undefined; };
        resolve(db);
      };
    }).catch(error => { connection = undefined; throw error; });
  }
  return connection;
}
// Issue requests synchronously or from IDB request callbacks to keep a transaction alive.
async function transaction<T = void>(stores: string[], mode: IDBTransactionMode,
  work: (tx: IDBTransaction, result: (value: T) => void, abort: (error: unknown) => void) => void): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    let value: T;
    let failure: unknown;
    let tx: IDBTransaction | undefined;
    try {
      tx = db.transaction(stores, mode);
      const active = tx;
      active.oncomplete = () => resolve(value);
      active.onerror = event => { failure ??= (event.target as IDBRequest | null)?.error ?? active.error; };
      active.onabort = () => reject(storageError(failure ?? active.error));
      work(active, result => { value = result; }, error => { failure = error; active.abort(); });
    } catch (error) {
      try { tx?.abort(); } catch { /* Already inactive. */ }
      reject(storageError(error));
    }
  });
}
export async function listMeetings(): Promise<Meeting[]> {
  return transaction<Meeting[]>(["meetings"], "readonly", (tx, result) => {
    const request = tx.objectStore("meetings").getAll();
    request.onsuccess = () => result((request.result as unknown[]).filter(isMeeting).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
  });
}
export async function getMeeting(id: string): Promise<Meeting | undefined> {
  return transaction<Meeting | undefined>(["meetings"], "readonly", (tx, result) => {
    const request = tx.objectStore("meetings").get(id);
    request.onsuccess = () => result(isMeeting(request.result) ? request.result : undefined);
  });
}
export async function putMeeting(meeting: Meeting): Promise<void> {
  await transaction(["meetings"], "readwrite", tx => { tx.objectStore("meetings").put(meeting); });
  notify({ kind: "meeting", meetingId: meeting.id });
}
export async function deleteMeeting(id: string): Promise<void> {
  await transaction(["meetings", "segments", "audio", "drafts"], "readwrite", (tx, _result, abort) => {
    tx.objectStore("meetings").delete(id);
    tx.objectStore("drafts").delete(id);
    const request = tx.objectStore("segments").index("meetingId").openCursor(IDBKeyRange.only(id));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      try {
        tx.objectStore("audio").delete(cursor.primaryKey);
        cursor.delete();
        cursor.continue();
      } catch (error) { abort(error); }
    };
  });
  notify({ kind: "meeting-deleted", meetingId: id });
}
export async function listSegments(meetingId: string): Promise<Segment[]> {
  return transaction<Segment[]>(["segments"], "readonly", (tx, result) => {
    const request = tx.objectStore("segments").index("meetingId").getAll(meetingId);
    request.onsuccess = () => result((request.result as unknown[]).filter(isSegment).sort((a, b) => a.seq - b.seq));
  });
}
export async function getSegment(id: string): Promise<Segment | undefined> {
  return transaction<Segment | undefined>(["segments"], "readonly", (tx, result) => {
    const request = tx.objectStore("segments").get(id);
    request.onsuccess = () => result(isSegment(request.result) ? request.result : undefined);
  });
}
export async function putSegment(segment: Segment): Promise<void> {
  await transaction(["segments"], "readwrite", tx => { tx.objectStore("segments").put(segment); });
  notify({ kind: "segment", meetingId: segment.meetingId, segmentId: segment.id });
}
export async function addSegmentWithAudio(segment: Segment, audio: Blob, finalizeDraft = false): Promise<void> {
  await transaction(["segments", "audio", "drafts", "meetings"], "readwrite", (tx, _result, abort) => {
    tx.objectStore("segments").add({ ...segment, hasAudio: true });
    tx.objectStore("audio").add(audio, segment.id);
    if (finalizeDraft) {
      const draft = tx.objectStore("drafts").get(segment.meetingId);
      draft.onsuccess = () => {
        try {
          if (draft.result && draft.result.startMs <= segment.startMs) tx.objectStore("drafts").delete(segment.meetingId);
        } catch (error) { abort(error); }
      };
      const meeting = tx.objectStore("meetings").get(segment.meetingId);
      meeting.onsuccess = () => {
        try {
          if (!isMeeting(meeting.result)) { abort(new AppError("not-found")); return; }
          tx.objectStore("meetings").put({ ...meeting.result,
            nextSeq: Math.max(meeting.result.nextSeq, segment.seq + 1),
            durationMs: Math.max(meeting.result.durationMs, segment.endMs), updatedAt: new Date().toISOString() });
        } catch (error) { abort(error); }
      };
    }
  });
  notify({ kind: "segment", meetingId: segment.meetingId, segmentId: segment.id });
}
export async function getSegmentAudio(segmentId: string): Promise<Blob | undefined> {
  return transaction<Blob | undefined>(["audio"], "readonly", (tx, result) => {
    const request = tx.objectStore("audio").get(segmentId);
    request.onsuccess = () => result(request.result instanceof Blob ? request.result : undefined);
  });
}
export async function deleteSegmentAudio(segmentId: string): Promise<void> {
  let meetingId: string | undefined;
  await transaction(["segments", "audio"], "readwrite", (tx, _result, abort) => {
    tx.objectStore("audio").delete(segmentId);
    const store = tx.objectStore("segments");
    const request = store.get(segmentId);
    request.onsuccess = () => {
      if (isSegment(request.result)) {
        meetingId = request.result.meetingId;
        try { store.put({ ...request.result, hasAudio: false }); } catch (error) { abort(error); }
      }
    };
  });
  if (meetingId) notify({ kind: "segment", meetingId, segmentId });
}
export async function deleteMeetingAudio(meetingId: string): Promise<void> {
  await transaction(["segments", "audio"], "readwrite", (tx, _result, abort) => {
    const request = tx.objectStore("segments").index("meetingId").openCursor(IDBKeyRange.only(meetingId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      try {
        tx.objectStore("audio").delete(cursor.primaryKey);
        if (isSegment(cursor.value)) cursor.update({ ...cursor.value, hasAudio: false });
        cursor.continue();
      } catch (error) { abort(error); }
    };
  });
  notify({ kind: "segment", meetingId });
}
/** Atomic read/modify/write: an undefined result leaves the record alone. */
export async function updateSegment(id: string, update: (current: Segment) => Segment | undefined, deleteAudio = false): Promise<Segment | undefined> {
  const updated = await transaction<Segment | undefined>(["segments", "audio"], "readwrite", (tx, result, abort) => {
    const store = tx.objectStore("segments");
    const request = store.get(id);
    request.onsuccess = () => {
      if (!isSegment(request.result)) return;
      try {
        const next = update(request.result);
        if (next) {
          if (deleteAudio) { tx.objectStore("audio").delete(id); next.hasAudio = false; }
          store.put(next); result(next);
        }
      } catch (error) { abort(error); }
    };
  });
  if (updated) notify({ kind: "segment", meetingId: updated.meetingId, segmentId: id });
  return updated;
}
/** Preserve concurrent title and summary edits when updating the session timeline. */
export async function updateMeeting(id: string, update: (current: Meeting) => Meeting): Promise<Meeting | undefined> {
  const updated = await transaction<Meeting | undefined>(["meetings"], "readwrite", (tx, result, abort) => {
    const store = tx.objectStore("meetings");
    const request = store.get(id);
    request.onsuccess = () => {
      if (!isMeeting(request.result)) return;
      try { const next = update(request.result); store.put(next); result(next); } catch (error) { abort(error); }
    };
  });
  if (updated) notify({ kind: "meeting", meetingId: id });
  return updated;
}
/** Atomically update a meeting only while the given segments still match (id, seq, status, text):
 * one transaction over both stores, so a concurrent edit in another tab cannot slip in between.
 * Returns undefined (no write) when a segment changed or the update declines. */
export async function updateMeetingIfSegments(id: string, expected: Pick<Segment, "id" | "seq" | "status" | "text">[],
  update: (current: Meeting) => Meeting | undefined): Promise<Meeting | undefined> {
  const updated = await transaction<Meeting | undefined>(["meetings", "segments"], "readwrite", (tx, result, abort) => {
    const segments = tx.objectStore("segments");
    let remaining = expected.length;
    let stale = false;
    const commit = () => {
      if (stale) return;
      const store = tx.objectStore("meetings");
      const request = store.get(id);
      request.onsuccess = () => {
        if (!isMeeting(request.result)) return;
        try { const next = update(request.result); if (next) { store.put(next); result(next); } } catch (error) { abort(error); }
      };
    };
    if (!remaining) { commit(); return; }
    for (const original of expected) {
      const request = segments.get(original.id);
      request.onsuccess = () => {
        const current: unknown = request.result;
        if (!isSegment(current) || current.seq !== original.seq || current.status !== original.status || current.text !== original.text) stale = true;
        if (--remaining === 0) commit();
      };
    }
  });
  if (updated) notify({ kind: "meeting", meetingId: id });
  return updated;
}
/** Injectable browser lock service; null explicitly selects the single-tab fallback. */
export type LockProvider = Pick<LockManager, "request">;
export function browserLocks(): LockProvider | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.locks;
}
export const recordingLockName = (id: string): string => 'tc-meeting:rec:' + id;
export async function acquireRecordingLock(id: string, locks: LockProvider | null | undefined = browserLocks()): Promise<() => void> {
  if (!locks) return () => {};
  return new Promise((resolve, reject) => {
    void locks.request(recordingLockName(id), { ifAvailable: true }, lock => {
      if (!lock) { reject(new AppError("already-recording")); return; }
      return new Promise<void>(release => { resolve(release); });
    }).catch(reject);
  });
}
export async function putDraft(meetingId: string, chunk: AudioChunk): Promise<void> {
  await transaction(["meetings", "drafts"], "readwrite", (tx, _result, abort) => {
    const request = tx.objectStore("meetings").get(meetingId);
    request.onsuccess = () => {
      try { if (isMeeting(request.result)) tx.objectStore("drafts").put(chunk, meetingId); }
      catch (error) { abort(error); }
    };
  });
}
export async function getDraft(meetingId: string): Promise<AudioChunk | undefined> {
  return transaction(["drafts"], "readonly", (tx, result) => {
    const request = tx.objectStore("drafts").get(meetingId);
    request.onsuccess = () => result(request.result);
  });
}
/** Called only while holding queue leadership, or in the single-tab fallback. */
export async function resetTranscribing(): Promise<void> {
  for (const meeting of await listMeetings()) {
    for (const segment of await listSegments(meeting.id)) {
      if (segment.status === "transcribing") await updateSegment(segment.id, current =>
        current.status === "transcribing" ? { ...current, status: "pending" } : undefined);
    }
  }
}
export async function recoverInterrupted(opts: { locks?: LockProvider | null } = {}): Promise<string[]> {
  const locks = opts.locks === undefined ? browserLocks() : opts.locks;
  const ids: string[] = [];
  for (const snapshot of await listMeetings()) {
    const recover = async () => {
      let interrupted = false;
      const changes: DbChange[] = [];
      await transaction(["meetings", "segments", "audio", "drafts"], "readwrite", (tx, _result, abort) => {
        const store = tx.objectStore("meetings");
        const request = store.get(snapshot.id);
        request.onsuccess = () => {
          if (!isMeeting(request.result)) return;
          const meeting = request.result;
          interrupted = ["recording", "paused", "importing"].includes(meeting.status);
          const segments = tx.objectStore("segments").index("meetingId").getAll(meeting.id);
          segments.onsuccess = () => {
            const existing = (segments.result as unknown[]).filter(isSegment);
            const nextSeq = existing.reduce((n, s) => Math.max(n, s.seq + 1), meeting.nextSeq);
            const durationMs = existing.reduce((n, s) => Math.max(n, s.endMs), meeting.durationMs);
            const draft = tx.objectStore("drafts").get(meeting.id);
            draft.onsuccess = () => {
              try {
                let next = { ...meeting, nextSeq, durationMs };
                const chunk = draft.result as AudioChunk | undefined;
                if (chunk && chunk.blob instanceof Blob && chunk.blob.size && chunk.endMs > durationMs) {
                  const id = segmentId(meeting.id, nextSeq);
                  const segment: Segment = { id, meetingId: meeting.id, seq: nextSeq,
                    startMs: chunk.startMs, endMs: chunk.endMs, mimeType: chunk.mimeType, speechMs: chunk.speechMs,
                    status: "pending", text: "", edited: false, attempts: 0, hasAudio: true };
                  tx.objectStore("segments").add(segment);
                  tx.objectStore("audio").add(chunk.blob, id);
                  next = { ...next, nextSeq: nextSeq + 1, durationMs: chunk.endMs };
                  changes.push({ kind: "segment", meetingId: meeting.id, segmentId: id });
                }
                if (chunk) tx.objectStore("drafts").delete(meeting.id);
                if (interrupted || next.nextSeq !== meeting.nextSeq || next.durationMs !== meeting.durationMs) {
                  store.put({ ...next, status: interrupted ? "interrupted" : meeting.status, updatedAt: new Date().toISOString() });
                  changes.push({ kind: "meeting", meetingId: meeting.id });
                }
              } catch (error) { abort(error); }
            };
          };
        };
      });
      changes.forEach(notify);
      if (interrupted) ids.push(snapshot.id);
    };
    // Hold the lock through recovery: a query alone races a new recording.
    if (locks) await locks.request(recordingLockName(snapshot.id), { ifAvailable: true }, async lock => { if (lock) await recover(); });
    else await recover();
  }
  if (!locks) await resetTranscribing();
  return ids;
}
export function subscribeDb(cb: (change: DbChange) => void): () => void {
  listeners.add(cb);
  getChannel();
  return () => { listeners.delete(cb); };
}
/** Isolate test databases without deleting another tab's data. */
export async function __setDbName(name: string): Promise<void> {
  if (connection) { try { (await connection).close(); } catch { /* Failed opening. */ } }
  connection = undefined;
  channel?.close();
  channel = undefined;
  listeners.clear();
  databaseName = name;
}
