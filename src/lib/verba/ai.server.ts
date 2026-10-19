/**
 * Single AI transport for all text and speech features.
 * When GEMINI_API_KEY is set, requests go directly to Google Gemini with the
 * owner's key; otherwise they use the built-in Lovable AI gateway.
 * Keys are read server-side only, at call time.
 */
const TIMEOUT_MS = 60_000;

type ChatBody = {
  model: string;
  messages: { role: string; content: string }[];
  response_format?: { type: string };
};

/** OpenAI-style chat completion. Returns the raw Response so callers keep their own error handling. */
export async function aiChat(body: ChatBody): Promise<Response> {
  const gemini = process.env["GEMINI_API_KEY"];
  if (gemini) {
    return fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${gemini}` },
      body: JSON.stringify({ ...body, model: body.model.replace(/^google\//, "") }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
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
