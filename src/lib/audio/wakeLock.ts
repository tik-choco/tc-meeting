export function holdWakeLock(): () => void {
  let released = false;
  let pending = false;
  let lock: WakeLockSentinel | undefined;
  const release = (sentinel: WakeLockSentinel) => { void sentinel.release().catch(() => {}); };
  const acquire = async () => {
    if (released || pending || lock || document.visibilityState !== "visible" || !navigator.wakeLock) return;
    pending = true;
    try {
      const next = await navigator.wakeLock.request("screen");
      if (released || document.visibilityState !== "visible") release(next);
      else {
        lock = next;
        next.addEventListener("release", () => { if (lock === next) lock = undefined; }, { once: true });
      }
    } catch { /* Permission, power saving, and unsupported platforms are best effort. */ }
    finally { pending = false; }
  };
  const onVisibility = () => { void acquire(); };
  document.addEventListener("visibilitychange", onVisibility);
  void acquire();
  return () => {
    if (released) return;
    released = true;
    document.removeEventListener("visibilitychange", onVisibility);
    if (lock) release(lock);
    lock = undefined;
  };
}
