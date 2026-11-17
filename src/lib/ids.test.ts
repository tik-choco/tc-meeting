import { describe, expect, it } from "vitest";
import { newId, segmentFileName, segmentId } from "./ids";

describe("identifiers", () => {
  it("creates unique UUIDs and stable timeline identifiers", () => {
    expect(newId()).toMatch(/^[0-9a-f-]{36}$/u);
    expect(newId()).not.toBe(newId());
    expect(segmentId("meeting", 12)).toBe("meeting:000012");
    expect(segmentId("meeting", 1000000)).toBe("meeting:1000000");
  });
  it("uses the audio MIME extension", () => {
    expect(segmentFileName(12, "audio/webm;codecs=opus")).toBe("segment-000012.webm");
    expect(segmentFileName(1, "audio/wav")).toBe("segment-000001.wav");
  });
});
