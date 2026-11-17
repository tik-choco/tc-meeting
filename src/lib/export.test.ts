import { describe, expect, it } from "vitest";
import type { Meeting, Segment } from "../types";
import { exportMeeting } from "./export";

const meeting: Meeting = {
  id: "m", title: "A meeting", createdAt: "2026-01-02T03:04:05Z", updatedAt: "2026-01-02T03:04:05Z",
  status: "stopped", source: "mic", language: "", nextSeq: 3, durationMs: 3725120, keepAudio: true,
  summary: { text: "Decisions were made.", createdAt: "2026-01-02T04:04:05Z", segmentCount: 2 },
};
function segment(seq: number, text: string, status: Segment["status"] = "done"): Segment {
  return { id: `m:${seq}`, meetingId: "m", seq, startMs: seq * 1000, endMs: seq * 1000 + 999,
    text, status, edited: false, attempts: 0, mimeType: "audio/wav", hasAudio: true };
}
const segments = [segment(2, "second"), segment(0, "first"), segment(1, "pending", "pending"), segment(3, "  ")];
describe("meeting export", () => {
  it.each(["md", "txt", "srt", "vtt", "json"] as const)("exports opted-in, changed corrections in %s", format => {
    const corrected = { ...segment(0, "original"), proofread: { source: "original", text: " corrected ", at: meeting.createdAt },
      translation: { source: "original", text: "translated", lang: "ja", at: meeting.createdAt } };
    const assisted = { ...meeting, assist: { translateTo: "ja", liveNotes: false } };
    expect(exportMeeting(assisted, [corrected], format).content).not.toContain("corrected");
    const content = exportMeeting(assisted, [corrected], format, { proofread: true, translation: true }).content;
    if (format === "json") expect(JSON.parse(content).segments[0]).toEqual({ startMs: 0, endMs: 999, text: "original",
      proofread: "corrected", translation: { lang: "ja", text: "translated" } });
    else if (format === "srt" || format === "vtt") {
      expect(content).not.toContain("corrected"); expect(content).toContain("original\ntranslated");
    } else expect(content).toContain("original\n✎ corrected\ntranslated");
    for (const invalid of [{ source: "stale" }, { error: "llm-failed" }, { text: "  " }, { text: " original " }]) {
      const value = { ...corrected, proofread: { ...corrected.proofread, ...invalid } };
      const exported = exportMeeting(assisted, [value], format, { proofread: true }).content;
      expect(exported).not.toContain("✎");
      if (format === "json") expect(JSON.parse(exported).segments[0]).not.toHaveProperty("proofread");
    }
  });
  it.each(["md", "txt", "srt", "vtt", "json"] as const)("exports only valid opted-in translations in %s", format => {
    const translated = segment(0, "original");
    translated.translation = { source: "original", lang: "ja", text: "translated <x> & y", at: meeting.createdAt };
    const assisted = { ...meeting, assist: { translateTo: "ja", liveNotes: false } };
    const output = () => exportMeeting(assisted, [translated], format, { translation: true }).content;
    expect(exportMeeting(assisted, [translated], format).content).not.toContain("translated");
    if (format === "json") expect(JSON.parse(output()).segments[0].translation).toEqual({ lang: "ja", text: "translated <x> & y" });
    else expect(output()).toContain("original\n" + (format === "vtt" ? "translated &lt;x&gt; &amp; y" : "translated <x> & y"));
    for (const invalid of [{ source: "stale" }, { lang: "en" }, { error: "llm-failed" }, { text: "  " }]) {
      const value = { ...translated, translation: { ...translated.translation, ...invalid } };
      expect(exportMeeting(assisted, [value], format, { translation: true }).content).not.toContain("translated");
    }
    expect(exportMeeting(meeting, [translated], format, { translation: true }).content).not.toContain("translated");
  });
  it.each(['srt', 'vtt'] as const)('%s keeps edited paragraphs in one timed cue', format => {
    for (const separator of ['\n\n', '\r\n \t\r\n', '\r\r', '\u2028\u2028']) {
      const { content } = exportMeeting(meeting, [segment(0, `First paragraph.${separator}Second paragraph.`)], format);
      const blocks = content.trim().split(/\r?\n\r?\n/).filter(block => block !== 'WEBVTT');
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain('First paragraph.\nSecond paragraph.');
    }
  });
  it('escapes literal markup and entities in VTT cue text', () => {
    const { content } = exportMeeting(meeting, [segment(0, 'Use <budget> & <b>literal tags</b>. &lt;')], 'vtt');
    expect(content).toContain('Use &lt;budget&gt; &amp; &lt;b&gt;literal tags&lt;/b&gt;. &amp;lt;');
  });
  it("includes metadata, summary, and only ordered completed transcript lines", () => {
    const result = exportMeeting(meeting, segments, "md");
    expect(result.filename).toBe("A meeting-2026-01-02.md");
    expect(result.content).toContain("# A meeting\n\n2026-01-02 · 1:02:05");
    expect(result.content).toContain("Decisions were made.");
    expect(result.content).toContain("[0:00] first\n\n[0:02] second");
    expect(result.content).not.toContain("pending");
    const plain = exportMeeting(meeting, segments, "txt", { summary: false, timestamps: false });
    expect(plain.content).not.toContain("Decisions");
    expect(plain.content).not.toContain("[0:");
    expect(plain.content).toContain("first\n\nsecond");
    expect(segments[0].seq).toBe(2);
  });
  it("produces numbered SRT and valid VTT headers and timestamps", () => {
    expect(exportMeeting(meeting, segments, "srt").content).toBe("1\n00:00:00,000 --> 00:00:00,999\nfirst\n\n2\n00:00:02,000 --> 00:00:02,999\nsecond\n");
    expect(exportMeeting(meeting, segments, "vtt").content).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:00.999\nfirst\n\n00:00:02.000 --> 00:00:02.999\nsecond\n");
    expect(exportMeeting(meeting, [], "vtt").content).toBe("WEBVTT\n\n");
  });
  it("whitelists JSON data and honors summary exclusion", () => {
    const exported = JSON.parse(exportMeeting({ ...meeting, secret: "hidden" } as Meeting, segments, "json", { summary: false }).content);
    expect(exported.meeting.secret).toBeUndefined();
    expect(exported.meeting.summary).toBeUndefined();
    expect(exported.segments).toEqual([{ startMs: 0, endMs: 999, text: "first" }, { startMs: 2000, endMs: 2999, text: "second" }]);
  });
  it("sanitizes and bounds filenames including empty and dot-only titles", () => {
    const filename = exportMeeting({ ...meeting, title: '../\\\u0000:*?|' + "長".repeat(200) }, [], "txt").filename;
    expect(filename).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/u);
    expect(Array.from(filename).length).toBeLessThanOrEqual(80);
    expect(exportMeeting({ ...meeting, title: ".." }, [], "txt").filename).toBe("meeting-2026-01-02.txt");
  });
});
