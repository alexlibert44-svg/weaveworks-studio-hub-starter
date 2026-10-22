// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NVIDIA_CONFIG_COOLDOWN_MS, resetNvidiaState, transcribeDeps, transcribeWithFallback } from "./transcribe";

const ok = (text: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });

let clock = 0;
beforeEach(() => {
  resetNvidiaState();
  clock = 1_000;
  transcribeDeps.now = () => clock;
  transcribeDeps.log = () => {};
});

const run = (fallback: (() => Promise<string>) | null) =>
  transcribeWithFallback({ nvidiaKey: "k", audioBase64: "AAAA", mimeType: "audio/webm", locale: "en-US", fallback });

describe("pronunciation transcription chain", () => {
  it("uses NVIDIA and never calls Gemini when NVIDIA succeeds", async () => {
    transcribeDeps.fetch = vi.fn(async () => ok("I like books"));
    const gemini = vi.fn(async () => "x");
    const r = await run(gemini);
    expect(r).toMatchObject({ transcript: "I like books", provider: "nvidia" });
    expect(gemini).not.toHaveBeenCalled();
  });

  it("falls back to Gemini when NVIDIA returns 503", async () => {
    transcribeDeps.fetch = vi.fn(async () => new Response("busy", { status: 503 }));
    const gemini = vi.fn(async () => "hello");
    const r = await run(gemini);
    expect(r.provider).toBe("gemini");
    expect(r.nvidiaFailure).toMatchObject({ kind: "recoverable", status: 503 });
    expect(gemini).toHaveBeenCalledOnce();
  });

  it("falls back on a network timeout", async () => {
    transcribeDeps.fetch = vi.fn(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    const r = await run(async () => "hi");
    expect(r.nvidiaFailure).toMatchObject({ status: null, detail: "timeout" });
  });

  it("throws a technical error when both providers fail", async () => {
    transcribeDeps.fetch = vi.fn(async () => new Response("down", { status: 500 }));
    await expect(run(async () => Promise.reject(new Error("Speech analysis is busy")))).rejects.toThrow("busy");
  });

  it("reports a 404 config error and does not retry NVIDIA during the cooldown", async () => {
    const fetch = vi.fn(async () => new Response("404 page not found", { status: 404 }));
    transcribeDeps.fetch = fetch;
    const first = await run(async () => "a");
    expect(first.nvidiaFailure).toMatchObject({ kind: "config", status: 404, detail: "404 page not found" });
    await run(async () => "b");
    expect(fetch).toHaveBeenCalledTimes(1);
    clock += NVIDIA_CONFIG_COOLDOWN_MS;
    await run(async () => "c");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
