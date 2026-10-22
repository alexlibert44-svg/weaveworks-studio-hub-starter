/**
 * Pronunciation transcription provider chain: NVIDIA first, Gemini only when
 * NVIDIA genuinely fails. Used only by pronunciation evaluation.
 *
 * NVIDIA: Whisper-Large-v3 is served only over gRPC (not usable from this
 * server), so we use NVIDIA's REST chat endpoint with its audio-capable model
 * nvidia/nemotron-3-nano-omni-30b-a3b-reasoning, sending the recording as an
 * audio_url data URL (verified live: webm/opus and wav accepted).
 */
export const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
export const NVIDIA_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const NVIDIA_TIMEOUT_MS = 30_000;
/** After an auth/config error NVIDIA is skipped for this long instead of retried each recording. */
export const NVIDIA_CONFIG_COOLDOWN_MS = 10 * 60_000;

export type NvidiaFailure = { kind: "recoverable" | "config"; status: number | null; detail: string };

export const transcribeDeps = {
  fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
  now: () => Date.now(),
  log: (msg: string) => console.warn(msg),
};

let nvidiaDisabledUntil = 0;
let lastConfigFailure: NvidiaFailure | null = null;
export const resetNvidiaState = () => {
  nvidiaDisabledUntil = 0;
  lastConfigFailure = null;
};

/** Sanitised error text: no keys, single line, short. */
const clean = (s: string) => s.replace(/(nvapi-|AIza|Bearer\s+)[\w-]+/g, "$1***").replace(/\s+/g, " ").slice(0, 200);

async function nvidiaTranscribe(
  key: string,
  audioBase64: string,
  mimeType: string,
  locale: string,
): Promise<{ ok: true; text: string } | { ok: false; failure: NvidiaFailure }> {
  let res: Response;
  try {
    res = await transcribeDeps.fetch(NVIDIA_URL, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        temperature: 0,
        max_tokens: 800,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Transcribe exactly what is spoken (expected language: ${locale}). Output only the words heard, without correcting mistakes. If there is no speech, output nothing.`,
              },
              { type: "audio_url", audio_url: { url: `data:${mimeType};base64,${audioBase64}` } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(NVIDIA_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: string }).name ?? "Error";
    return { ok: false, failure: { kind: "recoverable", status: null, detail: name === "TimeoutError" ? "timeout" : `network: ${name}` } };
  }
  if (!res.ok) {
    const body = clean(await res.text().catch(() => ""));
    const recoverable = res.status === 408 || res.status === 429 || res.status >= 500;
    return { ok: false, failure: { kind: recoverable ? "recoverable" : "config", status: res.status, detail: body } };
  }
  try {
    const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("no content");
    return { ok: true, text: content.trim().replace(/^"+|"+$/g, "") };
  } catch {
    return { ok: false, failure: { kind: "recoverable", status: res.status, detail: "malformed response" } };
  }
}

export interface ChainResult {
  transcript: string;
  provider: "nvidia" | "gemini";
  nvidiaFailure: NvidiaFailure | null;
}

/**
 * NVIDIA first; on any NVIDIA failure the sanitised cause is logged and the
 * fallback runs. Auth/config errors (4xx other than 408/429) pause NVIDIA so
 * an invalid setup is not retried on every recording. Throws when no provider
 * produced a transcript.
 */
export async function transcribeWithFallback(input: {
  nvidiaKey?: string;
  audioBase64: string;
  mimeType: string;
  locale: string;
  fallback: (() => Promise<string>) | null;
}): Promise<ChainResult> {
  let failure: NvidiaFailure | null = null;
  if (input.nvidiaKey && transcribeDeps.now() >= nvidiaDisabledUntil) {
    const r = await nvidiaTranscribe(input.nvidiaKey, input.audioBase64, input.mimeType, input.locale);
    if (r.ok) return { transcript: r.text, provider: "nvidia", nvidiaFailure: null };
    failure = r.failure;
    if (failure.kind === "config") {
      nvidiaDisabledUntil = transcribeDeps.now() + NVIDIA_CONFIG_COOLDOWN_MS;
      lastConfigFailure = failure;
    }
    transcribeDeps.log(`[pronunciation] NVIDIA ${failure.kind} failure (${failure.status ?? "no status"}): ${failure.detail}`);
  } else if (input.nvidiaKey) {
    failure = lastConfigFailure;
    transcribeDeps.log(`[pronunciation] NVIDIA paused after config error (${failure?.status}); using fallback`);
  }
  if (!input.fallback) throw new Error("Speech analysis is unavailable right now. Please try again.");
  const transcript = await input.fallback();
  return { transcript, provider: "gemini", nvidiaFailure: failure };
}
