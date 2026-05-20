import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import os from "node:os";
import type { AsrClient, TranscribeOptions } from "./types.js";

const WHISPER_BIN = process.env.WHISPER_BIN ?? "whisper-cli";

export function resolveWhisperModel(): string {
  if (process.env.WHISPER_MODEL) return process.env.WHISPER_MODEL;
  const dir = path.join(os.homedir(), ".whisper-models");
  const candidates = [
    "ggml-large-v3.bin",
    "ggml-large-v3-turbo.bin",
    "ggml-large-v3-turbo-q5_0.bin",
  ];
  for (const f of candidates) {
    const p = path.join(dir, f);
    if (existsSync(p)) return p;
  }
  return path.join(dir, "ggml-large-v3-turbo-q5_0.bin");
}

function run(
  cmd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", () => {});
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, code: code ?? 0 }); });
  });
}

export class WhisperCppClient implements AsrClient {
  readonly name = "whisper-cpp";

  async transcribe(wavBuffer: Buffer, opts?: TranscribeOptions): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "asr-whisper-"));
    const wavPath = path.join(dir, "in.wav");
    const outPrefix = path.join(dir, "out");
    try {
      await writeFile(wavPath, wavBuffer);
      const model = resolveWhisperModel();
      const lang = opts?.language ?? "zh";
      const args = [
        "-m", model,
        "-l", lang,
        "-nt", "-np",
        "-otxt",
        "-of", outPrefix,
        wavPath,
      ];
      if (opts?.prompt) args.splice(args.indexOf("-otxt"), 0, "--prompt", opts.prompt);
      const result = await run(WHISPER_BIN, args, 60_000);
      if (result.code !== 0) throw new Error(`whisper-cli exited ${result.code}`);
      let text: string;
      try {
        text = (await readFile(`${outPrefix}.txt`, "utf-8")).trim();
      } catch {
        text = result.stdout
          .split("\n")
          .filter((l) => l && !l.startsWith("[") && !l.startsWith("ggml_") && !l.startsWith("load_"))
          .join("\n")
          .trim();
      }
      return text;
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
