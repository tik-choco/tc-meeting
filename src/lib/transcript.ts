export function normalizeTranscript(text: string): string {
  return text.replace(/\s+/gu, " ").trim().replace(/(.{2,}?)(?:\s*\1){3,}/gu, "$1").trim();
}
export function isLikelyHallucination(text: string, speechMs: number | undefined, durationMs: number): boolean {
  return speechMs !== undefined && Number.isFinite(speechMs) && speechMs >= 0
    && durationMs > 0 && speechMs < durationMs * 0.05 && Array.from(text.trim()).length <= 40;
}
export function promptTail(text: string, maxChars = 200): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 200;
  const chars = Array.from(text.trim());
  if (!limit) return "";
  if (chars.length <= limit) return chars.join("");
  const tail = chars.slice(-limit).join("");
  if (/\s|[.!?。！？]/u.test(chars[chars.length - limit - 1])) return tail.trim();
  const boundary = /[.!?。！？]\s*|\s+/u.exec(tail);
  const cut = boundary ? tail.slice(boundary.index + boundary[0].length).trim() : "";
  return cut || tail;
}
