import { describe, expect, it } from "vitest";
import { formatClock, formatSrtTime, formatVttTime } from "./format";

describe("timeline formatting", () => {
  it("formats minutes and arbitrarily long hour counts", () => {
    expect(formatClock(725999)).toBe("12:05");
    expect(formatClock(3725120)).toBe("1:02:05");
    expect(formatClock(100 * 3600000)).toBe("100:00:00");
    expect(formatClock(-1)).toBe("0:00");
    expect(formatClock(NaN)).toBe("0:00");
  });
  it("retains milliseconds in subtitle formats without rounding across a cue", () => {
    expect(formatSrtTime(3725120.9)).toBe("01:02:05,120");
    expect(formatVttTime(3725120)).toBe("01:02:05.120");
    expect(formatSrtTime(Infinity)).toBe("00:00:00,000");
  });
});
