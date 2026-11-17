import { describe, expect, it } from "vitest";
import { isLikelyHallucination, normalizeTranscript, promptTail } from "./transcript";

describe("transcript cleanup", () => {
  it("normalizes whitespace and repeated phrases in spaced and CJK text", () => {
    expect(normalizeTranscript("  A\n  useful\tmeeting  ")).toBe("A useful meeting");
    expect(normalizeTranscript("thank you thank you thank you thank you")).toBe("thank you");
    expect(normalizeTranscript("会議終了。会議終了。会議終了。会議終了。")).toBe("会議終了。");
    expect(normalizeTranscript("abcabcabcabc")).toBe("abc");
    expect(normalizeTranscript("yes yes yes")).toBe("yes yes yes");
  });
  it("only filters short filler when speech is known to be below five percent", () => {
    expect(isLikelyHallucination("thanks", undefined, 30000)).toBe(false);
    expect(isLikelyHallucination("thanks", 1499, 30000)).toBe(true);
    expect(isLikelyHallucination("thanks", 1500, 30000)).toBe(false);
    expect(isLikelyHallucination("x".repeat(41), 1, 30000)).toBe(false);
    expect(isLikelyHallucination("thanks", 0, 0)).toBe(false);
  });
  it("keeps a bounded context with readable boundaries and intact Unicode", () => {
    expect(promptTail("short")).toBe("short");
    expect(promptTail("old sentence. last sentence", 15)).toBe("last sentence");
    expect(promptTail("会議終了。次を開始します。", 10)).toBe("次を開始します。");
    expect(promptTail("a".repeat(250))).toHaveLength(200);
    expect(promptTail("😀".repeat(10), 2)).toBe("😀😀");
    expect(promptTail("text", 0)).toBe("");
  });
});
