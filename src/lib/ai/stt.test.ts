import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLlmConfig, LLM_CONFIG_KEY, NETWORK_VOICE_AUTO_MODEL, networkProviderBaseUrl, saveLlmConfig } from "@tik-choco/mistai/llm-config";
import type { TranscribeInput } from "../../types";
import { rooms } from "./network";
import { getSttStatus, subscribeSttStatus, transcribe } from "./stt";

vi.mock("./network", () => ({ rooms: { requestRoomStt: vi.fn() } }));

const audio = new Blob(["audio"], { type: "audio/webm" });
const input: TranscribeInput = { audio, mimeType: "audio/webm", fileName: "segment.webm", language: "ja", prompt: "context" };

function configure(baseUrl: string, model = "speech-model", apiKey = "") {
  const config = emptyLlmConfig();
  config.providers = [{ id: "p", label: "Example", baseUrl, apiKey }];
  config.stt = { providerId: "p", model };
  saveLlmConfig(config);
}

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("STT configuration", () => {
  it("distinguishes missing, unresolved, API, and network models", () => {
    expect(getSttStatus()).toEqual({ configured: false, transport: null, model: "", problem: "no-model" });
    const missing = emptyLlmConfig();
    missing.stt = { model: "speech-model", providerId: "missing" };
    saveLlmConfig(missing);
    expect(getSttStatus()).toEqual({ configured: false, transport: null, model: "speech-model", problem: "unresolved" });
    configure("https://api.example.test/v1/");
    expect(getSttStatus()).toEqual({ configured: true, transport: "api", model: "speech-model" });
    configure(networkProviderBaseUrl("room-a"));
    expect(getSttStatus()).toEqual({ configured: true, transport: "network", model: "speech-model" });
    configure("mist-network://");
    expect(getSttStatus()).toEqual({ configured: false, transport: null, model: "speech-model", problem: "unresolved" });
  });

  it("maps configuration errors and resolves the latest settings on each call", async () => {
    await expect(transcribe(input)).rejects.toMatchObject({ code: "stt-not-configured" });
    const config = emptyLlmConfig();
    config.stt = { providerId: "missing", model: "speech-model" };
    saveLlmConfig(config);
    await expect(transcribe(input)).rejects.toMatchObject({ code: "stt-unresolved" });
    configure(networkProviderBaseUrl("first"), NETWORK_VOICE_AUTO_MODEL);
    vi.mocked(rooms.requestRoomStt).mockResolvedValue("words");
    await expect(transcribe(input)).resolves.toEqual({ text: "words", via: "network" });
    configure(networkProviderBaseUrl("second"), "other-model");
    await transcribe(input);
    expect(rooms.requestRoomStt).toHaveBeenNthCalledWith(1, "first", { audio, model: undefined, fileName: "segment.webm" });
    expect(rooms.requestRoomStt).toHaveBeenNthCalledWith(2, "second", { audio, model: "other-model", fileName: "segment.webm" });
  });

  it("subscribes to both local shared-config saves and cross-tab changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSttStatus(listener);
    configure("https://api.example.test");
    window.dispatchEvent(new StorageEvent("storage", { key: LLM_CONFIG_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    configure("https://api.example.test");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("STT requests", () => {
  it("posts sanitized multipart fields and authentication for API requests", async () => {
    configure(" https://api.example.test/v1/// ", "  speech-model  ", "secret");
    const append = vi.spyOn(FormData.prototype, "append");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ text: "recognized" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await expect(transcribe({ ...input, fileName: 'folder/evil"\r\n\\clip.webm', language: " ja ", prompt: " context ", signal: controller.signal }))
      .resolves.toEqual({ text: "recognized", via: "api" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.test/v1/audio/transcriptions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer secret" });
    expect(init?.signal).toBe(controller.signal);
    const form = init?.body as FormData;
    // The test DOM ignores the filename argument for a Blob; inspect the actual append call.
    expect(append).toHaveBeenCalledWith("file", audio, "folder_evil____clip.webm");
    expect((form.get("file") as File).type).toBe("audio/webm");
    expect(form.get("model")).toBe("speech-model");
    expect(form.get("language")).toBe("ja");
    expect(form.get("prompt")).toBe("context");
    expect(form.get("response_format")).toBe("json");
  });

  it("omits empty optional hints and permits an empty recognized transcript", async () => {
    configure("https://api.example.test");
    const append = vi.spyOn(FormData.prototype, "append");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ text: "" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribe({ ...input, language: "  ", prompt: "", fileName: ".." })).resolves.toEqual({ text: "", via: "api" });
    const init = fetchMock.mock.calls[0][1];
    const form = init?.body as FormData;
    expect(form.has("language")).toBe(false);
    expect(form.has("prompt")).toBe(false);
    expect(append).toHaveBeenCalledWith("file", audio, "segment.webm");
    expect(init?.headers).toEqual({});
  });

  it("uses the supplied MIME type when the stored Blob has none", async () => {
    configure("https://api.example.test");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ text: "recognized" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await transcribe({ ...input, audio: new Blob(["audio"]), mimeType: "audio/wav" });
    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect((form.get("file") as File).type).toBe("audio/wav");
  });

  it("maps upstream and malformed-response failures and retains their causes", async () => {
    configure("https://api.example.test");
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribe(input)).rejects.toMatchObject({ code: "stt-failed", message: expect.stringContaining("quota exceeded"), cause: expect.objectContaining({ message: "quota exceeded" }) });
    await expect(transcribe(input)).rejects.toMatchObject({ code: "stt-failed", cause: expect.objectContaining({ code: "UPSTREAM_BAD_RESPONSE" }) });

    const upstream = new Error("peer disconnected");
    configure(networkProviderBaseUrl("room-a"));
    vi.mocked(rooms.requestRoomStt).mockRejectedValueOnce(upstream);
    await expect(transcribe(input)).rejects.toMatchObject({ code: "stt-failed", message: expect.stringContaining(upstream.message), cause: upstream });
  });

  it("aborts promptly without disconnecting a shared network request", async () => {
    configure(networkProviderBaseUrl("room-a"));
    vi.mocked(rooms.requestRoomStt).mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const result = transcribe({ ...input, signal: controller.signal, fileName: "a/b.webm" });
    const assertion = expect(result).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(rooms.requestRoomStt).toHaveBeenCalled());
    expect(rooms.requestRoomStt).toHaveBeenCalledWith("room-a", { audio, model: "speech-model", fileName: "a_b.webm" });
    controller.abort();
    await assertion;
    await expect(transcribe({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(rooms.requestRoomStt).toHaveBeenCalledTimes(1);
  });

  it("maps an upstream AbortError even without a signal", async () => {
    configure("https://api.example.test");
    const error = new DOMException("cancelled", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    await expect(transcribe(input)).rejects.toMatchObject({ code: "aborted", cause: error });
  });

  it("passes an abort signal to API fetch and stops waiting", async () => {
    configure("https://api.example.test");
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = transcribe({ ...input, signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
    controller.abort();
    await assertion;
  });
});
