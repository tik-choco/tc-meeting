import type { LockProvider } from "../db";

/** In-memory Web Locks service shared by isolated test tab heaps. */
export function testLocks(): LockProvider {
  const held = new Set<string>();
  const pending = new Map<string, (() => void)[]>();
  const request = (name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        const queue = pending.get(name);
        const index = queue?.indexOf(start) ?? -1;
        if (index >= 0) queue!.splice(index, 1);
        reject(new DOMException("", "AbortError"));
      };
      const start = () => {
        options.signal?.removeEventListener("abort", abort);
        held.add(name);
        Promise.resolve().then(() => callback({ name, mode: "exclusive" } as Lock)).then(resolve, reject).finally(() => {
          held.delete(name);
          pending.get(name)?.shift()?.();
        });
      };
      if (options.signal?.aborted) { abort(); return; }
      if (!held.has(name)) start();
      else if (options.ifAvailable) Promise.resolve().then(() => callback(null)).then(resolve, reject);
      else {
        const queue = pending.get(name) ?? [];
        queue.push(start); pending.set(name, queue);
        options.signal?.addEventListener("abort", abort, { once: true });
      }
    });
  return { request: request as LockManager["request"] };
}
