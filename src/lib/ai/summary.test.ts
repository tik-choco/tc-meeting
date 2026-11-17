import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Locale, Segment } from "../../types";
import { requestChatCompletion } from "./llm";
import { chunkTranscriptLines, summarizeMeeting } from "./summary";

vi.mock("./llm", () => ({ requestChatCompletion: vi.fn() }));

const done = (startMs: number, text: string): Pick<Segment, "startMs" | "text" | "status"> => ({ startMs, text, status: "done" });
const chat = vi.mocked(requestChatCompletion);
beforeEach(() => { chat.mockReset(); });

describe("transcript chunking", () => {
  it("honors exact boundaries including newline separators and retains order", () => {
    expect(chunkTranscriptLines(["abc", "def", "ghi", "j"], 7)).toEqual([["abc", "def"], ["ghi", "j"]]);
    expect(chunkTranscriptLines([], 10)).toEqual([]);
    expect(chunkTranscriptLines(["ab"], 0)).toEqual([["a"], ["b"]]);
  });

  it("splits an oversized segment with timestamp references on every part", () => {
    const chunks = chunkTranscriptLines(["[00:05] abcdefghij"], 12);
    expect(chunks).toEqual([["[00:05] abcd"], ["[00:05] efgh"], ["[00:05] ij"]]);
    expect(chunks.every((chunk) => chunk.join("\n").length <= 12)).toBe(true);
    expect(chunkTranscriptLines(["a😀b"], 2)).toEqual([["a"], ["😀"], ["b"]]);
  });
});

describe("meeting minutes", () => {
  it.each<[Locale, string]>([["en", "English"], ["ja", "Japanese"], ["zh-CN", "Simplified Chinese"], ["zh-TW", "Traditional Chinese"]])
  ("requests %s minutes with transcript-only facts and timestamps", async (locale, language) => {
    chat.mockImplementation(async (_messages, options) => { options?.onDelta?.("draft", "draft"); return "minutes"; });
    const onDelta = vi.fn();
    const onProgress = vi.fn();
    const result = await summarizeMeeting({
      title: "Planning", locale, onDelta, onProgress,
      segments: [done(3723000, "later"), { startMs: 10, text: "pending", status: "pending" }, done(65000, "earlier")],
    });
    expect(result).toBe("minutes");
    expect(chat).toHaveBeenCalledTimes(1);
    const messages = chat.mock.calls[0][0];
    expect(messages[0].content).toContain(`Write in ${language}`);
    expect(messages[0].content).toContain("Never invent facts");
    expect(messages[0].content).toContain("overview, key points, decisions, action items, and open questions");
    expect(messages[0].content).toContain("owner and due date");
    expect(messages[1].content).toContain("[01:05] earlier\n[1:02:03] later");
    expect(messages[1].content).not.toContain("pending");
    expect(onDelta).toHaveBeenCalledWith("draft");
    expect(onProgress).toHaveBeenLastCalledWith({ stage: "reduce", done: 1, total: 1 });
  });

  it("maps a 150k-character meeting in bounded chunks and makes one final reduction", async () => {
    chat.mockResolvedValue("[00:00] concise note");
    const onProgress = vi.fn();
    const segments = Array.from({ length: 15 }, (_, index) => done(index * 60000, String(index % 10).repeat(10000)));
    await summarizeMeeting({ title: "Long meeting", segments, locale: "en", onProgress });
    expect(chat).toHaveBeenCalledTimes(16);
    const mapCalls = chat.mock.calls.slice(0, 15);
    expect(mapCalls.every(([messages]) => messages[1].content.split("\n").at(-1)!.length <= 12000)).toBe(true);
    expect(chat.mock.calls[15][0][1].content).toContain("concise note");
    expect(onProgress).toHaveBeenCalledWith({ stage: "map", done: 15, total: 15 });
    expect(onProgress).toHaveBeenLastCalledWith({ stage: "reduce", done: 1, total: 1 });
  });

  it("performs intermediate reductions if map notes exceed the context bound", async () => {
    chat.mockResolvedValueOnce("x".repeat(7000)).mockResolvedValueOnce("y".repeat(7000))
      .mockResolvedValueOnce("short x").mockResolvedValueOnce("short y").mockResolvedValueOnce("minutes");
    const result = await summarizeMeeting({ title: "Planning", segments: [done(0, "a".repeat(11900)), done(60000, "b".repeat(11900))], locale: "en" });
    expect(result).toBe("minutes");
    expect(chat).toHaveBeenCalledTimes(5);
    expect(chat.mock.calls[2][0][1].content.length).toBeLessThanOrEqual(12000);
    expect(chat.mock.calls[3][0][1].content.length).toBeLessThanOrEqual(12000);
    expect(chat.mock.calls[4][0][1].content).toContain("short x\nshort y");
  });

  it("fails instead of looping when a provider does not shorten its notes", async () => {
    chat.mockResolvedValueOnce("x".repeat(7000)).mockResolvedValueOnce("y".repeat(7000))
      .mockResolvedValueOnce("x".repeat(7000)).mockResolvedValueOnce("y".repeat(7000));
    await expect(summarizeMeeting({ title: "Planning", segments: [done(0, "a".repeat(11900)), done(60000, "b".repeat(11900))], locale: "en" }))
      .rejects.toMatchObject({ code: "llm-failed", message: expect.stringContaining("did not shorten") });
    expect(chat).toHaveBeenCalledTimes(4);
  });

  it("stops between map requests when aborted", async () => {
    chat.mockResolvedValue("note");
    const controller = new AbortController();
    await expect(summarizeMeeting({
      title: "Planning", segments: [done(0, "a".repeat(11900)), done(60000, "b".repeat(11900))], locale: "en", signal: controller.signal,
      onProgress: (progress) => { if (progress.stage === "map" && progress.done === 1) controller.abort(); },
    })).rejects.toMatchObject({ code: "aborted" });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("stops waiting during a request and suppresses late deltas", async () => {
    let lateDelta: ((delta: string, full: string) => void) | undefined;
    chat.mockImplementation((_messages, options) => {
      lateDelta = options?.onDelta;
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const onDelta = vi.fn();
    const promise = summarizeMeeting({ title: "Planning", segments: [done(0, "hello")], locale: "en", signal: controller.signal, onDelta });
    const assertion = expect(promise).rejects.toMatchObject({ code: "aborted" });
    await Promise.resolve();
    expect(chat.mock.calls[0][1]?.signal).toBe(controller.signal);
    controller.abort();
    lateDelta?.("late", "late");
    await assertion;
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("rejects an empty transcript without asking the model to invent content", async () => {
    await expect(summarizeMeeting({ title: "Empty", segments: [], locale: "en" })).rejects.toMatchObject({ code: "llm-failed" });
    expect(chat).not.toHaveBeenCalled();
  });
});
