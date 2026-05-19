import crypto from "node:crypto";
import WebSocket from "ws";
import type { AsrClient, TranscribeOptions } from "./types.js";

const IFLYTEK_HOST = "iat-api.xfyun.cn";
const IFLYTEK_PATH = "/v2/iat";
const CHUNK_SIZE = 1280; // 40ms @ 16kHz 16bit mono
const CHUNK_INTERVAL_MS = 20; // send at 2× real-time so a 30s clip finishes in ~15s

function buildUrl(apiKey: string, apiSecret: string): string {
  const date = new Date().toUTCString();
  const sigOrigin = `host: ${IFLYTEK_HOST}\ndate: ${date}\nGET ${IFLYTEK_PATH} HTTP/1.1`;
  const sig = crypto.createHmac("sha256", apiSecret).update(sigOrigin).digest("base64");
  const authOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`;
  const auth = Buffer.from(authOrigin).toString("base64");
  return (
    `wss://${IFLYTEK_HOST}${IFLYTEK_PATH}` +
    `?authorization=${encodeURIComponent(auth)}` +
    `&date=${encodeURIComponent(date)}` +
    `&host=${IFLYTEK_HOST}`
  );
}

// Strip WAV RIFF header — find 'data' chunk and skip past its 4-byte size field.
function wavToPcm(wav: Buffer): Buffer {
  const idx = wav.indexOf(Buffer.from("data"));
  return idx === -1 ? wav : wav.slice(idx + 8);
}

function iflytekLang(lang?: string): string {
  if (lang === "en") return "en_us";
  return "zh_cn";
}

interface IflytekFrame {
  code: number;
  message: string;
  data?: {
    status: number;
    result?: { ws?: Array<{ cw: Array<{ w: string }> }> };
  };
}

export class IflytekAsrClient implements AsrClient {
  readonly name = "iflytek";

  constructor(
    private readonly appId: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {}

  transcribe(wavBuffer: Buffer, opts?: TranscribeOptions): Promise<string> {
    const pcm = wavToPcm(wavBuffer);
    const lang = iflytekLang(opts?.language);
    const url = buildUrl(this.apiKey, this.apiSecret);

    return new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url);
      const words: string[] = [];
      let done = false;

      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(globalTimer);
        ws.terminate();
        if (err) reject(err);
        else resolve(words.join("").trim());
      };

      const globalTimer = setTimeout(
        () => finish(new Error("iFlytek ASR timed out after 60s")),
        60_000,
      );

      ws.on("error", (err) => finish(err));

      ws.on("open", () => {
        const chunks: Buffer[] = [];
        for (let i = 0; i < pcm.length; i += CHUNK_SIZE) {
          chunks.push(pcm.slice(i, Math.min(i + CHUNK_SIZE, pcm.length)));
        }
        let idx = 0;

        const sendNext = () => {
          if (done || ws.readyState !== WebSocket.OPEN) return;

          if (idx >= chunks.length) {
            // terminal frame — empty audio, status=2
            ws.send(
              JSON.stringify({
                data: { status: 2, format: "audio/L16;rate=16000", encoding: "raw", audio: "" },
              }),
            );
            return;
          }

          const isFirst = idx === 0;
          const chunk = chunks[idx++];
          const msg: Record<string, unknown> = {
            data: {
              status: isFirst ? 0 : 1,
              format: "audio/L16;rate=16000",
              encoding: "raw",
              audio: chunk.toString("base64"),
            },
          };
          if (isFirst) {
            msg.common = { app_id: this.appId };
            msg.business = {
              language: lang,
              domain: "iat",
              accent: "mandarin",
              vad_eos: 3000,
              dwa: "wpgs",
              ptt: 0,
            };
          }

          ws.send(JSON.stringify(msg), () => {
            if (!done) setTimeout(sendNext, CHUNK_INTERVAL_MS);
          });
        };

        sendNext();
      });

      ws.on("message", (data) => {
        let frame: IflytekFrame;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (frame.code !== 0) {
          finish(new Error(`iFlytek error ${frame.code}: ${frame.message}`));
          return;
        }
        for (const seg of frame.data?.result?.ws ?? []) {
          for (const cw of seg.cw) words.push(cw.w);
        }
        if (frame.data?.status === 2) finish();
      });

      ws.on("close", () => finish());
    });
  }
}
