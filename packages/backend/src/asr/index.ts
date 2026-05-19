import { WhisperCppClient } from "./whisper-cpp.js";
import { GroqAsrClient } from "./groq.js";
import { IflytekAsrClient } from "./iflytek.js";
import type { AsrClient, TranscribeOptions } from "./types.js";

export type { AsrClient, TranscribeOptions };
export { resolveWhisperModel } from "./whisper-cpp.js";

// Priority: iflytek → groq → whisper-cpp
// Set ASR_PROVIDER=iflytek|groq|whisper-cpp to pin a single provider.
// Default (auto): add all configured providers in priority order.
function buildChain(): AsrClient[] {
  const {
    ASR_PROVIDER,
    IFLYTEK_APPID,
    IFLYTEK_API_KEY,
    IFLYTEK_API_SECRET,
    GROQ_API_KEY,
  } = process.env;

  const iflytekOk = !!(IFLYTEK_APPID && IFLYTEK_API_KEY && IFLYTEK_API_SECRET);
  const groqOk = !!GROQ_API_KEY;

  if (ASR_PROVIDER && ASR_PROVIDER !== "auto") {
    switch (ASR_PROVIDER) {
      case "iflytek":
        if (iflytekOk)
          return [new IflytekAsrClient(IFLYTEK_APPID!, IFLYTEK_API_KEY!, IFLYTEK_API_SECRET!)];
        console.warn("[asr] ASR_PROVIDER=iflytek but credentials missing — falling through to auto");
        break;
      case "groq":
        if (groqOk) return [new GroqAsrClient(GROQ_API_KEY!)];
        console.warn("[asr] ASR_PROVIDER=groq but GROQ_API_KEY missing — falling through to auto");
        break;
      case "whisper-cpp":
        return [new WhisperCppClient()];
    }
  }

  const chain: AsrClient[] = [];
  if (iflytekOk) chain.push(new IflytekAsrClient(IFLYTEK_APPID!, IFLYTEK_API_KEY!, IFLYTEK_API_SECRET!));
  if (groqOk) chain.push(new GroqAsrClient(GROQ_API_KEY!));
  chain.push(new WhisperCppClient());

  const names = chain.map((c) => c.name).join(" → ");
  console.log(`[asr] provider chain: ${names}`);
  return chain;
}

// Singleton chain — built once at module load.
export const asrChain: AsrClient[] = buildChain();

export async function transcribeWithFallback(
  chain: AsrClient[],
  wavBuffer: Buffer,
  opts?: TranscribeOptions,
): Promise<{ text: string; provider: string }> {
  const errors: string[] = [];
  for (const client of chain) {
    try {
      const text = await client.transcribe(wavBuffer, opts);
      return { text, provider: client.name };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[asr] ${client.name} failed: ${msg}`);
      errors.push(`${client.name}: ${msg}`);
    }
  }
  throw new Error(`All ASR providers failed: ${errors.join("; ")}`);
}
