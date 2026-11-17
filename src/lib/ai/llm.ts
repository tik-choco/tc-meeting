import { streamChatCompletion } from "@tik-choco/mistai";
import type { ChatMessage } from "@tik-choco/mistai";
import { providerKind, resolveModel, roomIdFromBaseUrl } from "@tik-choco/mistai/llm-config";
import { AppError } from "../../types";
import { rooms } from "./network";
import { loadLocalSettings, loadSharedConfig } from "./settings";

export type LlmTask = "summary" | "translate" | "proofread";

function resolveTask(id: LlmTask) {
  const { tasks } = loadLocalSettings();
  const selected = tasks[id];
  const task = id !== "summary" && !selected?.ref ? tasks.summary : selected;
  const target = resolveModel(loadSharedConfig(), task?.ref);
  const roomId = target && providerKind(target) === "room" ? roomIdFromBaseUrl(target.baseUrl).trim() : undefined;
  return { target, roomId, reasoningEffort: task?.reasoningEffort ?? "none" };
}

/** Configuration hint only; does not probe a provider or room's availability. */
export function isLlmConfigured(task: LlmTask = "summary"): boolean {
  const { target, roomId } = resolveTask(task);
  return !!target && roomId !== "";
}

function aborted(signal: AbortSignal): AppError {
  return new AppError("aborted", undefined, { cause: signal.reason });
}

/** Room chat cannot cancel a remote job; stop waiting without disconnecting shared rooms. */
function withAbort(start: () => Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return start();
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(aborted(signal)); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw aborted(signal);
      return start();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function requestChatCompletion(
  messages: ChatMessage[],
  opts?: { onDelta?: (delta: string, full: string) => void; signal?: AbortSignal; task?: LlmTask },
): Promise<string> {
  if (opts?.signal?.aborted) throw aborted(opts.signal);
  const { target, roomId, reasoningEffort } = resolveTask(opts?.task ?? "summary");
  if (!target || roomId === "") throw new AppError("llm-not-configured");

  try {
    let full = "";
    const onDelta = (delta: string, text: string) => { if (!opts?.signal?.aborted) opts?.onDelta?.(delta, text); };
    const content = await withAbort(() => roomId !== undefined
      ? rooms.requestRoomChat(roomId, messages, {
        model: target.model,
        reasoningEffort,
        onDelta,
      })
      : streamChatCompletion(
        { ...target, baseUrl: target.baseUrl.trim(), reasoningEffort },
        messages,
        (delta) => { full += delta; onDelta(delta, full); },
        // The shared streaming client accepts a fetch adapter, but no signal.
        (url, init) => fetch(url, { ...init, signal: opts?.signal }),
      ), opts?.signal);
    if (!content.trim()) throw new Error("The provider returned an empty response.");
    return content;
  } catch (error) {
    if (opts?.signal?.aborted) throw aborted(opts.signal);
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppError("llm-failed", `Chat completion failed: ${detail}`, { cause: error });
  }
}
