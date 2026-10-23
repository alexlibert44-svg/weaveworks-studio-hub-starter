import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGenerationProgress } from "./use-generation-progress";

describe("Word Set estimated loading progression", () => {
  let value: ReturnType<typeof useGenerationProgress>;
  let root: ReturnType<typeof createRoot>;
  function Harness() {
    value = useGenerationProgress();
    return null;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness)));
    act(() => value.start());
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });
  it("grows without resetting on rerenders and stays below completion while pending", () => {
    act(() => vi.advanceTimersByTime(10_000));
    const first = value.progress;
    expect(first).toBeGreaterThan(0);
    act(() => root.render(createElement(Harness)));
    expect(value.progress).toBe(first);
    act(() => vi.advanceTimersByTime(10_000));
    expect(value.progress).toBeGreaterThan(first);
    act(() => vi.advanceTimersByTime(600_000));
    expect(value.progress).toBeLessThanOrEqual(0.9);
    expect(value.progress).toBeLessThan(1);
  });
  it("reaches 100% only on success and waits for the completion transition", async () => {
    let finished = false;
    act(() => { void value.complete().then(() => { finished = true; }); });
    expect(value.progress).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(449); });
    expect(finished).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(finished).toBe(true);
    expect(value.progress).toBe(1);
  });
  it("stops on failure without granting completion", () => {
    act(() => vi.advanceTimersByTime(5_000));
    act(() => value.stop());
    const stopped = value.progress;
    act(() => vi.advanceTimersByTime(60_000));
    expect(value.progress).toBe(stopped);
    expect(value.progress).toBeLessThan(1);
  });
});