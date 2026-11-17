import { emptyLlmConfig, isModelRef, loadLlmConfig } from "@tik-choco/mistai/llm-config";
import type { ModelRefV1, SharedLlmConfigV1 } from "@tik-choco/mistai/llm-config";
import { REASONING_EFFORT_OPTIONS } from "@tik-choco/mistai/preact";
import type { LlmLocalSettings, LlmSettingsLocalAdapter, ReasoningEffort } from "@tik-choco/mistai/preact";

export const SETTINGS_KEY = "tc-meeting:settings-v1";
export const TASK_IDS = ["summary", "translate", "proofread"] as const;

const listeners = new Set<() => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueRefs(value: unknown): ModelRefV1[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter(isModelRef).filter((ref) => {
    const key = JSON.stringify([ref.providerId, ref.model]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((ref) => ({ providerId: ref.providerId, model: ref.model }));
}

export function loadSharedConfig(): SharedLlmConfigV1 {
  return loadLlmConfig() ?? emptyLlmConfig();
}

export function loadLocalSettings(): LlmLocalSettings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    if (isRecord(parsed)) raw = parsed;
  } catch { /* Invalid or inaccessible storage uses defaults. */ }

  const rawTasks = isRecord(raw.tasks) ? raw.tasks : {};
  const tasks: LlmLocalSettings["tasks"] = {};
  for (const id of TASK_IDS) {
    const task = isRecord(rawTasks[id]) ? rawTasks[id] : {};
    const ref = isModelRef(task.ref) ? { providerId: task.ref.providerId, model: task.ref.model } : undefined;
    const reasoningEffort = REASONING_EFFORT_OPTIONS.includes(task.reasoningEffort as ReasoningEffort)
      ? task.reasoningEffort as ReasoningEffort : "none";
    tasks[id] = { ...(ref ? { ref } : {}), reasoningEffort };
  }

  const roomProvide: LlmLocalSettings["roomProvide"] = Object.create(null) as LlmLocalSettings["roomProvide"];
  if (isRecord(raw.roomProvide)) {
    for (const [id, value] of Object.entries(raw.roomProvide)) {
      if (isRecord(value)) roomProvide[id] = { enabled: value.enabled === true, shared: uniqueRefs(value.shared) };
    }
  }
  return {
    tasks,
    roomProvide,
    recentModels: uniqueRefs(raw.recentModels).slice(0, 8),
  };
}

export function saveLocalSettings(settings: LlmLocalSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    listeners.forEach((cb) => cb());
  } catch (error) {
    console.warn("tc-meeting: failed to persist local settings", error);
  }
}

export function subscribeLocalSettings(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (event: StorageEvent) => { if (event.key === SETTINGS_KEY || event.key === null) cb(); };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export const localSettingsAdapter: LlmSettingsLocalAdapter = {
  get: loadLocalSettings,
  set: saveLocalSettings,
  subscribe: subscribeLocalSettings,
};
