export function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  for (const mime of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    try { if (MediaRecorder.isTypeSupported(mime)) return mime; } catch { /* Try the next format. */ }
  }
  return "";
}

export function extensionForMime(mime: string): string {
  switch (mime.split(";", 1)[0].trim().toLowerCase()) {
    case "audio/mp4": case "video/mp4": return "mp4";
    case "audio/x-m4a": case "audio/m4a": return "m4a";
    case "audio/ogg": case "application/ogg": return "ogg";
    case "audio/wav": case "audio/wave": case "audio/x-wav": case "audio/vnd.wave": return "wav";
    case "audio/mpeg": case "audio/mp3": return "mp3";
    default: return "webm";
  }
}

export function isRecordingSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof MediaRecorder !== "undefined" && !!audioContextConstructor();
}

/** Older browsers expose the prefixed constructor only. */
export function audioContextConstructor(): typeof AudioContext | undefined {
  return globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}
