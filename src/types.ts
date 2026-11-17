// Shared domain types for TC Meeting.

/** Where the recorded audio comes from. 'mic+tab' mixes the microphone with a
 * shared tab/screen audio track (online meetings). 'file' = imported file. */
export type CaptureSource = "mic" | "mic+tab";
export type MeetingSource = CaptureSource | "file";

/**
 * recording   — a live capture is appending segments right now
 * paused      — live capture paused by the user (still owned by this tab)
 * importing   — an audio file is being split into segments
 * stopped     — capture finished normally (transcription may still be pending)
 * interrupted — the tab died / reloaded while recording or importing
 */
export type MeetingStatus = "recording" | "paused" | "importing" | "stopped" | "interrupted";

export interface MeetingSummary {
  /** Markdown minutes produced by the LLM. */
  text: string;
  /** ISO 8601 */
  createdAt: string;
  /** Number of done segments the summary was generated from (staleness hint). */
  segmentCount: number;
}

/** Per-meeting LLM assist options. undefined (older meetings) = everything off. */
export interface MeetingAssist {
  /** Translation target code from TRANSLATION_LANGUAGES (lib/ai/translate.ts), '' = off. */
  translateTo: string;
  /** Keep rolling "live notes" updated as transcripts arrive (also while recording). */
  liveNotes: boolean;
  /** Proofread each transcribed segment in its own language; the corrected text is shown
   * right under the original (e.g. polishing a spoken English presentation). undefined = off. */
  proofread?: boolean;
}

/** Live chunk length. standard = 20–45 s (best context for STT), fast = ~6–15 s (lower latency
 * for real-time display). Applies to live capture only (imports always use standard). */
export type ChunkProfile = "standard" | "fast";

/** Rolling, incrementally refined notes: previous notes + newly transcribed
 * segments are folded together chunk by chunk while the meeting goes on. */
export interface LiveNotes {
  /** Markdown, written in `locale`'s language. */
  text: string;
  /** Highest segment seq already folded into the notes (-1 = none). */
  throughSeq: number;
  /** Number of done segments folded in so far. */
  segmentCount: number;
  locale: Locale;
  /** ISO 8601 */
  updatedAt: string;
}

export interface Meeting {
  /** crypto.randomUUID() */
  id: string;
  title: string;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601, bumped on every putMeeting by the caller. */
  updatedAt: string;
  /** Total audio timeline length in ms (end of the last segment). */
  durationMs: number;
  status: MeetingStatus;
  source: MeetingSource;
  /** ISO-639-1 recognizer hint ('ja', 'en', ...) or '' for auto-detect. */
  language: string;
  /** Next seq number to assign (== number of segments ever created). */
  nextSeq: number;
  /** Keep segment audio after successful transcription. */
  keepAudio: boolean;
  summary?: MeetingSummary;
  assist?: MeetingAssist;
  liveNotes?: LiveNotes;
  /** ISO 8601, bumped by any tab to ask the assist leader to (re)build / retry live notes now:
   * forces a flush of the available prefix and clears the leader's failure state. */
  liveNotesRequest?: string;
  /** Last terminal live-notes failure (error code), cleared on success or a new request. */
  liveNotesError?: string;
  /** Live chunking profile; undefined (older meetings) = 'standard'. continueMeeting reuses it. */
  chunkProfile?: ChunkProfile;
}

/**
 * pending      — waiting in (or for) the transcription queue
 * transcribing — a request is in flight
 * done         — text is final (may be user-edited)
 * empty        — no speech detected / recognizer returned nothing; not an error
 * failed       — gave up after max attempts (user can retry)
 */
export type SegmentStatus = "pending" | "transcribing" | "done" | "empty" | "failed";

/** Machine translation of one segment. Valid only while `source === segment.text`
 * and `lang === meeting.assist.translateTo`; otherwise it is stale and gets redone. */
export interface SegmentTranslation {
  /** Target code (TRANSLATION_LANGUAGES). */
  lang: string;
  /** The exact segment.text that was translated. */
  source: string;
  /** Translated text ('' when `error` is set). */
  text: string;
  /** Set when translation gave up after retries (error code or detail). */
  error?: string;
  /** ISO 8601 */
  at: string;
}

/** LLM proofreading (same language) of one segment. Valid only while `source === segment.text`;
 * edits / re-transcriptions make it stale and it is redone while Meeting.assist.proofread is on. */
export interface SegmentProofread {
  /** The exact segment.text that was proofread. */
  source: string;
  /** Corrected text ('' when `error` is set). Equal to source when nothing needed fixing. */
  text: string;
  /** Set when proofreading gave up after retries (error code or detail). */
  error?: string;
  /** ISO 8601 */
  at: string;
}

export interface Segment {
  /** `${meetingId}:${seq zero-padded to 6}` — see segmentId() in lib/ids.ts */
  id: string;
  meetingId: string;
  /** 0-based, strictly increasing in timeline order. */
  seq: number;
  /** Offset from the start of the meeting's audio timeline, ms. */
  startMs: number;
  endMs: number;
  status: SegmentStatus;
  /** Transcript text ('' until done). */
  text: string;
  /** True once the user edited `text` by hand (never overwritten by retries). */
  edited: boolean;
  attempts: number;
  /** Last error code/message for failed segments. */
  error?: string;
  /** MIME type of the stored audio blob. */
  mimeType: string;
  /** Whether an audio blob is currently stored for this segment. */
  hasAudio: boolean;
  /** Approximate ms of speech-level audio in this segment (VAD estimate).
   * undefined = unknown (always transcribe). */
  speechMs?: number;
  /** ISO 8601 */
  transcribedAt?: string;
  via?: SttTransport;
  translation?: SegmentTranslation;
  proofread?: SegmentProofread;
}

/** A chunk of audio produced by the live segmenter or the file splitter. */
export interface AudioChunk {
  startMs: number;
  endMs: number;
  blob: Blob;
  mimeType: string;
  speechMs?: number;
}

export type SttTransport = "api" | "network";

export interface TranscribeInput {
  audio: Blob;
  mimeType: string;
  /** e.g. 'segment-000012.webm' */
  fileName: string;
  /** ISO-639-1 or '' */
  language: string;
  /** Tail of the previous segment's text, for recognizer context ('' if none). */
  prompt: string;
  signal?: AbortSignal;
}

export interface TranscribeResult {
  text: string;
  via: SttTransport;
}

export type TranscribeFn = (input: TranscribeInput) => Promise<TranscribeResult>;

export type AppErrorCode =
  | "stt-not-configured"
  | "stt-unresolved"
  | "stt-failed"
  | "llm-not-configured"
  | "llm-failed"
  | "tts-failed"
  | "tts-unsupported"
  | "mic-denied"
  | "mic-unavailable"
  | "tab-audio-missing"
  | "recorder-unsupported"
  | "already-recording"
  | "decode-failed"
  | "file-too-large"
  | "storage-full"
  | "not-found"
  | "aborted"
  | "unknown";

/** Error carrying a stable code so the UI can localize it (lib code never
 * produces user-facing strings). `message` is a developer detail. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  constructor(code: AppErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.name = "AppError";
    this.code = code;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Errors that mean "retrying this segment now is pointless until settings
 * change" — the queue pauses instead of burning attempts. */
export const BLOCKING_STT_ERRORS: readonly AppErrorCode[] = ["stt-not-configured", "stt-unresolved"];

export type Locale = "en" | "ja" | "zh-CN" | "zh-TW";
