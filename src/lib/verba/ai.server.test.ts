// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiChat, aiDeps, GEMINI_FALLBACK_MODEL, GEMINI_PRIMARY_MODEL } from "./ai.server";

const body = { model: "google/gemini-3.7-flash", messages: [{ role: "user", content: "hi" }] };
const res = (status: number, headers: Record<string, string> = {}) => new Response("{}", { status, headers });
let fetchMock: ReturnType<typeof vi.fn>;
const models = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).model);

beforeEach(() => {
  process.env["GEMINI_API_KEY"] = "test-key";
  fetchMock = vi.fn();
  aiDeps.fetch = fetchMock as unknown as typeof aiDeps.fetch;
  aiDeps.sleep = vi.fn(async () => {});
});
afterEach(() => { delete process.env["GEMINI_API_KEY"]; });

describe("Gemini retry and fallback", () => {
  it("uses the primary model once on success", async () => {
    fetchMock.mockResolvedValueOnce(res(200));
    expect((await aiChat(body)).status).toBe(200);
    expect(models()).toEqual([GEMINI_PRIMARY_MODEL]);
  });

  it("retries 503 once on primary, then really calls the fallback model", async () => {
    fetchMock.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    expect((await aiChat(body)).status).toBe(200);
    expect(models()).toEqual(["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite"]);
  });

  it("makes at most two retries and returns the last error when both models fail", async () => {
    fetchMock.mockResolvedValue(res(429));
    expect((await aiChat(body)).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(models()[2]).toBe(GEMINI_FALLBACK_MODEL);
  });

  it.each([400, 401, 403, 404])("does not retry or fall back on permanent %i", async (status) => {
    fetchMock.mockResolvedValueOnce(res(status));
    expect((await aiChat(body)).status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("respects a short Retry-After and stops when it is too long", async () => {
    fetchMock.mockResolvedValueOnce(res(429, { "retry-after": "2" })).mockResolvedValueOnce(res(200));
    await aiChat(body);
    expect(aiDeps.sleep).toHaveBeenCalledWith(2000);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(res(429, { "retry-after": "120" }));
    expect((await aiChat(body)).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries timeouts and throws a clear error if every attempt times out", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" }));
    await expect(aiChat(body)).rejects.toThrow("AI request timed out");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
