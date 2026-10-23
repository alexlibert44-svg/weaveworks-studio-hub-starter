import { useCallback, useEffect, useRef, useState } from "react";

/** Visual estimate only: generation does not publish measured progress. */
export function useGenerationProgress() {
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<"idle" | "pending" | "complete">("idle");
  const completionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (phase !== "pending") return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setProgress(0.9 * (1 - Math.exp(-(Date.now() - startedAt) / 30_000)));
    }, 100);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => () => {
    if (completionTimer.current !== null) clearTimeout(completionTimer.current);
  }, []);

  const start = useCallback(() => {
    setProgress(0);
    setPhase("pending");
  }, []);
  const stop = useCallback(() => setPhase("idle"), []);
  const complete = useCallback(async () => {
    setPhase("complete");
    setProgress(1);
    await new Promise<void>((resolve) => {
      completionTimer.current = setTimeout(() => {
        completionTimer.current = null;
        resolve();
      }, 450);
    });
  }, []);

  return { progress, start, stop, complete };
}