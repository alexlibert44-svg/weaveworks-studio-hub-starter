import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";

/**
 * Freemium layer (UI + gating only). There is NO payment system yet, so every
 * learner is on the Free plan. When real billing exists, replace
 * `fetchEntitlement` with a server-verified read (e.g. a subscriptions table
 * written only by a verified payment webhook) and enforce the same limits in
 * the database (trigger on word_sets insert, checks in premium server
 * functions). Never grant Premium from client state.
 */
export type Plan = "free" | "premium";

export const FREE_DAILY_SETS = 4;

/** UI-only freemium layer. Real entitlement and limit enforcement will plug in here later. */
export const PREMIUM_ENABLED = true;

async function fetchEntitlement(): Promise<Plan> {
  return "free";
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Creation timestamps (ms, UTC) of sets made within the rolling 24-hour window, oldest first. */
async function setsCreatedInWindow(deviceId: string): Promise<number[]> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("word_sets")
    .select("created_at")
    .eq("device_id", deviceId)
    .gte("created_at", since)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => new Date(r.created_at as string).getTime());
}

export function usePlan(deviceId: string) {
  const plan = useQuery({ queryKey: ["plan", deviceId], queryFn: fetchEntitlement });
  const today = useQuery({ queryKey: ["sets-today", deviceId], queryFn: () => setsCreatedInWindow(deviceId), enabled: PREMIUM_ENABLED });
  const [now, setNow] = useState(() => Date.now());
  const isPremium = !PREMIUM_ENABLED || plan.data === "premium";
  const active = (today.data ?? []).filter((ts) => ts + WINDOW_MS > now);
  const used = active.length;
  const limitReached = !isPremium && used >= FREE_DAILY_SETS;
  // When the limit is reached, the next slot frees exactly 24h after the oldest counted creation.
  const nextSlotAt = limitReached ? (active[used - FREE_DAILY_SETS] ?? now) + WINDOW_MS : null;

  useEffect(() => {
    if (nextSlotAt === null) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, Math.min(30_000, Math.max(250, nextSlotAt - Date.now())));
    return () => window.clearInterval(id);
  }, [nextSlotAt]);

  return {
    plan: plan.data ?? "free",
    isPremium,
    loaded: !PREMIUM_ENABLED || (plan.isSuccess && today.isSuccess),
    /** null = unlimited. */
    remaining: isPremium ? null : Math.max(0, FREE_DAILY_SETS - used),
    /** Epoch ms when the next creation slot opens, or null if one is available. */
    nextSlotAt,
  };
}
