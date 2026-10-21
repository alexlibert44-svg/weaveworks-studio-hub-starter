/**
 * Single AI transport for all text and speech features.
 * When GEMINI_API_KEY is set, requests go directly to Google Gemini with the
 * owner's key; otherwise they use the built-in Lovable AI gateway.
 * Keys are read server-side only, at call time.
 */
const TIMEOUT_MS = 60_000;
/** Per-attempt timeout for Gemini text calls (bounded so retries stay within a reasonable total). */
const GEMINI_ATTEMPT_TIMEOUT_MS = 30_000;
/** Verified against the models list available to GEMINI_API_KEY (Oct 2026). */
export const GEMINI_PRIMARY_MODEL = "gemini-3.8-flash";
export const GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite";
const MAX_RETRY_AFTER_MS = 8_000;

type ChatBody = {
  model: string;
  messages: { role: string; content: string }[];
  response_format?: { type: string; json_schema?: { name: string; strict?: boolean; schema: Record<string, unknown> } };
};

/** Structured-output request: the provider must return JSON matching `schema`. */
export const jsonSchemaFormat = (name: string, schema: Record<string, unknown>) => ({
  type: "json_schema",
  json_schema: { name, strict: true, schema },
});

/**
 * Parses model JSON. Strips markdown fences and, when the model drops trailing
 * closing brackets (observed with Gemini Flash-Lite), appends exactly the
 * missing closers. Anything else that is not valid JSON still throws.
 */
export function parseAiJson(content: string): unknown {
  const cleaned = content.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (first) {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (const ch of cleaned) {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") {
        if (stack.pop() !== ch) throw first;
      }
    }
    if (inString || stack.length === 0) throw first;
    return JSON.parse(cleaned + stack.reverse().join(""));
  }
}

const retryable = (status: number) => status === 429 || status === 503;

function retryDelay(res: Response | null, attempt: number): number | null {
  const header = res?.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - Date.now();
    if (ms > MAX_RETRY_AFTER_MS) return null; // provider asks for longer than we can wait
    return Math.max(0, ms);
  }
  return Math.min(4_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

export const aiDeps = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), fetch: (...a: Parameters<typeof fetch>) => fetch(...a) };

/**
 * Gemini chat with at most two retries in total for transient 429/503/timeouts:
 * primary → primary (backoff) → fallback model. Permanent errors return at once.
 */
async function geminiChat(key: string, body: ChatBody): Promise<Response> {
  const plan = [GEMINI_PRIMARY_MODEL, GEMINI_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL];
  let last: Response | null = null;
  let lastError: unknown = null;
  for (let i = 0; i < plan.length; i++) {
    if (i > 0) {
      const wait = retryDelay(last, i - 1);
      if (wait === null) break;
      await aiDeps.sleep(wait);
    }
    try {
      const res = await aiDeps.fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ ...body, model: plan[i] }),
        signal: AbortSignal.timeout(GEMINI_ATTEMPT_TIMEOUT_MS),
      });
      if (res.ok || !retryable(res.status)) return res;
      last = res;
      lastError = null;
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name !== "TimeoutError" && name !== "AbortError") throw e;
      last = null;
      lastError = e;
    }
  }
  if (last) return last;
  throw lastError instanceof Error ? new Error("AI request timed out. Please try again.") : new Error("AI is unavailable.");
}

/** OpenAI-style chat completion. Returns the raw Response so callers keep their own error handling. */
export async function aiChat(body: ChatBody): Promise<Response> {
  const gemini = process.env["GEMINI_API_KEY"];
  if (gemini) return geminiChat(gemini, body);
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("AI is not configured for this project.");
  return fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "Lovable-API-Key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export const aiConfigured = () => Boolean(process.env["GEMINI_API_KEY"] || process.env["LOVABLE_API_KEY"]);

/** Wraps raw 16-bit mono PCM in a WAV header. */
function pcmToWav(pcm: Uint8Array, rate = 24000): ArrayBuffer {
  const buf = new ArrayBuffer(44 + pcm.length);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, pcm.length, true);
  new Uint8Array(buf, 44).set(pcm);
  return buf;
}

/** Speech synthesis with the owner's Gemini key. Returns null when no key is set (caller uses the built-in path). */
export async function geminiSpeech(prompt: string, model: string, voice: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const key = process.env["GEMINI_API_KEY"];
  if (!key) return null;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.replace(/^google\//, "")}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`tts-${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
  };
  const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new Error("tts-empty");
  const bin = atob(inline.data);
  const pcm = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? "")?.[1] ?? 24000);
  return { bytes: pcmToWav(pcm, rate), type: "audio/wav" };
}
