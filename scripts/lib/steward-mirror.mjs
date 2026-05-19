// Append-only ~/.vessel/backlog-mirror.jsonl (ADR-019 R2 mitigation).

import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const MIRROR_PATH = path.join(homedir(), ".vessel", "backlog-mirror.jsonl");
const SCHEMA = "vessel-backlog-mirror-v1";

export function appendMirrorEntry(entry) {
  const dir = path.dirname(MIRROR_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = {
    schema: SCHEMA,
    ts: new Date().toISOString(),
    ...entry,
  };
  appendFileSync(MIRROR_PATH, `${JSON.stringify(line)}\n`, "utf-8");
  return line;
}

/** Snapshot all items (baseline / post-validate). */
export function appendMirrorSnapshot(items, reason = "snapshot") {
  return appendMirrorEntry({ event: reason, items });
}

export function readMirrorLines() {
  if (!existsSync(MIRROR_PATH)) return [];
  return readFileSync(MIRROR_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      try {
        return { lineNo: i + 1, ...JSON.parse(line) };
      } catch (err) {
        return { lineNo: i + 1, _parseError: err.message, _raw: line };
      }
    });
}

/** Last snapshot or status event that contains full items[] for an id. */
export function findLastItemSnapshot(taskId) {
  const lines = readMirrorLines().reverse();
  for (const row of lines) {
    if (row.event === "status" && row.id === taskId && row.snapshot) {
      return row.snapshot;
    }
    if (Array.isArray(row.items)) {
      const hit = row.items.find((it) => it.id === taskId);
      if (hit) return hit;
    }
  }
  return null;
}

export function mirrorStats() {
  if (!existsSync(MIRROR_PATH)) return { lines: 0, bytes: 0 };
  const raw = readFileSync(MIRROR_PATH, "utf-8");
  return { lines: raw.split("\n").filter(Boolean).length, bytes: Buffer.byteLength(raw) };
}
