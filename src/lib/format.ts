function milliseconds(ms: number): number { return Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0; }
const pad = (n: number) => String(n).padStart(2, "0");

export function formatClock(ms: number): string {
  const seconds = Math.floor(milliseconds(ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:${pad(minutes)}` : minutes}:${pad(seconds % 60)}`;
}
export function formatSrtTime(ms: number): string {
  const value = milliseconds(ms);
  return `${pad(Math.floor(value / 3600000))}:${pad(Math.floor(value / 60000) % 60)}:${pad(Math.floor(value / 1000) % 60)},${String(value % 1000).padStart(3, "0")}`;
}
export function formatVttTime(ms: number): string { return formatSrtTime(ms).replace(",", "."); }
