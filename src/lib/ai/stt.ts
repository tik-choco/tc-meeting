import { MistaiError } from "@tik-choco/mistai";
import { isNetworkProviderBaseUrl, networkVoiceModelParam, resolveVoice, roomIdFromBaseUrl, subscribeLlmConfig } from "@tik-choco/mistai/llm-config";
import { AppError, type SttTransport, type TranscribeFn } from "../../types";
import { prepareSttAudio } from "../audio/sttAudio";
import { rooms } from "./network";
import { loadSharedConfig } from "./settings";

export type SttStatus = { configured: boolean; transport: SttTransport | null; model: string; problem?: "no-model" | "unresolved" };

function resolveStt() {
  const config = loadSharedConfig();
  const model = config.stt?.model.trim() ?? "";
  if (!model) return { status: { configured: false, transport: null, model: "", problem: "no-model" } as SttStatus, target: null };

  const target = resolveVoice(config, "stt");
  if (!target || (isNetworkProviderBaseUrl(target.baseUrl) && !roomIdFromBaseUrl(target.baseUrl).trim())) {
    return { status: { configured: false, transport: null, model, problem: "unresolved" } as SttStatus, target: null };
  }
  const transport: SttTransport = isNetworkProviderBaseUrl(target.baseUrl) ? "network" : "api";
  return { status: { configured: true, transport, model: target.model.trim() } as SttStatus, target };
}

export function getSttStatus(): SttStatus {
  return resolveStt().status;
}

export function subscribeSttStatus(cb: () => void): () => void {
  return subscribeLlmConfig(() => cb());
}

function abortError(signal?: AbortSignal, cause?: unknown): AppError {
  const reason = cause ?? signal?.reason;
  const detail = reason instanceof Error ? reason.message : "Request aborted";
  return new AppError("aborted", detail, { cause: reason });
}

// Room consumers do not expose cancellation; stop waiting without disconnecting
// the shared room, since other transcription requests may be using it.
function withAbort<T>(signal: AbortSignal | undefined, start: () => Promise<T>): Promise<T> {
  if (!signal) return start();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(abortError(signal)); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    Promise.resolve().then(() => {
      if (signal.aborted) throw abortError(signal);
      return start();
    }).then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function safeFileName(fileName: string): string {
  const safe = fileName.replace(/[\x00-\x1f\x7f"\\/:<>|?*]/g, "_").trim().slice(0, 255);
  return !safe || safe === "." || safe === ".." ? "segment.webm" : safe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function upstreamMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.error === "string") return payload.error;
  if (isRecord(payload.error) && typeof payload.error.message === "string") return payload.error.message;
  return typeof payload.message === "string" ? payload.message : undefined;
}

export const transcribe: TranscribeFn = async (input) => {
  if (input.signal?.aborted) throw abortError(input.signal);
  const { status, target } = resolveStt();
  if (!target || !status.transport) {
    throw new AppError(status.problem === "no-model" ? "stt-not-configured" : "stt-unresolved");
  }
  try {
    const text = await withAbort(input.signal, async () => {
      const prepared = await prepareSttAudio(input.audio, input.mimeType, safeFileName(input.fileName));
      if (input.signal?.aborted) throw abortError(input.signal);
      const fileName = prepared.fileName;
      if (status.transport === "network") {
        return rooms.requestRoomStt(roomIdFromBaseUrl(target.baseUrl).trim(), {
          audio: prepared.audio,
          model: networkVoiceModelParam(target.model),
          fileName,
        });
      }

      const form = new FormData();
      const audio = prepared.audio.type ? prepared.audio : prepared.audio.slice(0, prepared.audio.size, prepared.mimeType);
      form.append("file", audio, fileName);
      form.append("model", target.model.trim());
      if (input.language.trim()) form.append("language", input.language.trim());
      if (input.prompt.trim()) form.append("prompt", input.prompt.trim());
      form.append("response_format", "json");
      const apiKey = target.apiKey.trim();
      const response = await fetch(`${target.baseUrl.trim().replace(/\/+$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal: input.signal,
      });
      const body = await response.text();
      let payload: unknown;
      try { payload = JSON.parse(body) as unknown; } catch (error) {
        if (response.ok) throw new Error("Invalid transcription response JSON", { cause: error });
      }
      if (!response.ok) {
        const message = upstreamMessage(payload) || body.trim() || `Transcription request failed with ${response.status}`;
        throw new MistaiError("UPSTREAM_HTTP_ERROR", message, { status: response.status });
      }
      if (!isRecord(payload) || typeof payload.text !== "string") {
        throw new MistaiError("UPSTREAM_BAD_RESPONSE", "The provider returned an invalid transcription response.");
      }
      return payload.text;
    });
    if (input.signal?.aborted) throw abortError(input.signal);
    return { text, via: status.transport };
  } catch (error) {
    if (error instanceof AppError && error.code === "aborted") throw error;
    if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw abortError(input.signal, error);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppError("stt-failed", `Transcription failed: ${detail}`, { cause: error });
  }
};
