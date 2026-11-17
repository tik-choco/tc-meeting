import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdWakeLock } from "./wakeLock";

class Sentinel extends EventTarget {
  release = vi.fn(async () => { this.dispatchEvent(new Event("release")); });
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("wake lock", () => {
  let visibility: DocumentVisibilityState;
  beforeEach(() => {
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("reacquires after a visibility change and releases idempotently", async () => {
    const locks: Sentinel[] = [];
    const request = vi.fn(async () => { const lock = new Sentinel(); locks.push(lock); return lock; });
    vi.stubGlobal("navigator", { wakeLock: { request } });
    const release = holdWakeLock();
    await settle();
    expect(request).toHaveBeenCalledWith("screen");
    visibility = "hidden";
    await locks[0].release();
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    release();
    release();
    await settle();
    expect(locks[1].release).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("releases a request that settles after the caller already released", async () => {
    let resolve!: (lock: Sentinel) => void;
    const request = vi.fn(() => new Promise<Sentinel>(r => { resolve = r; }));
    vi.stubGlobal("navigator", { wakeLock: { request } });
    const release = holdWakeLock();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(request).toHaveBeenCalledTimes(1);
    release();
    const lock = new Sentinel();
    resolve(lock);
    await settle();
    expect(lock.release).toHaveBeenCalledTimes(1);
  });
  it("ignores unsupported platforms and permission denial", async () => {
    vi.stubGlobal("navigator", {});
    const first = holdWakeLock();
    first();
    vi.stubGlobal("navigator", { wakeLock: { request: vi.fn(async () => { throw new Error("denied"); }) } });
    const second = holdWakeLock();
    await settle();
    second();
  });
});
