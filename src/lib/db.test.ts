/// <reference types="node" />
import "fake-indexeddb/auto";
import { Blob as NativeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting, Segment } from "../types";
import { __setDbName, addSegmentWithAudio, deleteMeeting, deleteMeetingAudio, deleteSegmentAudio,
  getMeeting, getSegment, getSegmentAudio, listMeetings, listSegments, openDb, putMeeting, putSegment,
  recoverInterrupted, subscribeDb, updateSegment, putDraft, getDraft, acquireRecordingLock } from "./db";
import { testLocks } from "./audio/testLocks";

function meeting(id = "m", overrides: Partial<Meeting> = {}): Meeting {
  return { id, title: "Meeting", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    status: "stopped", source: "mic", language: "", durationMs: 0, nextSeq: 0, keepAudio: true, ...overrides };
}
function segment(seq = 0, overrides: Partial<Segment> = {}): Segment {
  return { id: `m:${seq}`, meetingId: "m", seq, startMs: seq * 1000, endMs: (seq + 1) * 1000,
    status: "pending", text: "", edited: false, attempts: 0, mimeType: "audio/wav", hasAudio: true, ...overrides };
}
class Channel {
  static instances: Channel[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  name: string;
  postMessage = vi.fn();
  close = vi.fn();
  constructor(name: string) { this.name = name; Channel.instances.push(this); }
}
let name: string;
beforeEach(async () => {
  vi.stubGlobal("Blob", NativeBlob);
  vi.stubGlobal("BroadcastChannel", Channel);
  Channel.instances = [];
  name = `tc-meeting-test-${crypto.randomUUID()}`;
  await __setDbName(name);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await __setDbName(`unused-${crypto.randomUUID()}`);
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error);
  });
  vi.unstubAllGlobals();
});
async function rawWrite(stores: string[], write: (tx: IDBTransaction) => void): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); write(tx);
  });
}

describe("meeting persistence", () => {
  it("round-trips proofreading and profiles while dropping only malformed new fields", async () => {
    const assist = { translateTo: "ja", liveNotes: true, proofread: true };
    const proofread = { source: "original", text: "corrected", at: "2026-01-01T00:00:00Z" };
    await putMeeting(meeting("m", { assist, chunkProfile: "fast" }));
    await putSegment(segment(0, { proofread }));
    expect(await getMeeting("m")).toMatchObject({ assist, chunkProfile: "fast" });
    expect(await getSegment("m:0")).toMatchObject({ proofread });
    for (const malformed of [null, {}, { ...proofread, source: 2 }, { ...proofread, text: false },
      { ...proofread, at: "bad" }, { ...proofread, error: 2 }]) {
      await rawWrite(["meetings", "segments"], tx => {
        tx.objectStore("meetings").put({ ...meeting(), assist: { ...assist, proofread: "true" }, chunkProfile: "unknown" });
        tx.objectStore("segments").put({ ...segment(), proofread: malformed });
      });
      expect(await getMeeting("m")).toEqual(meeting("m", { assist: { translateTo: "ja", liveNotes: true } }));
      expect(await listMeetings()).toHaveLength(1);
      expect(await getSegment("m:0")).toEqual(segment());
      expect(await listSegments("m")).toEqual([segment()]);
    }
    await putMeeting(meeting("m", { assist: { ...assist, proofread: false }, chunkProfile: "standard" }));
    await putSegment(segment(0, { proofread: { ...proofread, text: "", error: "llm-failed" } }));
    expect((await getMeeting("m"))?.assist?.proofread).toBe(false);
    expect((await getSegment("m:0"))?.proofread?.error).toBe("llm-failed");
  });
  it("round-trips assist fields and treats malformed additions as absent without hiding records", async () => {
    const assist = { translateTo: "ja", liveNotes: true };
    const liveNotes = { text: "notes", throughSeq: -1, segmentCount: 0, locale: "en" as const, updatedAt: "2026-01-01T00:00:00Z" };
    const translation = { source: "original", text: "translated", lang: "ja", at: "2026-01-01T00:00:00Z" };
    await putMeeting(meeting("m", { assist, liveNotes }));
    await putSegment(segment(0, { translation }));
    expect(await getMeeting("m")).toMatchObject({ assist, liveNotes });
    expect(await getSegment("m:0")).toMatchObject({ translation });
    await rawWrite(["meetings", "segments"], tx => {
      tx.objectStore("meetings").put({ ...meeting(), assist: { translateTo: 4 }, liveNotes: { text: 7, throughSeq: NaN } });
      tx.objectStore("segments").put({ ...segment(), translation: { text: 5 } });
    });
    expect(await getMeeting("m")).toEqual(meeting());
    expect(await listMeetings()).toEqual([meeting()]);
    expect(await getSegment("m:0")).toEqual(segment());
    expect(await listSegments("m")).toEqual([segment()]);
  });
  it("sorts meetings newest first and segments by sequence, persists actual audio", async () => {
    expect(await openDb()).toBe(await openDb());
    await putMeeting(meeting());
    await putMeeting(meeting("new", { createdAt: "2026-02-01T00:00:00Z" }));
    await addSegmentWithAudio(segment(2), new Blob(["audio"]));
    await putSegment(segment(0));
    expect((await listMeetings()).map(m => m.id)).toEqual(["new", "m"]);
    expect((await listSegments("m")).map(s => s.seq)).toEqual([0, 2]);
    expect(await (await getSegmentAudio("m:2"))?.text()).toBe("audio");
    expect(await getMeeting("missing")).toBeUndefined();
    expect(await getSegment("missing")).toBeUndefined();
  });
  it("skips malformed records and invalid optional fields without throwing", async () => {
    await putMeeting(meeting());
    await putSegment(segment());
    await rawWrite(["meetings", "segments", "audio"], tx => {
      for (const value of [{ id: "bad" }, meeting("bad-date", { createdAt: "bad" }), { ...meeting("summary"), summary: { text: 3 } }]) tx.objectStore("meetings").put(value);
      for (const value of [{ id: "bad", meetingId: "m" }, segment(1, { endMs: -1 }), { ...segment(2), via: "bad" }, { ...segment(3), speechMs: NaN }]) tx.objectStore("segments").put(value);
      tx.objectStore("audio").put({ size: 1, type: "audio/wav" }, "bad");
    });
    expect(await listMeetings()).toEqual([meeting()]);
    expect(await listSegments("m")).toEqual([segment()]);
    expect(await getMeeting("bad")).toBeUndefined();
    expect(await getSegment("bad")).toBeUndefined();
    expect(await getSegmentAudio("bad")).toBeUndefined();
    expect(await recoverInterrupted()).toEqual([]);
  });
  it("rolls back a new segment when the audio write fails in the same transaction", async () => {
    await rawWrite(["audio"], tx => { tx.objectStore("audio").add(new Blob(["original"]), "m:0"); });
    await expect(addSegmentWithAudio(segment(), new Blob(["replacement"]))).rejects.toMatchObject({ name: "ConstraintError" });
    expect(await getSegment("m:0")).toBeUndefined();
    expect(await (await getSegmentAudio("m:0"))?.text()).toBe("original");
  });
  it("maps quota exceptions to the storage-full AppError", async () => {
    await openDb();
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => { throw new DOMException("quota", "QuotaExceededError"); });
    await expect(putMeeting(meeting())).rejects.toMatchObject({ name: "AppError", code: "storage-full" });
  });
  it("preserves quota errors raised inside transaction callbacks and rolls back audio deletion", async () => {
    await addSegmentWithAudio(segment(), new Blob(["audio"]));
    const fail = () => { throw new DOMException("quota", "QuotaExceededError"); };
    const spy = vi.spyOn(IDBObjectStore.prototype, "put");
    spy.mockImplementationOnce(fail);
    await expect(updateSegment("m:0", current => ({ ...current, text: "changed" }))).rejects.toMatchObject({ code: "storage-full" });
    spy.mockImplementationOnce(fail);
    await expect(deleteSegmentAudio("m:0")).rejects.toMatchObject({ code: "storage-full" });
    expect(await getSegmentAudio("m:0")).toBeDefined();
    expect(await getSegment("m:0")).toMatchObject({ hasAudio: true, text: "" });
  });
  it("deletes audio and updates flags atomically, then cascades meeting deletion", async () => {
    await putMeeting(meeting());
    await putMeeting(meeting("other"));
    for (let seq = 0; seq < 3; seq++) await addSegmentWithAudio(segment(seq), new Blob(["audio"]));
    await addSegmentWithAudio(segment(0, { id: "other:0", meetingId: "other" }), new Blob(["other"]));
    await deleteSegmentAudio("m:0");
    expect((await getSegment("m:0"))?.hasAudio).toBe(false);
    expect(await getSegmentAudio("m:0")).toBeUndefined();
    await deleteMeetingAudio("m");
    expect((await listSegments("m")).every(s => !s.hasAudio)).toBe(true);
    expect(await getSegmentAudio("m:2")).toBeUndefined();
    await deleteMeeting("m");
    expect(await listSegments("m")).toEqual([]);
    expect(await getMeeting("m")).toBeUndefined();
    expect(await getSegmentAudio("other:0")).toBeDefined();
  });
  it("recovers live statuses and in-flight jobs, repairing a chunk/meeting crash window", async () => {
    for (const status of ["recording", "paused", "importing", "stopped"] as const) await putMeeting(meeting(status, { status }));
    await putSegment(segment(4, { id: "recording:4", meetingId: "recording", status: "transcribing", attempts: 2 }));
    expect((await recoverInterrupted()).sort()).toEqual(["importing", "paused", "recording"]);
    expect(await getMeeting("recording")).toMatchObject({ status: "interrupted", nextSeq: 5, durationMs: 5000 });
    expect(await getSegment("recording:4")).toMatchObject({ status: "pending", attempts: 2 });
    expect((await getMeeting("stopped"))?.status).toBe("stopped");
    expect(await recoverInterrupted()).toEqual([]);
  });
  it("notifies local and cross-tab observers only after successful writes", async () => {
    const cb = vi.fn(); const unsubscribe = subscribeDb(cb);
    await putMeeting(meeting());
    expect(cb).toHaveBeenCalledWith({ kind: "meeting", meetingId: "m" });
    const channel = Channel.instances[0];
    expect(channel.name).toBe("tc-meeting-db-v1");
    expect(channel.postMessage).toHaveBeenCalledWith({ kind: "meeting", meetingId: "m" });
    channel.onmessage?.({ data: { kind: "segment", meetingId: "other", segmentId: "other:0" } } as MessageEvent);
    expect(cb).toHaveBeenLastCalledWith({ kind: "segment", meetingId: "other", segmentId: "other:0" });
    channel.onmessage?.({ data: { kind: "invalid" } } as MessageEvent);
    expect(cb).toHaveBeenCalledTimes(2);
    unsubscribe();
    await deleteMeeting("m");
    expect(cb).toHaveBeenCalledTimes(2);
  });
  it("works without channels and serializes competing segment updates", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    await putSegment(segment());
    await Promise.all([updateSegment("m:0", current => ({ ...current, text: "edit", edited: true })),
      updateSegment("m:0", current => current.edited ? undefined : { ...current, text: "recognizer" })]);
    expect(await getSegment("m:0")).toMatchObject({ edited: true, text: "edit" });
  });
});

it("upgrades v1 without replacing existing meetings or audio", async () => {
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("meetings", { keyPath: "id" });
      db.createObjectStore("segments", { keyPath: "id" }).createIndex("meetingId", "meetingId");
      db.createObjectStore("audio");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = old.transaction(["meetings", "segments", "audio"], "readwrite");
    tx.objectStore("meetings").put(meeting());
    tx.objectStore("segments").put(segment());
    tx.objectStore("audio").put(new Blob(["old"]), "m:0");
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  old.close();
  expect((await openDb()).version).toBe(2);
  expect((await openDb()).objectStoreNames.contains("drafts")).toBe(true);
  expect(await getMeeting("m")).toEqual(meeting());
  expect(await (await getSegmentAudio("m:0"))?.text()).toBe("old");
});

it("promotes the latest cumulative checkpoint once, with an atomic timeline update", async () => {
  await putMeeting(meeting("m", { status: "recording" }));
  for (const endMs of [4000, 8000, 12000, 16000, 20000, 24000]) {
    await putDraft("m", { startMs: 0, endMs, blob: new Blob([String(endMs)]), mimeType: "audio/webm" });
  }
  expect(await listSegments("m")).toEqual([]);
  expect(await recoverInterrupted()).toEqual(["m"]);
  expect(await getDraft("m")).toBeUndefined();
  expect(await getMeeting("m")).toMatchObject({ status: "interrupted", nextSeq: 1, durationMs: 24000 });
  expect(await listSegments("m")).toMatchObject([{ seq: 0, status: "pending", endMs: 24000, hasAudio: true }]);
  expect(await (await getSegmentAudio("m:000000"))?.text()).toBe("24000");
  await recoverInterrupted(); expect(await listSegments("m")).toHaveLength(1);
});

it("holds the recording lock through recovery and never resets live transcription", async () => {
  const locks = testLocks();
  const release = await acquireRecordingLock("m", locks);
  try {
    await putMeeting(meeting("m", { status: "recording" }));
    await putSegment(segment(0, { status: "transcribing" }));
    await putDraft("m", { startMs: 1000, endMs: 5000, blob: new Blob(["draft"]), mimeType: "audio/webm" });
    expect(await recoverInterrupted({ locks })).toEqual([]);
    expect((await getMeeting("m"))?.status).toBe("recording");
    expect((await getSegment("m:0"))?.status).toBe("transcribing");
    expect(await getDraft("m")).toBeDefined();
    await expect(acquireRecordingLock("m", locks)).rejects.toMatchObject({ code: "already-recording" });
  } finally { release(); }
  await vi.waitFor(async () => expect(await recoverInterrupted({ locks })).toEqual(["m"]), { interval: 5 });
  expect(await listSegments("m")).toHaveLength(2);
});

it("rolls back finalization and retains its draft when any audio write fails", async () => {
  await putMeeting(meeting("m", { status: "recording" }));
  await putDraft("m", { startMs: 0, endMs: 900, blob: new Blob(["draft"]), mimeType: "audio/webm" });
  await rawWrite(["audio"], tx => { tx.objectStore("audio").add(new Blob(["collision"]), "m:0"); });
  await expect(addSegmentWithAudio(segment(), new Blob(["final"]), true)).rejects.toMatchObject({ name: "ConstraintError" });
  expect(await getDraft("m")).toMatchObject({ endMs: 900 });
  expect(await getSegment("m:0")).toBeUndefined();
  expect(await getMeeting("m")).toMatchObject({ nextSeq: 0, durationMs: 0 });
  await deleteSegmentAudio("m:0");
  await addSegmentWithAudio(segment(), new Blob(["final"]), true);
  expect(await getDraft("m")).toBeUndefined();
  expect(await getMeeting("m")).toMatchObject({ nextSeq: 1, durationMs: 1000 });
});

it("does not delete the next recorder's checkpoint when the old stop event is late", async () => {
  await putMeeting(meeting("m", { status: "recording" }));
  await putDraft("m", { startMs: 1000, endMs: 5000, blob: new Blob(["new"]), mimeType: "audio/webm" });
  await addSegmentWithAudio(segment(), new Blob(["old"]), true);
  expect(await getDraft("m")).toMatchObject({ startMs: 1000 });
  await deleteMeeting("m"); expect(await getDraft("m")).toBeUndefined();
});

it("commits terminal status and retention atomically even on a storage failure", async () => {
  await addSegmentWithAudio(segment(), new Blob(["audio"]));
  const original = IDBObjectStore.prototype.delete;
  const spy = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, key) {
    if (this.name === "audio") throw new DOMException("", "QuotaExceededError");
    return original.call(this, key);
  });
  await expect(updateSegment("m:0", s => ({ ...s, status: "done", text: "speech" }), true)).rejects.toMatchObject({ code: "storage-full" });
  expect(await getSegment("m:0")).toMatchObject({ status: "pending", hasAudio: true });
  expect(await getSegmentAudio("m:0")).toBeDefined();
  spy.mockRestore();
  await updateSegment("m:0", s => ({ ...s, status: "done", text: "speech" }), true);
  expect(await getSegment("m:0")).toMatchObject({ status: "done", hasAudio: false });
  expect(await getSegmentAudio("m:0")).toBeUndefined();
});
