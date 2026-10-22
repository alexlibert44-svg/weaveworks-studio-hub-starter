import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Same models as ai.server.ts (kept local so this client-visible module never imports server-only code).
const GEMINI_PRIMARY_MODEL = "gemini-3.8-flash";
const GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite";

/**
 * Real pronunciation evaluation.
 *
 * The learner's recording is transcribed by a speech-to-text model and the
 * transcript is compared word-by-word with the target sentence. The learner is
 * never asked to grade themselves: the score below is derived from what was
 * actually recognised in the audio.
 */

const Input = z.object({
  /** Base64 (no data-url prefix) of the recorded audio. */
  audioBase64: z.string().min(100),
  /** MIME type of the recording, e.g. "audio/webm". */
  mimeType: z.string().min(3),
  /** Sentence or word the learner was asked to say, in the target language. */
  target: z.string().min(1),
  /** BCP-47 tag of the target language, e.g. "en-US". */
  locale: z.string().min(2),
});

export interface PronunciationResult {
  transcript: string;
  /** 0..1, from the share of target words actually recognised. */
  score: number;
  matched: string[];
  missed: string[];
  extra: string[];
}

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export const evaluatePronunciation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }): Promise<PronunciationResult> => {
    const gemini = process.env["GEMINI_API_KEY"];
    const key = process.env["LOVABLE_API_KEY"];
    if (!gemini && !key) throw new Error("Speech analysis is not configured for this project.");

    const bytes = Uint8Array.from(atob(data.audioBase64), (c) => c.charCodeAt(0));
    if (bytes.byteLength < 2048) {
      throw new Error("That recording was too short — please record again.");
    }

    const base = data.mimeType.split(";")[0] ?? "audio/webm";
    const language = data.locale.split("-")[0];
    // NVIDIA hosts Whisper-Large-v3 only over gRPC (grpc.nvcf.nvidia.com), which
    // this server cannot call; its REST transcription URL returns 404. The
    // NVIDIA_NIM_API_KEY secret is kept but unused. Gemini transcribes instead.
    const transcript = gemini
      ? await geminiTranscribe(gemini, data.audioBase64, base, data.locale)
      : await gatewayTranscribe(key as string, bytes, base, language);

    const targetWords = tokens(data.target);
    const heard = tokens(transcript);
    const pool = [...heard];
    const matched: string[] = [];
    const missed: string[] = [];

    for (const word of targetWords) {
      const exact = pool.indexOf(word);
      if (exact >= 0) {
        pool.splice(exact, 1);
        matched.push(word);
        continue;
      }
      // Accept a near-miss (a small inflection/spelling slip) as recognised.
      const close = pool.findIndex((h) => h.length > 3 && distance(h, word) <= 1);
      if (close >= 0) {
        pool.splice(close, 1);
        matched.push(word);
      } else {
        missed.push(word);
      }
    }

    const coverage = targetWords.length === 0 ? 0 : matched.length / targetWords.length;
    // Extra words the learner said dilute the score a little.
    const penalty = Math.min(pool.length * 0.05, 0.2);
    const score = transcript ? Math.max(0, Math.round((coverage - penalty) * 100) / 100) : 0;

    return { transcript, score, matched, missed, extra: pool };
  });

function failure(status: number, body: string): Error {
  if (status === 429 || status === 503) return new Error("Speech analysis is busy — try again shortly.");
  if (status === 402 || status === 403) return new Error("Speech analysis credits are unavailable for this project.");
  return new Error(`Speech analysis failed (${status}): ${body.slice(0, 160)}`);
}

/** Verbatim transcription with the owner's Gemini key; busy primary model falls back once. */
async function geminiTranscribe(key: string, audioBase64: string, mimeType: string, locale: string): Promise<string> {
  const prompt =
    `Transcribe exactly what is spoken in this audio (expected language: ${locale}). ` +
    "Write only the words actually heard, without correcting mistakes. If no speech is audible, return an empty string.";
  let last: Response | null = null;
  for (const model of [GEMINI_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL]) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: audioBase64 } }] }],
        generationConfig: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim().replace(/^"+|"+$/g, "");
    }
    last = res;
    if (res.status !== 429 && res.status !== 503) break;
  }
  throw failure(last?.status ?? 500, await last?.text().catch(() => "") ?? "");
}

async function gatewayTranscribe(key: string, bytes: Uint8Array, mimeType: string, language?: string): Promise<string> {
  const form = new FormData();
  form.append("model", "openai/gpt-4o-transcribe");
  form.append("file", new Blob([bytes], { type: mimeType }), `speech.${EXT[mimeType] ?? "webm"}`);
  if (language) form.append("language", language);
  const res = await fetch("https://ai.gateway.lovable.dev/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw failure(res.status, await res.text().catch(() => ""));
  return (((await res.json()) as { text?: string }).text ?? "").trim();
}

function distance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j] as number;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min((prev[j] as number) + 1, (prev[j - 1] as number) + 1, last + cost);
      last = temp;
    }
  }
  return prev[b.length] as number;
}
