import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLlmConfig, saveLlmConfig } from "@tik-choco/mistai/llm-config";
import { loadLocalSettings, loadSharedConfig, localSettingsAdapter, SETTINGS_KEY, subscribeLocalSettings, TASK_IDS } from "./settings";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("meeting AI settings", () => {
  it("uses safe defaults when storage is missing or malformed", () => {
    localStorage.setItem(SETTINGS_KEY, "{");
    expect(TASK_IDS).toEqual(["summary", "translate", "proofread"]);
    expect(loadLocalSettings()).toEqual({ tasks: { summary: { reasoningEffort: "none" }, translate: { reasoningEffort: "none" }, proofread: { reasoningEffort: "none" } }, roomProvide: {}, recentModels: [] });
    expect(loadSharedConfig()).toEqual(emptyLlmConfig());
  });

  it("defensively loads all tasks, sharing, and bounded unique recent models", () => {
    const refs = Array.from({ length: 10 }, (_, index) => ({ providerId: "p", model: `model-${index}` }));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      tasks: { summary: { ref: refs[0], reasoningEffort: "high" }, translate: { ref: refs[1], reasoningEffort: "low" }, proofread: { ref: refs[2], reasoningEffort: "medium" }, other: { reasoningEffort: "low" } },
      roomProvide: { room: { enabled: true, shared: [refs[1], refs[1], null, { model: "missing-provider" }] }, bad: "ignored" },
      recentModels: [refs[0], refs[0], null, ...refs.slice(1)],
    }));
    expect(loadLocalSettings()).toEqual({
      tasks: { summary: { ref: refs[0], reasoningEffort: "high" }, translate: { ref: refs[1], reasoningEffort: "low" }, proofread: { ref: refs[2], reasoningEffort: "medium" } },
      roomProvide: { room: { enabled: true, shared: [refs[1]] } },
      recentModels: refs.slice(0, 8),
    });
  });

  it("rejects malformed task fields and retains the shared default without migrating", () => {
    const config = emptyLlmConfig();
    config.defaultModel = { providerId: "p", model: "chat-model" };
    saveLlmConfig(config);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ tasks: {
      summary: { ref: { providerId: 42 }, reasoningEffort: "invalid" },
      translate: { ref: { providerId: "p", model: 42 }, reasoningEffort: "invalid" },
      proofread: { ref: { providerId: "p", model: 42 }, reasoningEffort: "invalid" },
    } }));
    expect(loadLocalSettings().tasks.summary).toEqual({ reasoningEffort: "none" });
    expect(loadLocalSettings().tasks.translate).toEqual({ reasoningEffort: "none" });
    expect(loadLocalSettings().tasks.proofread).toEqual({ reasoningEffort: "none" });
    expect(loadSharedConfig().defaultModel).toEqual(config.defaultModel);
  });

  it("loads existing settings without a proofread task and persists a new selection", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ tasks: { summary: { reasoningEffort: "high" } } }));
    const settings = loadLocalSettings();
    expect(settings.tasks.proofread).toEqual({ reasoningEffort: "none" });
    settings.tasks.proofread = { ref: { providerId: "p", model: "proof-model" }, reasoningEffort: "low" };
    localSettingsAdapter.set(settings);
    expect(loadLocalSettings().tasks.proofread).toEqual(settings.tasks.proofread);
  });

  it("notifies subscribers for same-tab and cross-tab changes, then unsubscribes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLocalSettings(listener);
    localSettingsAdapter.set({ tasks: { summary: { reasoningEffort: "low" } }, roomProvide: {}, recentModels: [] });
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent("storage", { key: SETTINGS_KEY }));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    localSettingsAdapter.set({ tasks: {}, roomProvide: {}, recentModels: [] });
    window.dispatchEvent(new StorageEvent("storage", { key: SETTINGS_KEY }));
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
