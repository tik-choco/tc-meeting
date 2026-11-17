import type { Meeting, Segment } from "../types";
import { formatClock, formatSrtTime, formatVttTime } from "./format";
export type ExportFormat = "md" | "txt" | "srt" | "vtt" | "json";

function cueText(text: string, escapeMarkup = false): string {
  const cue = text.trim().split(/\r\n|[\n\r\u2028\u2029]/u).map(line => line.trim()).filter(Boolean).join("\n");
  return escapeMarkup ? cue.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : cue;
}

function safeTitle(title: string): string {
  return Array.from(title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ").trim().replace(/^[. ]+|[. ]+$/gu, "")).slice(0, 60).join("") || "meeting";
}

export function exportMeeting(meeting: Meeting, segments: Segment[], format: ExportFormat,
  opts?: { timestamps?: boolean; summary?: boolean; translation?: boolean; proofread?: boolean }): { filename: string; mime: string; content: string } {
  const done = segments.filter(s => s.status === "done" && s.text.trim()).sort((a, b) => a.seq - b.seq);
  const date = Number.isFinite(Date.parse(meeting.createdAt)) ? new Date(meeting.createdAt).toISOString().slice(0, 10) : "undated";
  const filename = `${safeTitle(meeting.title)}-${date}.${format}`;
  const summary = opts?.summary !== false ? meeting.summary?.text.trim() : undefined;
  const proofread = (s: Segment): string | undefined => {
    const value = s.proofread;
    return opts?.proofread && value?.source === s.text && !value.error && typeof value.text === "string"
      && value.text.trim() && value.text.trim() !== s.text.trim() ? value.text.trim() : undefined;
  };
  const translation = (s: Segment): { lang: string; text: string } | undefined => {
    const value = s.translation;
    return opts?.translation && value?.source === s.text && value.lang === meeting.assist?.translateTo
      && !value.error && typeof value.text === "string" && value.text.trim() ? { lang: value.lang, text: value.text.trim() } : undefined;
  };
  const lines = done.map(s => `${opts?.timestamps === false ? "" : `[${formatClock(s.startMs)}] `}${s.text.trim()}`
    + (proofread(s) ? `\n✎ ${proofread(s)}` : "")
    + (translation(s) ? `\n${translation(s)!.text}` : ""));
  const cue = (s: Segment, escapeMarkup = false): string => cueText(s.text, escapeMarkup)
    + (translation(s) ? `\n${cueText(translation(s)!.text, escapeMarkup)}` : "");
  switch (format) {
    case "md": return { filename, mime: "text/markdown;charset=utf-8", content:
      [`# ${meeting.title.replace(/\s+/gu, " ").trim()}`, `${date} · ${formatClock(meeting.durationMs)}`, ...(summary ? [summary] : []), ...lines].join("\n\n") + "\n" };
    case "txt": return { filename, mime: "text/plain;charset=utf-8", content:
      [meeting.title, `${date} · ${formatClock(meeting.durationMs)}`, ...(summary ? [summary] : []), ...lines].join("\n\n") + "\n" };
    case "srt": return { filename, mime: "application/x-subrip;charset=utf-8", content:
      done.map((s, i) => `${i + 1}\n${formatSrtTime(s.startMs)} --> ${formatSrtTime(s.endMs)}\n${cue(s)}`).join("\n\n") + (done.length ? "\n" : "") };
    case "vtt": return { filename, mime: "text/vtt;charset=utf-8", content: "WEBVTT\n\n" +
      done.map(s => `${formatVttTime(s.startMs)} --> ${formatVttTime(s.endMs)}\n${cue(s, true)}`).join("\n\n") + (done.length ? "\n" : "") };
    case "json": {
      // Whitelist domain fields: never serialize an arbitrary object supplied by a caller.
      const { id, title, createdAt, updatedAt, durationMs, status, source, language, nextSeq, keepAudio } = meeting;
      return { filename, mime: "application/json;charset=utf-8", content: JSON.stringify({
        meeting: { id, title, createdAt, updatedAt, durationMs, status, source, language, nextSeq, keepAudio,
          ...(summary && meeting.summary ? { summary: { text: summary, createdAt: meeting.summary.createdAt, segmentCount: meeting.summary.segmentCount } } : {}) },
        segments: done.map(s => ({ startMs: s.startMs, endMs: s.endMs, text: s.text.trim(),
          ...(proofread(s) ? { proofread: proofread(s) } : {}),
          ...(translation(s) ? { translation: translation(s) } : {}) })),
      }, null, 2) + "\n" };
    }
  }
}
