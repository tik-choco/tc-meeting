import type { ChatMessage } from "@tik-choco/mistai";
import { AppError } from "../../types";
import { requestChatCompletion } from "./llm";
import type { LlmTask } from "./llm";

/** Remove only wrappers around the entire response, preserving text and timestamps inside. */
export function unwrapResponse(content: string): string {
  let text = content.trim();
  for (;;) {
    const fence = text.match(/^(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)(?:\r?\n)?\1$/);
    if (fence) { text = fence[2].trim(); continue; }
    const pairs = [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"]];
    const pair = pairs.find(([open, close]) => text.length >= 2 && text.startsWith(open) && text.endsWith(close));
    if (!pair) return text;
    text = text.slice(pair[0].length, -pair[1].length).trim();
  }
}

/** One assist call; cancellation also guards injected implementations and late deltas. */
export async function completeTask(messages: ChatMessage[], opts: {
  task: LlmTask;
  signal?: AbortSignal;
  onDelta?(full: string): void;
}): Promise<string> {
  const { signal } = opts;
  const aborted = () => new AppError("aborted", undefined, { cause: signal?.reason });
  let removeAbort = () => {};
  try {
    if (signal?.aborted) throw aborted();
    const start = () => requestChatCompletion(messages, {
      task: opts.task,
      signal,
      onDelta: opts.onDelta ? (_delta, full) => { if (!signal?.aborted) opts.onDelta?.(full); } : undefined,
    });
    const pending = signal ? new Promise<string>((resolve, reject) => {
      const onAbort = () => reject(aborted());
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
      Promise.resolve().then(() => {
        if (signal.aborted) throw aborted();
        return start();
      }).then(resolve, reject);
    }) : start();
    const result = await pending;
    if (signal?.aborted) throw aborted();
    if (!result.trim()) throw new AppError("llm-failed");
    return result.trim();
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw aborted();
    if (error instanceof AppError) throw error;
    throw new AppError("llm-failed", undefined, { cause: error });
  } finally {
    removeAbort();
  }
}
