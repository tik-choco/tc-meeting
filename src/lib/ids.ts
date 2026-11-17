import { extensionForMime } from "./audio/mime";

export function newId(): string { return crypto.randomUUID(); }
export function segmentId(meetingId: string, seq: number): string {
  return `${meetingId}:${String(seq).padStart(6, "0")}`;
}
export function segmentFileName(seq: number, mimeType: string): string {
  return `segment-${String(seq).padStart(6, "0")}.${extensionForMime(mimeType)}`;
}
