/// <reference types="node" />
import "fake-indexeddb/auto";
import { Blob as NativeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../types";
import type { Meeting, Segment, TranscribeResult } from "../types";
import { __setDbName, addSegmentWithAudio, getSegment, getSegmentAudio, putMeeting, putSegment } from "./db";
import { createTranscriptionQueue } from "./queue";
import type { TranscriptionQueue } from "./queue";

const queues: TranscriptionQueue[] = [];
const meeting: Meeting = { id: "m", title: "Meeting", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  status: "stopped", source: "mic", language: "ja", durationMs: 150000, nextSeq: 5, keepAudio: true };
function segment(seq = 0, overrides: Partial<Segment> = {}): Segment {
  return { id: `m:${seq}`, meetingId: "m", seq, startMs: seq * 30000, endMs: (seq + 1) * 30000,
    status: "pending", text: "", edited: false, attempts: 0, mimeType: "audio/wav", hasAudio: true, ...overrides };
}
async function seed(seq = 0, overrides: Partial<Segment> = {}): Promise<void> {
  await addSegmentWithAudio(segment(seq, overrides), new Blob(["audio"], { type: "audio/wav" }));
}
function create(opts: Parameters<typeof createTranscriptionQueue>[0]): TranscriptionQueue {
  const queue = createTranscriptionQueue(opts); queues.push(queue); return queue;
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const ok = (text = "result"): TranscribeResult => ({ text, via: "api" });
async function idle(queue: TranscriptionQueue): Promise<void> {
  await vi.waitFor(() => expect(queue.getState()).toMatchObject({ pending: 0, active: 0 }), { interval: 5 });
}
function scheduler() {
  let clock = 0; let serial = 0;
  const tasks = new Map<number, { fn: () => void; delay: number }>();
  return {
    now: () => clock,
    setTimer: ((fn: () => void, delay: number) => { const id = ++serial; tasks.set(id, { fn, delay }); return id; }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => { tasks.delete(id); }) as unknown as typeof clearTimeout,
    fire() {
      const [id, task] = [...tasks.entries()][0]; tasks.delete(id); clock += task.delay; task.fn(); return task.delay;
    },
    tasks,
  };
}
beforeEach(async () => {
  vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("BroadcastChannel", undefined);
  await __setDbName(`queue-${crypto.randomUUID()}`);
  await putMeeting(meeting);
});
afterEach(async () => {
  for (const queue of queues) queue.dispose();
  await vi.waitFor(() => { for (const queue of queues) expect(queue.getState().active).toBe(0); }, { interval: 5 });
  queues.length = 0;
  await __setDbName(`unused-${crypto.randomUUID()}`);
  vi.unstubAllGlobals();
});

describe("transcription queue", () => {
  it("limits concurrency to two, deduplicates queued and active ids, and preserves sequence context", async () => {
    await seed(0, { status: "done", text: "previous context" });
    for (const seq of [1, 2, 3]) await seed(seq);
    const requests: ReturnType<typeof deferred<TranscribeResult>>[] = [];
    const transcribe = vi.fn(() => { const task = deferred<TranscribeResult>(); requests.push(task); return task.promise; });
    const queue = create({ transcribe });
    queue.enqueue("m:1"); queue.enqueue("m:1"); queue.enqueue("m:2"); queue.enqueue("m:3"); queue.enqueue("m:3");
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2), { interval: 5 });
    expect(queue.getState()).toMatchObject({ active: 2, pending: 1 });
    expect(transcribe.mock.calls[0]).toBeDefined();
    const calls = transcribe.mock.calls as unknown as [{ prompt: string; language: string; fileName: string; mimeType: string; signal: AbortSignal }][];
    expect(calls[0][0]).toMatchObject({ prompt: "previous context", language: "ja", fileName: "segment-000001.wav", mimeType: "audio/wav" });
    expect(calls[1][0].prompt).toBe("");
    requests[1].resolve(ok("second segment"));
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(3), { interval: 5 });
    expect(calls[2][0].prompt).toBe("second segment");
    requests[0].resolve(ok("first segment")); requests[2].resolve(ok("third segment"));
    await idle(queue);
    expect((await getSegment("m:1"))?.text).toBe("first segment");
    expect((await getSegment("m:3"))?.status).toBe("done");
  });
  it("cleans text, marks silence and filler empty, and deletes audio when keepAudio is false", async () => {
    await putMeeting({ ...meeting, keepAudio: false });
    await seed(0, { speechMs: 299 }); await seed(1, { speechMs: 500 }); await seed(2);
    const transcribe = vi.fn().mockResolvedValueOnce(ok("Thanks")).mockResolvedValueOnce(ok("  useful\n words  "));
    const queue = create({ transcribe, concurrency: 1 });
    await queue.resumeAll(); await idle(queue);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(await getSegment("m:0")).toMatchObject({ status: "empty", text: "", hasAudio: false });
    expect(await getSegment("m:1")).toMatchObject({ status: "empty", text: "", hasAudio: false });
    expect(await getSegment("m:2")).toMatchObject({ status: "done", text: "useful words", hasAudio: false, via: "api" });
    for (const seq of [0, 1, 2]) expect(await getSegmentAudio(`m:${seq}`)).toBeUndefined();
  });
  it("pauses on blocking settings errors without consuming attempts, then resumes queued work", async () => {
    await seed(0, { attempts: 2 }); await seed(1);
    const transcribe = vi.fn().mockRejectedValueOnce(new AppError("stt-not-configured")).mockResolvedValue(ok());
    const queue = create({ transcribe, concurrency: 1 });
    const changes = vi.fn(); const unsubscribe = queue.subscribe(changes);
    await queue.resumeAll();
    await vi.waitFor(() => expect(queue.getState()).toMatchObject({ paused: true, blockedBy: "stt-not-configured", active: 0, pending: 2 }), { interval: 5 });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(await getSegment("m:0")).toMatchObject({ status: "pending", attempts: 2 });
    queue.resume(); await idle(queue);
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect((await getSegment("m:0"))?.attempts).toBe(2);
    expect(queue.getState().blockedBy).toBeUndefined();
    expect(changes).toHaveBeenCalled(); unsubscribe();
  });
  it("retries with exponential delays, fails at the attempt limit, and resets an explicit retry", async () => {
    await seed();
    const timers = scheduler();
    const transcribe = vi.fn().mockRejectedValue(new AppError("stt-failed"));
    const queue = create({ transcribe, maxAttempts: 3, ...timers });
    queue.enqueue("m:0");
    await vi.waitFor(async () => { expect(await getSegment("m:0")).toMatchObject({ status: "pending", attempts: 1 }); expect(queue.getState().active).toBe(0); }, { interval: 5 });
    expect(timers.fire()).toBe(2000);
    await vi.waitFor(async () => { expect((await getSegment("m:0"))?.attempts).toBe(2); expect(queue.getState().active).toBe(0); }, { interval: 5 });
    expect(timers.fire()).toBe(4000);
    await idle(queue);
    expect(await getSegment("m:0")).toMatchObject({ status: "failed", attempts: 3, error: "stt-failed" });
    expect(queue.getState().failed).toBe(1);
    transcribe.mockResolvedValue(ok("recovered"));
    await queue.retryFailed("m"); await idle(queue);
    expect(await getSegment("m:0")).toMatchObject({ status: "done", attempts: 0, text: "recovered" });
    expect(queue.getState().failed).toBe(0);
  });
  it("caps retry delay at sixty seconds and clears scheduled retries when disposed", async () => {
    await seed(); const timers = scheduler();
    const queue = create({ transcribe: async () => { throw new AppError("stt-failed"); }, retryBaseMs: 40000, ...timers });
    queue.enqueue("m:0");
    await vi.waitFor(() => expect(timers.tasks.size).toBe(1), { interval: 5 });
    expect(timers.fire()).toBe(40000);
    await vi.waitFor(() => expect(timers.tasks.size).toBe(1), { interval: 5 });
    expect([...timers.tasks.values()][0].delay).toBe(60000);
    queue.dispose(); expect(timers.tasks.size).toBe(0);
  });
  it("never overwrites an edit made while STT is in flight or retries edited segments", async () => {
    await seed(); const task = deferred<TranscribeResult>();
    const transcribe = vi.fn(() => task.promise); const queue = create({ transcribe });
    queue.enqueue("m:0");
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce(), { interval: 5 });
    await putSegment(segment(0, { status: "done", edited: true, text: "user correction" }));
    task.resolve(ok("recognizer output")); await idle(queue);
    await queue.retrySegment("m:0"); queue.enqueue("m:0"); await idle(queue);
    expect(await getSegment("m:0")).toMatchObject({ status: "done", edited: true, text: "user correction" });
    expect(transcribe).toHaveBeenCalledOnce();
  });
  it("preserves edits even when the in-flight request fails", async () => {
    await seed(); const task = deferred<TranscribeResult>();
    const transcribe = vi.fn(() => task.promise); const queue = create({ transcribe }); queue.enqueue("m:0");
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce(), { interval: 5 });
    await putSegment(segment(0, { status: "done", edited: true, text: "edited" }));
    task.reject(new AppError("stt-failed")); await idle(queue);
    expect(await getSegment("m:0")).toMatchObject({ text: "edited", status: "done", attempts: 0 });
  });
  it("fails missing audio without a request and skips records that are not pending", async () => {
    await putSegment(segment()); await seed(1, { status: "done", text: "done" });
    const transcribe = vi.fn(async () => ok()); const queue = create({ transcribe });
    queue.enqueue("m:0"); queue.enqueue("m:1"); queue.enqueue("missing"); await idle(queue);
    expect(await getSegment("m:0")).toMatchObject({ status: "failed", error: "audio-missing" });
    expect(transcribe).not.toHaveBeenCalled();
  });
  it("pauses dispatch explicitly and returns aborted requests to pending without consuming attempts", async () => {
    await seed();
    const transcribe = vi.fn(async () => { throw new AppError("aborted"); });
    const queue = create({ transcribe }); queue.pause(); queue.enqueue("m:0");
    expect(queue.getState()).toMatchObject({ paused: true, active: 0, pending: 1 });
    queue.resume();
    await vi.waitFor(() => expect(queue.getState()).toMatchObject({ paused: true, active: 0, pending: 1 }), { interval: 5 });
    expect(await getSegment("m:0")).toMatchObject({ status: "pending", attempts: 0 });
  });
  it("aborts an active provider on disposal and leaves durable work pending", async () => {
    await seed();
    const transcribe = vi.fn(({ signal }) => new Promise<TranscribeResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new AppError("aborted")), { once: true });
    }));
    const queue = create({ transcribe }); queue.enqueue("m:0");
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce(), { interval: 5 });
    queue.dispose(); await idle(queue);
    expect(await getSegment("m:0")).toMatchObject({ status: "pending", attempts: 0 });
  });
});
