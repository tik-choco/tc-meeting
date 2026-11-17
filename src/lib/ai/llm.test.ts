import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLlmConfig, networkProviderBaseUrl, saveLlmConfig } from "@tik-choco/mistai/llm-config";
import type { ChatMessage } from "@tik-choco/mistai";
import { isLlmConfigured, requestChatCompletion } from "./llm";
import { rooms } from "./network";
import { saveLocalSettings } from "./settings";

vi.mock("./network", () => ({ rooms: { requestRoomChat: vi.fn() } }));

const messages: ChatMessage[] = [{ role: "user", content: "meeting text" }];

function configure(baseUrl: string) {
  const config = emptyLlmConfig();
  config.providers = [{ id: "p", label: "Example", baseUrl, apiKey: "secret" }];
  config.defaultModel = { providerId: "p", model: "default-model" };
  saveLlmConfig(config);
}

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("summary chat completion", () => {
  it("checks configuration synchronously for each task without network calls", () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect(isLlmConfigured()).toBe(false);
    expect(isLlmConfigured("translate")).toBe(false);
    expect(isLlmConfigured("proofread")).toBe(false);
    configure("https://api.example.test");
    expect(isLlmConfigured()).toBe(true);
    expect(isLlmConfigured("translate")).toBe(true);
    expect(isLlmConfigured("proofread")).toBe(true);
    configure("mist-network://");
    expect(isLlmConfigured("translate")).toBe(false);
    expect(isLlmConfigured("proofread")).toBe(false);
    configure(networkProviderBaseUrl("room-a"));
    expect(isLlmConfigured()).toBe(true);
    const config = emptyLlmConfig();
    config.providers = [{ id: "p", label: "Example", baseUrl: "https://api.example.test", apiKey: "", enabled: false }];
    config.defaultModel = { providerId: "p", model: "chat-model" };
    saveLlmConfig(config);
    expect(isLlmConfigured()).toBe(false);
    saveLlmConfig({ ...config, providers: config.providers.map(provider => ({ ...provider, enabled: true })), defaultModel: undefined });
    saveLocalSettings({ tasks: {
      translate: { ref: { providerId: "p", model: "translation-model" }, reasoningEffort: "low" },
      proofread: { ref: { providerId: "p", model: "proof-model" }, reasoningEffort: "low" },
    }, roomProvide: {}, recentModels: [] });
    expect(isLlmConfigured()).toBe(false);
    expect(isLlmConfigured("translate")).toBe(true);
    expect(isLlmConfigured("proofread")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rooms.requestRoomChat).not.toHaveBeenCalled();
  });

  it.each([undefined, { reasoningEffort: "low" as const }])("translation with no ref inherits summary model and effort (%j)", async translate => {
    configure(networkProviderBaseUrl("room-a"));
    saveLocalSettings({ tasks: {
      summary: { ref: { providerId: "p", model: "summary-model" }, reasoningEffort: "high" },
      ...(translate ? { translate } : {}),
    }, roomProvide: {}, recentModels: [] });
    vi.mocked(rooms.requestRoomChat).mockResolvedValue("translation");
    await expect(requestChatCompletion(messages, { task: "translate" })).resolves.toBe("translation");
    expect(rooms.requestRoomChat).toHaveBeenCalledWith("room-a", messages, expect.objectContaining({ model: "summary-model", reasoningEffort: "high" }));
  });

  it("translation uses its own ref and effort and does not alter summary routing", async () => {
    configure(networkProviderBaseUrl("room-a"));
    saveLocalSettings({ tasks: {
      summary: { ref: { providerId: "p", model: "summary-model" }, reasoningEffort: "high" },
      translate: { ref: { providerId: "p", model: "translation-model" }, reasoningEffort: "low" },
    }, roomProvide: {}, recentModels: [] });
    vi.mocked(rooms.requestRoomChat).mockResolvedValue("content");
    await requestChatCompletion(messages, { task: "translate" });
    await requestChatCompletion(messages);
    expect(rooms.requestRoomChat).toHaveBeenNthCalledWith(1, "room-a", messages, expect.objectContaining({ model: "translation-model", reasoningEffort: "low" }));
    expect(rooms.requestRoomChat).toHaveBeenNthCalledWith(2, "room-a", messages, expect.objectContaining({ model: "summary-model", reasoningEffort: "high" }));
  });

  it("translation inherits summary effort even when using the shared default model", async () => {
    configure(networkProviderBaseUrl("room-a"));
    saveLocalSettings({ tasks: { summary: { reasoningEffort: "medium" } }, roomProvide: {}, recentModels: [] });
    vi.mocked(rooms.requestRoomChat).mockResolvedValue("content");
    await requestChatCompletion(messages, { task: "translate" });
    expect(rooms.requestRoomChat).toHaveBeenCalledWith("room-a", messages, expect.objectContaining({ model: "default-model", reasoningEffort: "medium" }));
  });

  it("an explicit but unresolved translation ref falls back to shared default, not summary", async () => {
    configure(networkProviderBaseUrl("room-a"));
    saveLocalSettings({ tasks: {
      summary: { ref: { providerId: "p", model: "summary-model" }, reasoningEffort: "high" },
      translate: { ref: { providerId: "missing", model: "translation-model" }, reasoningEffort: "low" },
    }, roomProvide: {}, recentModels: [] });
    vi.mocked(rooms.requestRoomChat).mockResolvedValue("content");
    await requestChatCompletion(messages, { task: "translate" });
    expect(rooms.requestRoomChat).toHaveBeenCalledWith("room-a", messages, expect.objectContaining({ model: "default-model", reasoningEffort: "low" }));
  });

  it.each([undefined, { reasoningEffort: "low" as const }])("proofread with no ref inherits summary model and effort (%j)", async proofread => {
    configure(networkProviderBaseUrl("room-a"));
    saveLocalSettings({ tasks: {
      summary: { ref: { providerId: "p", model: "summary-model" }, reasoningEffort: "high" },
      translate: { ref: { providerId: "p", model: "translation-model" }, reasoningEffort: "low" },
      ...(proofread ? { proofread } : {}),
    }, roomProvide: {}, recentModels: [] });
    vi.mocked(rooms.requestRoomChat).mockResolvedValue("corrected");
    await expect(requestChatCompletion(messages, { task: "proofread" })).resolves.toBe("corrected");
    expect(rooms.requestRoomChat).toHaveBeenCalledWith("room-a", messages, expect.objectContaining({ model: "summary-model", reasoningEffort: "high" }));
  });

  it("proofread uses its own ref and effort independently of the other tasks", async () => {
    configure(networkProviderBaseUrl("room-a"));
    saveLocalSettings({ tasks: {
      summary: { ref: { providerId: "p", model: "summary-model" }, reasoningEffort: "high" },
      translate: { ref: { providerId: "p", model: "translation-model" }, reasoningEffort: "medium" },
      proofread: { ref: { providerId: "p", model: "proof-model" }, reasoningEffort: "low" },
    }, roomProvide: {}, recentModels: [] });
    vi.mocked(rooms.requestRoomChat).mockResolvedValue("content");
    await requestChatCompletion(messages, { task: "proofread" });
    await requestChatCompletion(messages, { task: "translate" });
    await requestChatCompletion(messages);
    expect(rooms.requestRoomChat).toHaveBeenNthCalledWith(1, "room-a", messages, expect.objectContaining({ model: "proof-model", reasoningEffort: "low" }));
    expect(rooms.requestRoomChat).toHaveBeenNthCalledWith(2, "room-a", messages, expect.objectContaining({ model: "translation-model", reasoningEffort: "medium" }));
    expect(rooms.requestRoomChat).toHaveBeenNthCalledWith(3, "room-a", messages, expect.objectContaining({ model: "summary-model", reasoningEffort: "high" }));
  });

  it("proofread inherits summary effort when using the shared default model", async () => {
    configure(networkProviderBaseUrl("room-a"));
    saveLocalSettings({ tasks: {
      summary: { reasoningEffort: "medium" },
      translate: { ref: { providerId: "p", model: "translation-model" }, reasoningEffort: "low" },
    }, roomProvide: {}, recentModels: [] });
    vi.mocked(rooms.requestRoomChat).mockResolvedValue("content");
    await requestChatCompletion(messages, { task: "proofread" });
    expect(rooms.requestRoomChat).toHaveBeenCalledWith("room-a", messages, expect.objectContaining({ model: "default-model", reasoningEffort: "medium" }));
  });

  it("an explicit but unresolved proofread ref uses the shared default with its own effort", async () => {
    configure(networkProviderBaseUrl("room-a"));
    saveLocalSettings({ tasks: {
      summary: { ref: { providerId: "p", model: "summary-model" }, reasoningEffort: "high" },
      proofread: { ref: { providerId: "missing", model: "proof-model" }, reasoningEffort: "low" },
    }, roomProvide: {}, recentModels: [] });
    vi.mocked(rooms.requestRoomChat).mockResolvedValue("content");
    await requestChatCompletion(messages, { task: "proofread" });
    expect(rooms.requestRoomChat).toHaveBeenCalledWith("room-a", messages, expect.objectContaining({ model: "default-model", reasoningEffort: "low" }));
  });

  it('does not start work for an already aborted request', async () => {
    configure('https://api.example.test');
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController(); controller.abort();
    await expect(requestChatCompletion(messages, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rooms.requestRoomChat).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('stops waiting for network chat and ignores its late %s', async outcome => {
    configure(networkProviderBaseUrl('room-a'));
    let finish!: (content: string) => void;
    let fail!: (error: Error) => void;
    let lateDelta: ((delta: string, full: string) => void) | undefined;
    vi.mocked(rooms.requestRoomChat).mockImplementationOnce((_room, _messages, options) => {
      if (typeof options === 'object') lateDelta = options.onDelta;
      return new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
    });
    const controller = new AbortController();
    const onDelta = vi.fn();
    const result = requestChatCompletion(messages, { signal: controller.signal, onDelta });
    const assertion = expect(result).rejects.toMatchObject({ code: 'aborted' });
    await vi.waitFor(() => expect(rooms.requestRoomChat).toHaveBeenCalledTimes(1));
    controller.abort(); await assertion;
    lateDelta?.('late', 'late');
    if (outcome === 'resolve') finish('late minutes'); else fail(new Error('late failure'));
    await Promise.resolve();
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('passes cancellation through fetch while a streamed HTTP body is in flight', async () => {
    configure('https://api.example.test');
    const controller = new AbortController();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(streamController) { bodyController = streamController; } });
    let bodyAborted = false;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      init?.signal?.addEventListener('abort', () => {
        bodyAborted = true;
        bodyController.error(new DOMException('Cancelled', 'AbortError'));
      }, { once: true });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onDelta = vi.fn();
    const result = requestChatCompletion(messages, { signal: controller.signal, onDelta });
    const assertion = expect(result).rejects.toMatchObject({ code: 'aborted' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    bodyController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"draft"}}]}\n\n'));
    await vi.waitFor(() => expect(onDelta).toHaveBeenCalledWith('draft', 'draft'));
    controller.abort();
    await assertion;
    expect(bodyAborted).toBe(true);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it("rejects missing or invalid configuration", async () => {
    await expect(requestChatCompletion(messages)).rejects.toMatchObject({ code: "llm-not-configured" });
    configure("mist-network://");
    await expect(requestChatCompletion(messages)).rejects.toMatchObject({ code: "llm-not-configured" });
  });

  it("uses the task model and effort for API chat, reporting the full response", async () => {
    configure("https://api.example.test/v1/");
    saveLocalSettings({ tasks: { summary: { ref: { providerId: "p", model: "summary-model" }, reasoningEffort: "high" } }, roomProvide: {}, recentModels: [] });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "minutes" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    await expect(requestChatCompletion(messages, { onDelta })).resolves.toBe("minutes");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.test/v1/chat/completions");
    expect(JSON.parse(init?.body as string)).toMatchObject({ model: "summary-model", reasoning_effort: "high", messages });
    expect(onDelta).toHaveBeenCalledWith("minutes", "minutes");
  });

  it("falls back to the shared default and forwards network deltas", async () => {
    configure(networkProviderBaseUrl("room-a"));
    vi.mocked(rooms.requestRoomChat).mockImplementation(async (_room, _messages, options) => {
      if (typeof options === "object") {
        options.onDelta?.("first", "first");
        options.onDelta?.(" second", "first second");
      }
      return "first second";
    });
    const onDelta = vi.fn();
    await expect(requestChatCompletion(messages, { onDelta })).resolves.toBe("first second");
    expect(rooms.requestRoomChat).toHaveBeenCalledWith("room-a", messages, expect.objectContaining({ model: "default-model", reasoningEffort: "none" }));
    expect(onDelta).toHaveBeenNthCalledWith(2, " second", "first second");
  });

  it("accumulates streamed API deltas for consumers", async () => {
    configure("https://api.example.test");
    const stream = [
      'data: {"choices":[{"delta":{"content":"first"}}]}',
      'data: {"choices":[{"delta":{"content":" second"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const onDelta = vi.fn();
    await expect(requestChatCompletion(messages, { onDelta })).resolves.toBe("first second");
    expect(onDelta).toHaveBeenNthCalledWith(1, "first", "first");
    expect(onDelta).toHaveBeenNthCalledWith(2, " second", "first second");
  });

  it("retains the original cause and detail for network, API, and empty responses", async () => {
    configure(networkProviderBaseUrl("room-a"));
    const cause = new Error("connection lost");
    vi.mocked(rooms.requestRoomChat).mockRejectedValueOnce(cause).mockResolvedValueOnce("  ");
    await expect(requestChatCompletion(messages)).rejects.toMatchObject({ code: "llm-failed", message: expect.stringContaining("connection lost"), cause });
    await expect(requestChatCompletion(messages)).rejects.toMatchObject({ code: "llm-failed", message: expect.stringContaining("empty response") });

    configure("https://api.example.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("service unavailable", { status: 503 })));
    await expect(requestChatCompletion(messages)).rejects.toMatchObject({ code: "llm-failed", message: expect.stringContaining("service unavailable"), cause: expect.any(Error) });
  });
});
