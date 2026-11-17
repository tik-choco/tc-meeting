import "fake-indexeddb/auto";
import { Blob as NativeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLlmConfig, saveLlmConfig, LLM_CONFIG_KEY } from "@tik-choco/mistai/llm-config";
import { AppError } from "../types";
import type { Meeting, Segment } from "../types";
import * as db from "./db";
import { createAssistWorker } from "./assist";
import type { AssistWorker } from "./assist";
import { testLocks } from "./audio/testLocks";
import { translateChunk } from "./ai/translate";
import type { proofreadChunk } from "./ai/proofread";
import { updateLiveNotes, LIVE_NOTES_BATCH_CHARS } from "./ai/liveNotes";

const settings = vi.hoisted(() => new Set<() => void>());
vi.mock("./ai/settings", () => ({ subscribeLocalSettings: (cb: () => void) => {
  settings.add(cb); return () => settings.delete(cb);
} }));
vi.mock("./ai/translate", () => ({ translateChunk: vi.fn(async () => "default translation") }));
vi.mock("./ai/proofread", () => ({ proofreadChunk: vi.fn(async () => "default correction") }));
vi.mock("./ai/liveNotes", () => ({ LIVE_NOTES_BATCH_CHARS: 6000, updateLiveNotes: vi.fn(async () => "default notes") }));

const workers: AssistWorker[] = [];
const finishers: (() => void)[] = [];
const date = "2026-01-01T00:00:00Z";
const meeting = (overrides: Partial<Meeting> = {}): Meeting => ({
  id: "m", title: "Meeting", createdAt: date, updatedAt: date, status: "stopped", source: "mic",
  language: "", durationMs: 90000, nextSeq: 3, keepAudio: true,
  assist: { translateTo: "ja", liveNotes: false }, ...overrides,
});
const segment = (seq: number, overrides: Partial<Segment> = {}): Segment => ({
  id: `m:${seq}`, meetingId: "m", seq, startMs: seq * 30000, endMs: (seq + 1) * 30000,
  text: `source ${seq}`, status: "done", edited: false, attempts: 0, mimeType: "audio/wav", hasAudio: false, ...overrides,
});
function deferred() {
  let resolve!: (text: string) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  finishers.push(() => resolve("late result"));
  return { promise, resolve, reject };
}
function create(opts: Parameters<typeof createAssistWorker>[0] = {}): AssistWorker {
  const worker = createAssistWorker({ locks: null, ...opts }); workers.push(worker); return worker;
}
const until = (cb: () => unknown | Promise<unknown>) => vi.waitFor(cb, { interval: 5 });
async function translated(seq: number, text?: string): Promise<void> {
  await until(async () => {
    const value = (await db.getSegment(`m:${seq}`))?.translation;
    expect(value?.text).toBe(text ?? `translated source ${seq}`);
  });
}
function clock() {
  let time = 0; let serial = 0;
  const tasks = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => time,
    setTimer: ((fn: () => void, delay: number) => { const id = ++serial; tasks.set(id, { fn, at: time + delay }); return id; }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => tasks.delete(id)) as unknown as typeof clearTimeout,
    fire() {
      const [id, task] = [...tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      tasks.delete(id); const delay = task.at - time; time = task.at; task.fn(); return delay;
    }, tasks,
  };
}
class TabChannel {
  static peers = new Set<TabChannel>();
  static sent: { sender: TabChannel; data: { kind: string; state?: import("./assist").AssistState } }[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  readonly name: string;
  constructor(name: string) { this.name = name; TabChannel.peers.add(this); }
  postMessage(data: { kind: string }): void {
    TabChannel.sent.push({ sender: this, data: structuredClone(data) });
    for (const peer of TabChannel.peers) if (peer !== this && peer.name === this.name) {
      queueMicrotask(() => { if (!peer.closed) peer.onmessage?.({ data: structuredClone(data) } as MessageEvent); });
    }
  }
  close(): void { this.closed = true; TabChannel.peers.delete(this); }
}
beforeEach(async () => {
  vi.stubGlobal("Blob", NativeBlob);
  vi.stubGlobal("BroadcastChannel", undefined);
  await db.__setDbName(`assist-${crypto.randomUUID()}`);
  await db.putMeeting(meeting());
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const worker of workers) worker.dispose();
  for (const finish of finishers.splice(0)) finish();
  await until(() => {
    for (const worker of workers) expect(worker.getState()).toMatchObject({ translateActive: 0, proofreadActive: 0, notesMeetingId: null });
  });
  workers.length = 0;
  await db.__setDbName(`closed-${crypto.randomUUID()}`);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("translation assist", () => {
  it("dispatches in sequence with two jobs and preceding done source context", async () => {
    for (const seq of [4, 3, 2, 1, 0]) await db.putSegment(segment(seq, seq === 2 ? { status: "empty" } : {}));
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const translate = vi.fn((input: Parameters<typeof translateChunk>[0]) => {
      const gate = deferred(); gates.set(input.text, gate); return gate.promise;
    });
    const worker = create({ translate, concurrency: 2 });
    await until(() => expect(translate).toHaveBeenCalledTimes(2));
    expect(translate.mock.calls.map(([input]) => input.text)).toEqual(["source 0", "source 1"]);
    expect(translate.mock.calls[1][0].context).toBe("source 0");
    expect(worker.getState()).toMatchObject({ translatePending: 2, translateActive: 2 });
    await db.putSegment(segment(0));
    gates.get("source 1")!.resolve("translated source 1");
    await until(() => expect(translate).toHaveBeenCalledTimes(3));
    expect(translate.mock.calls[2][0]).toMatchObject({ text: "source 3", context: "source 1", targetLang: "ja" });
    gates.get("source 0")!.resolve("translated source 0");
    await until(() => expect(translate).toHaveBeenCalledTimes(4));
    gates.get("source 3")!.resolve("translated source 3"); gates.get("source 4")!.resolve("translated source 4");
    await translated(4);
    expect(translate).toHaveBeenCalledTimes(4);
  });
  it("uses the real default function and re-translates a valid translation after an edit", async () => {
    await db.putSegment(segment(0, { translation: { source: "source 0", lang: "ja", text: "old", at: date } }));
    create();
    await db.updateSegment("m:0", current => ({ ...current, text: "edited", edited: true }));
    await translated(0, "default translation");
    expect(translateChunk).toHaveBeenCalledWith(expect.objectContaining({ text: "edited" }));
    expect(await db.getSegment("m:0")).toMatchObject({ edited: true, translation: { source: "edited" } });
  });
  it("guards a result when the source changes mid-flight and then translates the new source", async () => {
    await db.putSegment(segment(0));
    const first = deferred(); const second = deferred();
    const translate = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    create({ translate });
    await until(() => expect(translate).toHaveBeenCalledTimes(1));
    await db.updateSegment("m:0", current => ({ ...current, text: "new source", edited: true }));
    first.resolve("stale result");
    await until(() => expect(translate).toHaveBeenCalledTimes(2));
    expect((await db.getSegment("m:0"))?.translation).toBeUndefined();
    second.resolve("fresh result"); await translated(0, "fresh result");
    expect((await db.getSegment("m:0"))?.translation?.source).toBe("new source");
  });
  it("refreshes changed targets and preserves audio during translation writes", async () => {
    await db.addSegmentWithAudio(segment(0), new Blob(["audio"]));
    const translate = vi.fn(async (input: Parameters<typeof translateChunk>[0]) => input.targetLang);
    create({ translate }); await translated(0, "ja");
    await db.updateMeeting("m", current => ({ ...current, assist: { translateTo: "en", liveNotes: false } }));
    await translated(0, "en");
    expect((await db.getSegment("m:0"))?.hasAudio).toBe(true);
    expect(await db.getSegmentAudio("m:0")).toBeDefined();
  });
  it("retries with backoff, persists the terminal error, and supports explicit retry", async () => {
    await db.putSegment(segment(0));
    const timers = clock();
    const translate = vi.fn().mockRejectedValue(new AppError("llm-failed"));
    const worker = create({ translate, retryBaseMs: 100, ...timers });
    await until(() => expect(timers.tasks.size).toBe(1)); expect(timers.fire()).toBe(100);
    await until(() => expect(translate).toHaveBeenCalledTimes(2));
    await until(() => expect(timers.tasks.size).toBe(1)); expect(timers.fire()).toBe(200);
    await until(async () => expect((await db.getSegment("m:0"))?.translation).toMatchObject({
      source: "source 0", lang: "ja", text: "", error: "llm-failed",
    }));
    expect(translate).toHaveBeenCalledTimes(3);
    translate.mockResolvedValue("retried");
    await worker.retryTranslation("m:0"); await translated(0, "retried");
    expect((await db.getSegment("m:0"))?.translation?.error).toBeUndefined();
  });
  it.each(["kick", "settings", "shared-save", "shared-storage"])("blocks without consuming an attempt and resumes on %s", async trigger => {
    await db.putSegment(segment(0));
    const translate = vi.fn().mockRejectedValueOnce(new AppError("llm-not-configured")).mockResolvedValue("ready");
    const worker = create({ translate, maxAttempts: 1 });
    await until(() => expect(worker.getState().blockedBy).toBe("llm-not-configured"));
    expect((await db.getSegment("m:0"))?.translation).toBeUndefined();
    await db.putSegment(segment(1));
    expect(translate).toHaveBeenCalledTimes(1);
    if (trigger === "kick") worker.kick();
    else if (trigger === "settings") for (const cb of settings) cb();
    else if (trigger === "shared-save") saveLlmConfig(emptyLlmConfig());
    else window.dispatchEvent(new StorageEvent("storage", { key: LLM_CONFIG_KEY }));
    await translated(0, "ready"); await translated(1, "ready");
    expect(worker.getState().blockedBy).toBeUndefined();
  });
  it("a late blocking error cannot block a newer kick generation", async () => {
    await db.putSegment(segment(0));
    const gate = deferred();
    const translate = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue("ready");
    const worker = create({ translate, maxAttempts: 1 });
    await until(() => expect(translate).toHaveBeenCalledTimes(1));
    worker.kick(); gate.reject(new AppError("llm-not-configured"));
    await translated(0, "ready"); expect(worker.getState().blockedBy).toBeUndefined();
  });
  it("only the leader works, holding its lock until disposed in-flight work settles", async () => {
    const locks = testLocks(); await db.putSegment(segment(0));
    const gate = deferred(); const firstTranslate = vi.fn(() => gate.promise);
    const first = create({ locks, translate: firstTranslate });
    await until(() => expect(firstTranslate).toHaveBeenCalledTimes(1));
    const nextTranslate = vi.fn(async () => "successor");
    const second = create({ locks, translate: nextTranslate });
    second.kick(); first.dispose();
    expect(firstTranslate.mock.calls).toHaveLength(1); expect(nextTranslate).not.toHaveBeenCalled();
    gate.resolve("aborted result");
    await translated(0, "successor");
    expect(second.getState().leader).toBe(true); expect(nextTranslate).toHaveBeenCalledTimes(1);
    await db.putSegment(segment(1)); await translated(1, "successor");
  });
  it("swallows observer errors and storage failures halt until kick", async () => {
    await db.putSegment(segment(0));
    const worker = create();
    worker.subscribe(() => { throw new Error("observer"); });
    const original = IDBObjectStore.prototype.put;
    let fail = true;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "segments" && fail) throw new AppError("storage-full");
      return original.call(this, value, key);
    });
    await until(() => expect(worker.getState().lastError).toBe("storage-full"));
    expect(translateChunk).toHaveBeenCalledTimes(1);
    fail = false; worker.kick(); await translated(0, "default translation");
  });
  it("drops deleted meetings and aborts their in-flight calls", async () => {
    await db.putSegment(segment(0));
    const gate = deferred(); const translate = vi.fn((_input: Parameters<typeof translateChunk>[0]) => gate.promise);
    const worker = create({ translate });
    await until(() => expect(translate).toHaveBeenCalledTimes(1));
    await db.deleteMeeting("m");
    expect(translate.mock.calls[0][0].signal?.aborted).toBe(true);
    gate.resolve("discarded");
    await until(() => expect(worker.getState()).toMatchObject({ translatePending: 0, translateActive: 0 }));
    expect(await db.getMeeting("m")).toBeUndefined(); expect(await db.getSegment("m:0")).toBeUndefined();
  });
});

describe("proofread assist", () => {
  beforeEach(async () => {
    await db.putMeeting(meeting({ language: "en", assist: { translateTo: "", liveNotes: false, proofread: true } }));
  });
  it("persists corrections, redoes edited text, and rejects a stale in-flight result", async () => {
    await db.putSegment(segment(0));
    const first = deferred(); const stale = deferred(); const fresh = deferred();
    const proofread = vi.fn<typeof proofreadChunk>().mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    create({ proofread });
    await until(() => expect(proofread).toHaveBeenCalledTimes(1));
    expect(proofread.mock.calls[0][0]).toMatchObject({ text: "source 0", language: "en", context: "" });
    first.resolve("corrected");
    await until(async () => expect((await db.getSegment("m:0"))?.proofread).toMatchObject({ source: "source 0", text: "corrected" }));
    await db.updateSegment("m:0", current => ({ ...current, text: "edited", edited: true }));
    await until(() => expect(proofread).toHaveBeenCalledTimes(2));
    await db.updateSegment("m:0", current => ({ ...current, text: "edited again" }));
    stale.resolve("discarded");
    await until(() => expect(proofread).toHaveBeenCalledTimes(3));
    expect((await db.getSegment("m:0"))?.proofread?.text).toBe("corrected");
    fresh.resolve("fresh correction");
    await until(async () => expect(await db.getSegment("m:0")).toMatchObject({ edited: true, text: "edited again",
      proofread: { source: "edited again", text: "fresh correction" } }));
  });
  it("uses the preceding done source tail and skips disabled, blank and terminal results", async () => {
    const context = "a".repeat(400);
    await db.putSegment(segment(0, { text: context, proofread: { source: context, text: context, at: date } }));
    await db.putSegment(segment(1, { status: "empty" }));
    await db.putSegment(segment(2));
    await db.putSegment(segment(3, { text: "  " }));
    await db.putSegment(segment(4, { status: "pending" }));
    await db.putSegment(segment(5, { proofread: { source: "source 5", text: "", error: "llm-failed", at: date } }));
    const proofread = vi.fn<typeof proofreadChunk>(async () => "corrected");
    create({ proofread });
    await until(async () => expect((await db.getSegment("m:2"))?.proofread?.text).toBe("corrected"));
    expect(proofread).toHaveBeenCalledTimes(1);
    expect(proofread.mock.calls[0][0]).toMatchObject({ text: "source 2", context: "a".repeat(300), language: "en" });
    await db.updateMeeting("m", current => ({ ...current, assist: { ...current.assist!, proofread: false } }));
    await db.putSegment(segment(6));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(proofread).toHaveBeenCalledTimes(1);
  });
  it("backs off, persists exhausted errors, and retries only proofreading", async () => {
    const translation = { source: "source 0", lang: "ja", text: "saved", at: date };
    await db.putSegment(segment(0, { translation }));
    const timers = clock();
    const proofread = vi.fn<typeof proofreadChunk>().mockRejectedValue(new AppError("llm-failed"));
    const worker = create({ proofread, retryBaseMs: 100, ...timers });
    await until(() => expect(timers.tasks.size).toBe(1)); expect(timers.fire()).toBe(100);
    await until(() => expect(proofread).toHaveBeenCalledTimes(2));
    await until(() => expect(timers.tasks.size).toBe(1)); expect(timers.fire()).toBe(200);
    await until(async () => expect((await db.getSegment("m:0"))?.proofread).toMatchObject({ source: "source 0", text: "", error: "llm-failed" }));
    expect(proofread).toHaveBeenCalledTimes(3);
    worker.kick();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(proofread).toHaveBeenCalledTimes(3);
    proofread.mockResolvedValue("retried correction");
    await worker.retryProofread("m:0");
    await until(async () => expect((await db.getSegment("m:0"))?.proofread?.text).toBe("retried correction"));
    expect((await db.getSegment("m:0"))?.proofread?.error).toBeUndefined();
    expect((await db.getSegment("m:0"))?.translation).toEqual(translation);
  });
  it.each(["proofread", "translate"] as const)("preserves both concurrent results when %s finishes first", async first => {
    await db.putMeeting(meeting({ assist: { translateTo: "ja", proofread: true, liveNotes: false } }));
    await db.addSegmentWithAudio(segment(0, { hasAudio: true }), new Blob(["audio"]));
    const gates = { proofread: deferred(), translate: deferred() };
    const proofread = vi.fn(() => gates.proofread.promise); const translate = vi.fn(() => gates.translate.promise);
    const worker = create({ proofread, translate });
    await until(() => expect(worker.getState()).toMatchObject({ proofreadActive: 1, translateActive: 1 }));
    gates[first].resolve(first === "proofread" ? "correction" : "translation");
    await until(async () => expect((await db.getSegment("m:0"))?.[first === "proofread" ? "proofread" : "translation"]?.text)
      .toBe(first === "proofread" ? "correction" : "translation"));
    const second = first === "proofread" ? "translate" : "proofread";
    gates[second].resolve(second === "proofread" ? "correction" : "translation");
    await until(async () => expect(await db.getSegment("m:0")).toMatchObject({ text: "source 0", hasAudio: true,
      proofread: { source: "source 0", text: "correction" }, translation: { source: "source 0", text: "translation" } }));
    expect(await db.getSegmentAudio("m:0")).toBeDefined();
  });
  it("shares three default slots and counts each job kind separately", async () => {
    await db.putMeeting(meeting({ assist: { translateTo: "ja", proofread: true, liveNotes: false } }));
    for (const seq of [0, 1, 2]) await db.putSegment(segment(seq));
    const gate = deferred();
    const proofread = vi.fn(() => gate.promise); const translate = vi.fn(() => gate.promise);
    const worker = create({ proofread, translate });
    await until(() => expect(proofread).toHaveBeenCalledTimes(2));
    expect(translate).toHaveBeenCalledTimes(1);
    expect(worker.getState()).toMatchObject({ proofreadActive: 2, proofreadPending: 1, translateActive: 1, translatePending: 2 });
    gate.resolve("result");
    await until(() => expect(worker.getState()).toMatchObject({ proofreadActive: 0, proofreadPending: 0, translateActive: 0, translatePending: 0 }));
  });
  it("orders live jobs newest first, proofreading before translation, then stopped jobs in sequence", async () => {
    const assist = { translateTo: "ja", proofread: true, liveNotes: false };
    await db.putMeeting(meeting({ assist }));
    await db.putMeeting(meeting({ id: "z", status: "recording", assist }));
    for (const seq of [0, 1]) {
      await db.putSegment(segment(seq));
      await db.putSegment(segment(seq, { id: `z:${seq}`, meetingId: "z", text: `live ${seq}` }));
    }
    const calls: string[] = [];
    const proofread = vi.fn<typeof proofreadChunk>(async input => { calls.push(`proofread:${input.text}`); return "correction"; });
    const translate = vi.fn<typeof translateChunk>(async input => { calls.push(`translate:${input.text}`); return "translation"; });
    create({ proofread, translate, concurrency: 1 });
    await until(() => expect(calls).toHaveLength(8));
    expect(calls).toEqual(["proofread:live 1", "translate:live 1", "proofread:live 0", "translate:live 0",
      "proofread:source 0", "translate:source 0", "proofread:source 1", "translate:source 1"]);
  });
  it("blocks the shared pool without consuming attempts and resumes on settings changes", async () => {
    await db.putMeeting(meeting({ assist: { translateTo: "ja", proofread: true, liveNotes: false } }));
    await db.putSegment(segment(0));
    const proofread = vi.fn<typeof proofreadChunk>().mockRejectedValueOnce(new AppError("llm-not-configured")).mockResolvedValue("ready");
    const translate = vi.fn(async () => "translation");
    const worker = create({ proofread, translate, concurrency: 1, maxAttempts: 1 });
    await until(() => expect(worker.getState().blockedBy).toBe("llm-not-configured"));
    expect(translate).not.toHaveBeenCalled();
    expect((await db.getSegment("m:0"))?.proofread).toBeUndefined();
    for (const cb of settings) cb();
    await until(async () => expect((await db.getSegment("m:0"))?.proofread?.text).toBe("ready"));
    await translated(0, "translation");
    expect(worker.getState().blockedBy).toBeUndefined();
  });
  it("times out stalled proofreading and retries an empty response as a failure", async () => {
    await db.putSegment(segment(0));
    const proofread = vi.fn<typeof proofreadChunk>().mockImplementationOnce(input => new Promise((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(new AppError("aborted")));
    })).mockResolvedValueOnce("  ").mockResolvedValue("recovered");
    create({ proofread, proofreadTimeoutMs: 20, retryBaseMs: 1 });
    await until(async () => expect((await db.getSegment("m:0"))?.proofread?.text).toBe("recovered"));
    expect(proofread).toHaveBeenCalledTimes(3);
    expect(proofread.mock.calls[0][0].signal?.aborted).toBe(true);
  });
  it("keeps in-flight notes alive when proofreading and translation write the same segment", async () => {
    await db.putMeeting(meeting({ assist: { translateTo: "ja", proofread: true, liveNotes: true } }));
    await db.putSegment(segment(0));
    const notes = deferred(); const correction = deferred(); const translation = deferred();
    const updateNotes = vi.fn<typeof updateLiveNotes>(() => notes.promise);
    create({ proofread: () => correction.promise, translate: () => translation.promise, updateNotes });
    await until(() => expect(updateNotes).toHaveBeenCalledTimes(1));
    correction.resolve("correction"); translation.resolve("translation");
    await until(async () => expect(await db.getSegment("m:0")).toMatchObject({ proofread: { text: "correction" }, translation: { text: "translation" } }));
    expect(updateNotes.mock.calls[0][0].signal?.aborted).toBe(false);
    notes.resolve("notes");
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.text).toBe("notes"));
    expect(updateNotes).toHaveBeenCalledTimes(1);
  });
  it("broadcasts proofreading counts to followers and accepts older snapshots without them", async () => {
    vi.stubGlobal("BroadcastChannel", TabChannel);
    const locks = testLocks();
    await db.putSegment(segment(0)); await db.putSegment(segment(1));
    const gate = deferred(); const proofread = vi.fn(() => gate.promise);
    create({ locks, proofread, concurrency: 1 });
    const followerProofread = vi.fn(); const follower = create({ locks, proofread: followerProofread });
    await until(() => expect(follower.getState()).toMatchObject({ leader: false, proofreadActive: 1, proofreadPending: 1,
      translateActive: 0, translatePending: 0 }));
    expect(followerProofread).not.toHaveBeenCalled();
    const peer = [...TabChannel.peers].find(channel => channel.name === "tc-meeting-assist-v1")!;
    // Deliver an older leader's state directly; missing new counts default to zero.
    for (const channel of TabChannel.peers) if (channel !== peer && channel.name === peer.name) channel.onmessage?.({ data: {
      kind: "state", state: { leader: true, translateActive: 2, translatePending: 3, notesMeetingId: null, notesDraft: "" },
    } } as MessageEvent);
    expect(follower.getState()).toMatchObject({ translateActive: 2, translatePending: 3, proofreadActive: 0, proofreadPending: 0 });
    gate.resolve("correction");
    await until(() => expect(follower.getState()).toMatchObject({ proofreadActive: 0, proofreadPending: 0, translateActive: 0, translatePending: 0 }));
  });
});

describe("live notes", () => {
  beforeEach(async () => { await db.putMeeting(meeting({ assist: { translateTo: "", liveNotes: true } })); });
  it.each(["recording", "paused", "importing"] as const)("gates fast chunks on elapsed prefix duration while %s, retaining first and stop flushes", async status => {
    await db.putMeeting(meeting({ status, assist: { translateTo: "", liveNotes: true } }));
    const fast = (seq: number) => segment(seq, { startMs: seq * 10000, endMs: (seq + 1) * 10000 });
    await db.putSegment(fast(0));
    create();
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.throughSeq).toBe(0));
    for (const seq of [1, 2, 3]) await db.putSegment(fast(seq));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(updateLiveNotes).toHaveBeenCalledTimes(1);
    // The new terminal prefix is [10s, 50s]; only its final chunk reaches 40s.
    await db.putSegment(fast(4));
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes).toMatchObject({ throughSeq: 4, segmentCount: 5 }));
    expect(updateLiveNotes).toHaveBeenCalledTimes(2);
    await db.putSegment(fast(5));
    await db.updateMeeting("m", current => ({ ...current, status: "stopped" }));
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.throughSeq).toBe(5));
    expect(updateLiveNotes).toHaveBeenCalledTimes(3);
  });
  it("requires the done count as well as duration and honors a custom duration gate", async () => {
    await db.putMeeting(meeting({ status: "recording", assist: { translateTo: "", liveNotes: true }, liveNotes: {
      text: "saved", throughSeq: 0, segmentCount: 1, locale: "en", updatedAt: date,
    } }));
    await db.putSegment(segment(1, { startMs: 10000, endMs: 20000 }));
    await db.putSegment(segment(2, { startMs: 20000, endMs: 30000, status: "empty", text: "" }));
    create({ notesMinNewMs: 20000 });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(updateLiveNotes).not.toHaveBeenCalled();
    await db.putSegment(segment(3, { startMs: 30000, endMs: 35000 }));
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes).toMatchObject({ throughSeq: 3, segmentCount: 3 }));
    expect(updateLiveNotes).toHaveBeenCalledTimes(1);
  });
  it.each(["recording", "paused", "importing"] as const)("flushes first notes immediately while %s, then waits for two or stop", async status => {
    await db.putMeeting(meeting({ status, assist: { translateTo: "", liveNotes: true } }));
    await db.putSegment(segment(0));
    create();
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes).toMatchObject({ throughSeq: 0, segmentCount: 1 }));
    expect(updateLiveNotes).toHaveBeenCalledTimes(1);
    await db.putSegment(segment(1));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(updateLiveNotes).toHaveBeenCalledTimes(1);
    await db.putSegment(segment(2));
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes).toMatchObject({ throughSeq: 2, segmentCount: 3 }));
    await db.putSegment(segment(3));
    await db.updateMeeting("m", current => ({ ...current, status: "stopped" }));
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes).toMatchObject({ throughSeq: 3, segmentCount: 4 }));
    expect(updateLiveNotes).toHaveBeenCalledTimes(3);
    expect((await db.getMeeting("m"))?.updatedAt).not.toBe(date);
  });
  it("stops at the first pending segment and advances across empty and failed segments", async () => {
    await db.putSegment(segment(0)); await db.putSegment(segment(1, { status: "pending" }));
    await db.putSegment(segment(2)); await db.putSegment(segment(3, { status: "empty", text: "" }));
    await db.putSegment(segment(4, { status: "failed", text: "" }));
    create();
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.throughSeq).toBe(0));
    expect(updateLiveNotes).toHaveBeenCalledTimes(1);
    await db.updateSegment("m:1", current => ({ ...current, status: "empty", text: "" }));
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes).toMatchObject({ throughSeq: 4, segmentCount: 2 }));
    expect(vi.mocked(updateLiveNotes).mock.calls[1][0].segments.map(s => s.text)).toEqual(["source 2"]);
  });
  it("folds a live prefix in bounded batches and drains the last short batch", async () => {
    await db.putMeeting(meeting({ status: "recording", assist: { translateTo: "", liveNotes: true } }));
    for (let seq = 0; seq < 3; seq++) await db.putSegment(segment(seq, { text: String(seq).repeat(3500) }));
    const updateNotes = vi.fn(async (input: Parameters<typeof updateLiveNotes>[0]) => input.previous + input.segments[0].text[0]);
    create({ updateNotes });
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes).toMatchObject({ throughSeq: 2, text: "012", segmentCount: 3 }));
    expect(updateNotes).toHaveBeenCalledTimes(3);
    for (const [input] of updateNotes.mock.calls) expect(input.segments.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(LIVE_NOTES_BATCH_CHARS);
  });
  it("splits oversized edited source without losing text or double counting the segment", async () => {
    const text = "x".repeat(LIVE_NOTES_BATCH_CHARS * 2 + 100);
    await db.putSegment(segment(0, { text }));
    const updateNotes = vi.fn(async (input: Parameters<typeof updateLiveNotes>[0]) => input.previous + "part");
    create({ updateNotes });
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes).toMatchObject({ throughSeq: 0, segmentCount: 1 }));
    expect(updateNotes).toHaveBeenCalledTimes(3);
    expect(updateNotes.mock.calls.flatMap(([input]) => input.segments.map(s => s.text)).join("")).toBe(text);
    expect(updateNotes.mock.calls.every(([input]) => input.segments[0].text.length < LIVE_NOTES_BATCH_CHARS)).toBe(true);
  });
  it("streams drafts and discards an optimistic write that lost a race", async () => {
    await db.putSegment(segment(0)); const gate = deferred();
    const updateNotes = vi.fn((input: Parameters<typeof updateLiveNotes>[0]) => { input.onDelta?.("draft"); return gate.promise; });
    const worker = create({ updateNotes });
    await until(() => expect(worker.getState()).toMatchObject({ notesMeetingId: "m", notesDraft: "draft" }));
    await db.updateMeeting("m", current => ({ ...current, title: "new title", liveNotes: {
      text: "winner", throughSeq: 0, segmentCount: 1, locale: "ja", updatedAt: date,
    } }));
    gate.resolve("loser");
    await until(() => expect(worker.getState()).toMatchObject({ notesMeetingId: null, notesDraft: "" }));
    expect(await db.getMeeting("m")).toMatchObject({ title: "new title", liveNotes: { text: "winner" } });
  });
  it("preserves a different-locale prefix and folds the next text in the new locale", async () => {
    await db.putMeeting(meeting({ assist: { translateTo: "", liveNotes: true }, liveNotes: {
      text: "old notes", throughSeq: 0, segmentCount: 1, locale: "ja", updatedAt: date,
    } }));
    await db.putSegment(segment(0)); await db.putSegment(segment(1));
    create({ locale: "en" });
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes).toMatchObject({ throughSeq: 1, locale: "en" }));
    expect(updateLiveNotes).toHaveBeenCalledWith(expect.objectContaining({ previous: "old notes", locale: "en", segments: [expect.objectContaining({ text: "source 1" })] }));
  });
  it("rebuild clears notes, aborts the old draft, and refolds from scratch", async () => {
    await db.putSegment(segment(0));
    const gate = deferred();
    const updateNotes = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue("rebuilt");
    const worker = create({ updateNotes });
    await until(() => expect(updateNotes).toHaveBeenCalledTimes(1));
    await worker.rebuildNotes("m"); gate.resolve("discarded");
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.text).toBe("rebuilt"));
    expect(updateNotes.mock.calls[1][0]).toMatchObject({ previous: "", segments: [{ text: "source 0" }] });
  });
  it("an explicit rebuild refolds an existing short recording in the current locale", async () => {
    await db.putMeeting(meeting({ status: "recording", assist: { translateTo: "", liveNotes: true }, liveNotes: {
      text: "old", throughSeq: 0, segmentCount: 1, locale: "ja", updatedAt: date,
    } }));
    await db.putSegment(segment(0));
    const worker = create(); worker.setLocale("zh-TW");
    await worker.rebuildNotes("m");
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes).toMatchObject({
      text: "default notes", throughSeq: 0, segmentCount: 1, locale: "zh-TW",
    }));
    expect(updateLiveNotes).toHaveBeenCalledWith(expect.objectContaining({ previous: "", locale: "zh-TW" }));
    await db.putSegment(segment(1));
    // Rebuilding only bypasses the threshold for the prefix present at the time.
    await db.updateMeeting("m", current => ({ ...current, status: "stopped" }));
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.throughSeq).toBe(1));
  });
  it("keeps the notes retry budget and backoff when the pending batch only grows", async () => {
    await db.putSegment(segment(0)); const timers = clock();
    const updateNotes = vi.fn().mockRejectedValue(new AppError("llm-failed"));
    const worker = create({ updateNotes, retryBaseMs: 100, maxAttempts: 2, ...timers });
    await until(() => expect(timers.tasks.size).toBe(1));
    for (const seq of [1, 2]) await db.putSegment(segment(seq));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(updateNotes).toHaveBeenCalledTimes(1);
    expect(timers.fire()).toBe(100);
    await until(async () => expect((await db.getMeeting("m"))?.liveNotesError).toBe("llm-failed"));
    expect(updateNotes).toHaveBeenCalledTimes(2);
    expect(updateNotes.mock.calls[1][0].segments).toHaveLength(3);
    expect(worker.getState().notesMeetingId).toBe(null);
  });
  it("backs off notes failures without a feedback retry loop", async () => {
    await db.putSegment(segment(0)); const timers = clock();
    const updateNotes = vi.fn().mockRejectedValue(new AppError("llm-failed"));
    const worker = create({ updateNotes, retryBaseMs: 100, maxAttempts: 2, ...timers });
    await until(() => expect(timers.tasks.size).toBe(1)); expect(timers.fire()).toBe(100);
    await until(() => expect(worker.getState().notesMeetingId).toBe(null));
    expect(updateNotes).toHaveBeenCalledTimes(2);
    expect(timers.tasks.size).toBe(0);
    expect((await db.getMeeting("m"))?.liveNotesError).toBe("llm-failed");
    updateNotes.mockResolvedValue("after kick"); await worker.retryNotes("m");
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.text).toBe("after kick"));
    expect((await db.getMeeting("m"))?.liveNotesError).toBeUndefined();
  });
});

describe("assist regression guards", () => {
  it.each(["dispose", "pagehide", "expiry"])("shares leader snapshots/drafts/blocking status and clears remote activity on %s", async ending => {
    vi.stubGlobal("BroadcastChannel", TabChannel);
    const locks = testLocks(); const timers = clock();
    await db.putMeeting(meeting({ assist: { translateTo: "", liveNotes: true } }));
    await db.putSegment(segment(0));
    const gate = deferred();
    const updateNotes = vi.fn((input: Parameters<typeof updateLiveNotes>[0]) => { input.onDelta?.("draft"); return gate.promise; });
    const leader = create({ locks, updateNotes });
    await until(() => expect(leader.getState().notesDraft).toBe("draft"));
    const follower = create({ locks, ...timers });
    const notify = vi.fn(); const unsubscribe = follower.subscribe(notify);
    await until(() => expect(follower.getState()).toMatchObject({ leader: false, notesMeetingId: "m", notesDraft: "draft" }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ notesDraft: "draft" }));
    if (ending === "dispose") leader.dispose();
    else if (ending === "pagehide") window.dispatchEvent(new Event("pagehide"));
    else {
      expect(timers.fire()).toBe(15000);
    }
    await until(() => expect(follower.getState()).toMatchObject({ notesMeetingId: null, notesDraft: "", translateActive: 0 }));
    unsubscribe();
    // Blocked status and a follower kick are relayed independently of notes persistence.
    if (ending !== "dispose") {
      window.dispatchEvent(new Event("pageshow"));
      gate.reject(new AppError("llm-not-configured"));
      await until(() => expect(follower.getState().blockedBy).toBe("llm-not-configured"));
      updateNotes.mockResolvedValue("resumed"); follower.kick();
      await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.text).toBe("resumed"));
    }
  });

  it("throttles draft broadcasts and refreshes activity with heartbeats", async () => {
    vi.stubGlobal("BroadcastChannel", TabChannel);
    TabChannel.sent = [];
    const locks = testLocks(); const timers = clock();
    await db.putMeeting(meeting({ assist: { translateTo: "", liveNotes: true } }));
    await db.putSegment(segment(0));
    const gate = deferred();
    const updateNotes = vi.fn((_input: Parameters<typeof updateLiveNotes>[0]) => gate.promise);
    create({ locks, updateNotes, ...timers });
    await until(() => expect(updateNotes).toHaveBeenCalledTimes(1));
    const follower = create({ locks });
    await until(() => expect(follower.getState().notesMeetingId).toBe("m"));
    const states = () => TabChannel.sent.filter(item => item.data.kind === "state");
    const before = states().length;
    for (let i = 0; i < 50; i++) updateNotes.mock.calls[0][0].onDelta?.(`draft ${i}`);
    expect(states()).toHaveLength(before);
    expect(timers.fire()).toBe(250);
    await until(() => expect(follower.getState().notesDraft).toBe("draft 49"));
    expect(states()).toHaveLength(before + 1);
    expect(timers.fire()).toBe(4750);
    expect(states()).toHaveLength(before + 2);
    expect(states().at(-1)?.data.state?.notesMeetingId).toBe("m");
  });

  it("unsubscribes shared config changes on dispose", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const worker = create(); worker.dispose();
    expect(remove).toHaveBeenCalledWith("storage", expect.any(Function));
    expect(settings.size).toBe(0);
  });

  it.each(["text", "status", "seq"] as const)("aborts notes for a changed batch %s and never advances over stale content", async field => {
    await db.putMeeting(meeting({ assist: { translateTo: "", liveNotes: true } }));
    await db.putSegment(segment(0));
    const stale = deferred(); const fresh = deferred();
    const updateNotes = vi.fn<typeof updateLiveNotes>().mockReturnValueOnce(stale.promise).mockReturnValue(fresh.promise);
    const worker = create({ updateNotes });
    await until(() => expect(updateNotes).toHaveBeenCalledTimes(1));
    await db.updateSegment("m:0", current => ({ ...current, [field]: field === "text" ? "corrected" : field === "status" ? "pending" : 1 }));
    await until(() => expect(updateNotes.mock.calls[0][0].signal?.aborted).toBe(true));
    stale.resolve("stale notes");
    await until(() => expect(worker.getState().notesDraft).toBe(""));
    if (field === "text") {
      await until(() => expect(updateNotes).toHaveBeenCalledTimes(2));
      expect(updateNotes.mock.calls[1][0].segments[0].text).toBe("corrected");
      expect((await db.getMeeting("m"))?.liveNotes).toBeUndefined();
      fresh.resolve("correct notes");
      await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.text).toBe("correct notes"));
    } else {
      await until(() => expect(worker.getState().notesMeetingId).toBeNull());
      expect((await db.getMeeting("m"))?.liveNotes).toBeUndefined();
    }
  });

  it("does not abort notes when only a translation is written to a batch segment", async () => {
    await db.putMeeting(meeting({ assist: { translateTo: "", liveNotes: true } }));
    await db.putSegment(segment(0));
    const gate = deferred();
    const updateNotes = vi.fn<typeof updateLiveNotes>().mockReturnValue(gate.promise);
    create({ updateNotes });
    await until(() => expect(updateNotes).toHaveBeenCalledTimes(1));
    await db.updateSegment("m:0", current => ({ ...current, translation: { lang: "en", source: current.text, text: "t", at: new Date().toISOString() } }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(updateNotes.mock.calls[0][0].signal?.aborted).toBe(false);
    gate.resolve("notes");
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.text).toBe("notes"));
    expect(updateNotes).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"])("re-reads the batch before %s even without a DB notification", async outcome => {
    await db.putMeeting(meeting({ assist: { translateTo: "", liveNotes: true } }));
    await db.putSegment(segment(0));
    const stale = deferred(); const fresh = deferred();
    const updateNotes = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValue(fresh.promise);
    create({ updateNotes, maxAttempts: 1 });
    await until(() => expect(updateNotes).toHaveBeenCalledTimes(1));
    const connection = await db.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = connection.transaction("segments", "readwrite");
      tx.objectStore("segments").put(segment(0, { text: "silent edit" }));
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    if (outcome === "success") stale.resolve("stale");
    else stale.reject(new AppError("llm-failed"));
    await until(() => expect(updateNotes).toHaveBeenCalledTimes(2));
    expect((await db.getMeeting("m"))?.liveNotes).toBeUndefined();
    expect((await db.getMeeting("m"))?.liveNotesError).toBeUndefined();
    fresh.reject(new AppError("llm-failed", "unlocalized provider detail"));
    await until(async () => expect((await db.getMeeting("m"))?.liveNotesError).toBe("llm-failed"));
  });

  it("does not create an empty first note that delays the first done segment", async () => {
    await db.putMeeting(meeting({ status: "recording", assist: { translateTo: "", liveNotes: true } }));
    await db.putSegment(segment(0, { status: "empty", text: "" }));
    create();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await db.getMeeting("m"))?.liveNotes).toBeUndefined();
    await db.putSegment(segment(1));
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes).toMatchObject({ throughSeq: 1, segmentCount: 1 }));
    expect(updateLiveNotes).toHaveBeenCalledTimes(1);
  });

  it("a retry force-flush only covers the terminal prefix available at request time", async () => {
    await db.putMeeting(meeting({ status: "recording", assist: { translateTo: "", liveNotes: true }, liveNotes: {
      text: "saved", throughSeq: 0, segmentCount: 1, locale: "en", updatedAt: date,
    } }));
    await db.putSegment(segment(0)); await db.putSegment(segment(1));
    await db.putSegment(segment(2, { status: "pending", text: "" }));
    const worker = create();
    await worker.retryNotes("m");
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.throughSeq).toBe(1));
    await db.putSegment(segment(2));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(updateLiveNotes).toHaveBeenCalledTimes(1);
    expect((await db.getMeeting("m"))?.liveNotes?.throughSeq).toBe(1);
  });

  it("persists follower rebuild/retry requests, aborts old work and preserves notes on retry", async () => {
    const locks = testLocks();
    await db.putMeeting(meeting({ status: "recording", assist: { translateTo: "", liveNotes: true },
      liveNotes: { text: "saved", throughSeq: 0, segmentCount: 1, locale: "en", updatedAt: date } }));
    for (const seq of [0, 1, 2]) await db.putSegment(segment(seq));
    const stale = deferred(); const retry = deferred();
    const updateNotes = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(retry.promise).mockResolvedValue("rebuilt");
    create({ locks, updateNotes });
    const follower = create({ locks, updateNotes: vi.fn() });
    await until(() => expect(updateNotes).toHaveBeenCalledTimes(1));
    await follower.retryNotes("m");
    await until(() => expect(updateNotes.mock.calls[0][0].signal.aborted).toBe(true));
    const request = (await db.getMeeting("m"))?.liveNotesRequest;
    expect(request).toBeDefined();
    expect((await db.getMeeting("m"))?.liveNotes?.text).toBe("saved");
    stale.resolve("stale");
    await until(() => expect(updateNotes).toHaveBeenCalledTimes(2));
    expect(updateNotes.mock.calls[1][0].previous).toBe("saved");
    await follower.rebuildNotes("m");
    expect((await db.getMeeting("m"))?.liveNotesRequest).not.toBe(request);
    retry.resolve("discarded");
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.text).toBe("rebuilt"));
    expect(updateNotes.mock.calls[2][0].previous).toBe("");
  });

  it("retries an exhausted update from a follower without losing the existing notes", async () => {
    const locks = testLocks();
    await db.putMeeting(meeting({ assist: { translateTo: "", liveNotes: true }, liveNotes: {
      text: "saved", throughSeq: 0, segmentCount: 1, locale: "en", updatedAt: date,
    } }));
    await db.putSegment(segment(0)); await db.putSegment(segment(1));
    const updateNotes = vi.fn().mockRejectedValueOnce(new AppError("llm-failed")).mockResolvedValue("recovered");
    create({ locks, updateNotes, maxAttempts: 1 });
    const follower = create({ locks });
    await until(async () => expect((await db.getMeeting("m"))?.liveNotesError).toBe("llm-failed"));
    await db.updateMeeting("m", current => ({ ...current, status: "paused" }));
    await follower.retryNotes("m");
    await until(async () => expect((await db.getMeeting("m"))?.liveNotes?.text).toBe("recovered"));
    expect(updateNotes.mock.calls[1][0]).toMatchObject({ previous: "saved", segments: [{ text: "source 1" }] });
    expect((await db.getMeeting("m"))?.liveNotesError).toBeUndefined();
  });

  it("prioritizes live meetings newest first and refreshes priority after status changes", async () => {
    await db.putMeeting(meeting({ id: "z", status: "recording" }));
    for (const seq of [0, 1, 2]) {
      await db.putSegment(segment(seq));
      await db.putSegment(segment(seq, { id: `z:${seq}`, meetingId: "z", text: `live ${seq}` }));
    }
    const gates: ReturnType<typeof deferred>[] = [];
    const translate = vi.fn(() => { const gate = deferred(); gates.push(gate); return gate.promise; });
    create({ translate, concurrency: 1 });
    await until(() => expect(translate).toHaveBeenCalledTimes(1));
    expect(translate.mock.calls[0]).toMatchObject([{ text: "live 2" }]);
    await db.updateMeeting("z", current => ({ ...current, status: "stopped" }));
    await db.updateMeeting("m", current => ({ ...current, status: "paused" }));
    await new Promise(resolve => setTimeout(resolve, 30));
    gates[0].resolve("translated");
    await until(() => expect(translate).toHaveBeenCalledTimes(2));
    expect(translate.mock.calls[1]).toMatchObject([{ text: "source 2" }]);
    await db.updateMeeting("m", current => ({ ...current, status: "stopped" }));
    await new Promise(resolve => setTimeout(resolve, 30));
    gates[1].resolve("translated");
    await until(() => expect(translate).toHaveBeenCalledTimes(3));
    expect(translate.mock.calls[2]).toMatchObject([{ text: "source 0" }]);
  });

  it("discards malformed new optional fields without hiding legacy meetings", async () => {
    await db.putMeeting({ ...meeting(), liveNotesRequest: 42, liveNotesError: {} } as unknown as Meeting);
    expect(await db.getMeeting("m")).toMatchObject({ id: "m" });
    expect((await db.getMeeting("m"))?.liveNotesRequest).toBeUndefined();
    expect((await db.getMeeting("m"))?.liveNotesError).toBeUndefined();
  });

  it("times out a stalled translation attempt and frees the slot for retry", async () => {
    await db.putMeeting(meeting());
    await db.putSegment(segment(0));
    let calls = 0;
    const translate = vi.fn<typeof translateChunk>(input => {
      calls++;
      if (calls === 1) return new Promise<string>((_resolve, reject) => input.signal?.addEventListener("abort", () => reject(new AppError("aborted"))));
      return Promise.resolve("translated after timeout");
    });
    create({ translate, translateTimeoutMs: 20, retryBaseMs: 1 });
    await translated(0, "translated after timeout");
    expect(translate).toHaveBeenCalledTimes(2);
    expect(translate.mock.calls[0][0].signal?.aborted).toBe(true);
  });

  it("does not commit notes when a batch segment changed in the same commit window (atomic check)", async () => {
    await db.putMeeting(meeting({ assist: { translateTo: "", liveNotes: true } }));
    await db.putSegment(segment(0));
    const expected = [{ id: "m:0", seq: 0, status: "done" as const, text: "source 0" }];
    await db.putSegment(segment(0, { text: "edited elsewhere" }));
    const result = await db.updateMeetingIfSegments("m", expected, current => ({ ...current, title: "changed" }));
    expect(result).toBeUndefined();
    expect((await db.getMeeting("m"))?.title).toBe("Meeting");
    const ok = await db.updateMeetingIfSegments("m", [{ ...expected[0], text: "edited elsewhere" }], current => ({ ...current, title: "changed" }));
    expect(ok?.title).toBe("changed");
  });
});
