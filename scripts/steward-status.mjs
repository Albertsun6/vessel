#!/usr/bin/env node
// pnpm steward:status — one-shot Steward dashboard (BACKLOG + spawn-done + live sessions).
//
//   --json   full structured output

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseBacklogFile,
  backlogSummaryLine,
  countByStatus,
} from "./lib/steward-backlog.mjs";
import { mirrorStats } from "./lib/steward-mirror.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const FLAG_DIR = path.join(homedir(), ".vessel", "spawn-done");
const STALE_HOURS = 24;

const wantJson = process.argv.includes("--json");

function color(text, code) {
  return process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function loadSpawnFlags() {
  if (!existsSync(FLAG_DIR)) return [];
  const out = [];
  for (const f of readdirSync(FLAG_DIR).filter((x) => x.endsWith(".json"))) {
    try {
      const raw = readFileSync(path.join(FLAG_DIR, f), "utf-8");
      const parsed = JSON.parse(raw);
      const ageH = (Date.now() - Date.parse(parsed.completed_at ?? 0)) / 3_600_000;
      out.push({ ...parsed, _stale: ageH > STALE_HOURS, _ageH: ageH });
    } catch (err) {
      out.push({ task_id: f.replace(/\.json$/, ""), _error: err.message });
    }
  }
  return out.sort((a, b) => Date.parse(a.completed_at ?? 0) - Date.parse(b.completed_at ?? 0));
}

function loadSessionsJson() {
  try {
    const raw = execSync("pnpm eva:sessions --format json", {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function staleWarning(updatedAt) {
  if (!updatedAt) return null;
  const ageMs = Date.now() - Date.parse(updatedAt);
  if (ageMs > 72 * 3_600_000) return `Backlog stale (>72h since ${updatedAt})`;
  return null;
}

const parsed = parseBacklogFile();
const counts = countByStatus(parsed.allItems);
const flags = loadSpawnFlags();
const sessions = loadSessionsJson();
const mirror = mirrorStats();
const stale = staleWarning(parsed.updatedAt);

const inProgress = parsed.allItems.filter((it) => it.status === "in_progress").slice(0, 5);
const planned = parsed.allItems
  .filter((it) => it.status === "planned")
  .sort((a, b) => (a.priority ?? "P9").localeCompare(b.priority ?? "P9"))
  .slice(0, 3);

const payload = {
  generated: new Date().toISOString(),
  backlog: {
    updatedAt: parsed.updatedAt,
    stale: !!stale,
    counts,
    inProgress,
    plannedTop: planned,
  },
  mirror,
  spawnDone: flags,
  sessions,
};

if (wantJson) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

console.log(color("steward:status", "1"));
console.log(backlogSummaryLine(parsed));
if (parsed.updatedAt) console.log(`  最近更新: ${parsed.updatedAt}`);
if (stale) console.log(color(`  ⚠ ${stale}`, "33"));

if (inProgress.length) {
  console.log("\nIn progress:");
  for (const it of inProgress) {
    const kind = it.assigned_kind ? ` (${it.assigned_kind})` : "";
    console.log(`  • ${it.id}${kind} — ${it.title ?? ""}`);
  }
}

if (planned.length) {
  console.log("\nPlanned (top):");
  for (const it of planned) {
    console.log(`  • ${it.id} [${it.priority ?? "?"}] — ${it.title ?? ""}`);
  }
}

if (flags.length) {
  console.log("\nPending worker done (spawn-done):");
  for (const f of flags) {
    const tag = f._stale ? color(" STALE", "33") : "";
    console.log(`  • ${f.task_id}${tag} — ${f.summary ?? f.pr_url ?? "(no summary)"}`);
  }
  console.log(color("  → ack: ok 收线 <id>  then pnpm eva:collect --clear <id>", "37"));
}

if (sessions) {
  console.log(
    `\nLive Claude sessions: ${sessions.total} (${sessions.recentlyActive} active ≤5m, ${sessions.processesNoResume} no --resume)`,
  );
  for (const s of (sessions.sessions ?? []).slice(0, 5)) {
    const branch = s.branch ?? "?";
    const cwd = s.cwd ? path.basename(s.cwd) : "?";
    console.log(`  • pid ${s.pid} ${s.lastSeenAgo ?? "?"} @ ${cwd} [${branch}]`);
  }
} else {
  console.log("\nLive sessions: (eva:sessions unavailable on this platform)");
}

console.log(`\nMirror: ${mirror.lines} lines · run pnpm steward:validate [--mirror]`);
