import "fake-indexeddb/auto";
import { Blob as NativeBlob } from "node:buffer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppError } from "../types";
import type { Segment, TranscribeFn } from "../types";
import * as db from "./db";
import { createTranscriptionQueue } from "./queue";
import type { TranscriptionQueue } from "./queue";
import { testLocks } from "./audio/testLocks";

let locks: ReturnType<typeof testLocks>;
const queues: TranscriptionQueue[] = [];
const releases: (() => void)[] = [];
const result = { text: "Meeting speech", via: "api" as const };
const segment = (seq: number, status: Segment["status"] = "pending"): Segment => ({
  id: `m:${seq}`, meetingId: "m", seq, startMs: seq * 10000, endMs: (seq + 1) * 10000,
  status, text: "", edited: false, attempts: 0, mimeType: "audio/wav", hasAudio: true,
});
function queue(transcribe: TranscribeFn) {
  const q = createTranscriptionQueue({ transcribe, locks }); queues.push(q); return q;
}
beforeEach(async () => {
  vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("BroadcastChannel", undefined);
  locks = testLocks();
  await db.__setDbName(`leader-${crypto.randomUUID()}`);
  const date = new Date().toISOString();
  await db.putMeeting({ id: "m", title: "Meeting", createdAt: date, updatedAt: date,
    status: "recording", source: "mic", language: "", durationMs: 0, nextSeq: 0, keepAudio: true });
});
afterEach(async () => {
  for (const q of queues) q.dispose();
  for (const release of releases.splice(0)) release();
  await vi.waitFor(() => { for (const q of queues) expect(q.getState().active).toBe(0); }, { interval: 5 });
  queues.length = 0;
  await db.__setDbName(`closed-${crypto.randomUUID()}`);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("a second tab cannot steal a live recording or an in-flight transcription", async () => {
  releases.push(await db.acquireRecordingLock("m", locks));
  await db.addSegmentWithAudio(segment(0), new Blob(["audio"]));
  const held = new Promise<typeof result>(resolve => releases.push(() => resolve(result)));
  const transcribe = vi.fn(() => held);
  const first = queue(transcribe);
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1), { interval: 5 });
  expect(await db.recoverInterrupted({ locks })).toEqual([]);
  const second = queue(transcribe); second.enqueue("m:0"); await second.resumeAll();
  expect((await db.getMeeting("m"))?.status).toBe("recording");
  expect((await db.getSegment("m:0"))?.status).toBe("transcribing");
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(first.getState().active).toBe(1); expect(second.getState().active).toBe(0);
});

it("leadership transfers automatically, resets abandoned claims, and observes new pending segments", async () => {
  await db.addSegmentWithAudio(segment(0, "transcribing"), new Blob(["abandoned"]));
  const firstTranscribe = vi.fn(async () => result);
  const first = queue(firstTranscribe);
  await vi.waitFor(async () => expect((await db.getSegment("m:0"))?.status).toBe("done"), { interval: 5 });
  const secondTranscribe = vi.fn(async () => result);
  const second = queue(secondTranscribe);
  first.pause();
  await db.addSegmentWithAudio(segment(1), new Blob(["new"]));
  second.enqueue("m:1"); await second.resumeAll();
  expect(secondTranscribe).not.toHaveBeenCalled();
  first.dispose();
  await vi.waitFor(async () => expect((await db.getSegment("m:1"))?.status).toBe("done"), { interval: 5 });
  // No explicit enqueue: the current leader must pick this up from DB changes.
  await db.addSegmentWithAudio(segment(2), new Blob(["notification"]));
  await vi.waitFor(async () => expect((await db.getSegment("m:2"))?.status).toBe("done"), { interval: 5 });
  expect(firstTranscribe).toHaveBeenCalledTimes(1); expect(secondTranscribe).toHaveBeenCalledTimes(2);
});

it("keeps leadership until an aborted dispatch has durably returned its claim", async () => {
  await db.addSegmentWithAudio(segment(0), new Blob(["audio"]));
  let finish!: () => void;
  const firstTranscribe = vi.fn(() => new Promise<typeof result>(resolve => { finish = () => resolve(result); releases.push(finish); }));
  const first = queue(firstTranscribe);
  await vi.waitFor(() => expect(firstTranscribe).toHaveBeenCalledTimes(1), { interval: 5 });
  const secondTranscribe = vi.fn(async () => result); queue(secondTranscribe);
  first.dispose();
  expect(secondTranscribe).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(async () => expect((await db.getSegment("m:0"))?.status).toBe("done"), { interval: 5 });
  expect(secondTranscribe).toHaveBeenCalledTimes(1);
});

it("retries an atomic silence completion failure and sweeps legacy retained terminal audio", async () => {
  await db.updateMeeting("m", m => ({ ...m, keepAudio: false }));
  await db.addSegmentWithAudio({ ...segment(0), speechMs: 0 }, new Blob(["silence"]));
  const original = IDBObjectStore.prototype.delete;
  let fail = true;
  vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, key) {
    if (this.name === "audio" && fail) throw new AppError("storage-full");
    return original.call(this, key);
  });
  const transcribe = vi.fn(async () => result); const q = queue(transcribe);
  await vi.waitFor(() => expect(q.getState().paused).toBe(true), { interval: 5 });
  expect(await db.getSegment("m:0")).toMatchObject({ status: "pending", hasAudio: true });
  fail = false; q.resume();
  await vi.waitFor(async () => expect((await db.getSegment("m:0"))?.status).toBe("empty"), { interval: 5 });
  expect(await db.getSegmentAudio("m:0")).toBeUndefined();
  expect(transcribe).not.toHaveBeenCalled();
  await db.addSegmentWithAudio(segment(1, "done"), new Blob(["legacy"]));
  await db.addSegmentWithAudio(segment(2, "empty"), new Blob(["legacy"]));
  await q.resumeAll();
  expect(await db.getSegmentAudio("m:1")).toBeUndefined();
  expect(await db.getSegmentAudio("m:2")).toBeUndefined();
});
