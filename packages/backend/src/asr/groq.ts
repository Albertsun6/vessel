import type { AsrClient, TranscribeOptions } from "./types.js";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

// Full whisper-large-v3 — highest Chinese accuracy; Groq runs it fast enough
// that the ~0.3s vs turbo difference is negligible. Override via GROQ_MODEL
// (e.g. whisper-large-v3-turbo for lower quota use, distil-whisper-large-v3-en
// for English-only fastest).
const GROQ_MODEL = process.env.GROQ_MODEL ?? "whisper-large-v3";

export class GroqAsrClient implements AsrClient {
  readonly name = "groq";

  constructor(private readonly apiKey: string) {}

  async transcribe(wavBuffer: Buffer, opts?: TranscribeOptions): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }), "audio.wav");
    form.append("model", GROQ_MODEL);
    form.append("language", opts?.language ?? "zh");
    form.append("response_format", "json");
    if (opts?.prompt) form.append("prompt", opts.prompt.slice(0, 224));

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Groq ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json = await res.json() as { text?: string };
    return json.text?.trim() ?? "";
  }
}
