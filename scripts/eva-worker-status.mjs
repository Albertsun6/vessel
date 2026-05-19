#!/usr/bin/env node
// scripts/eva-worker-status.mjs — P6: 实时显示 active worktree 的三态
//
// 用法：
//   node scripts/eva-worker-status.mjs
//   pnpm eva:worker-status
//
// 三态检测逻辑：
//   Done ✅  — ~/.vessel/spawn-done/<name>.json 存在
//   Running 🤖 — claude 进程正以该 worktree 目录为 cwd 运行
//   Waiting 💬 — claude 进程运行，但后端有 pending permission 请求（检测端口）
//   Idle ⏸   — 无以上任一条件
//
// 不依赖外部 npm 包（裸 Node + ESM）。

import { existsSync, readFileSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EVA_JSON_PATH = path.join(REPO_ROOT, "eva.json");
const FLAG_DIR = path.join(homedir(), ".vessel", "spawn-done");

function color(text, code) {
  return process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function expandHome(p) {
  if (typeof p !== "string") return p;
  return p.startsWith("~/") || p === "~" ? path.join(homedir(), p.slice(1)) : p;
}

// ── 检测 claude 进程是否运行在 worktree 目录 ─────────────────────────────────
function isClaudeRunningAt(worktreePath) {
  const expanded = expandHome(worktreePath);
  if (!existsSync(expanded)) return false;
  // ps -eo pid,command 抓所有 claude 进程，看是否有 cwd 匹配
  const r = spawnSync("pgrep", ["-f", "claude"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return false;
  const pids = r.stdout.trim().split("\n");
  for (const pid of pids) {
    const p = pid.trim();
    if (!p) continue;
    const cwdRes = spawnSync("lsof", ["-p", p, "-d", "cwd", "-Fn"], { encoding: "utf8" });
    if (cwdRes.status === 0) {
      const lines = cwdRes.stdout.split("\n").filter((l) => l.startsWith("n"));
      for (const line of lines) {
        const procCwd = line.slice(1).trim();
        if (procCwd === expanded || procCwd.startsWith(expanded + "/")) return true;
      }
    }
  }
  return false;
}

// ── 检测 pending permission（通过 HTTP 探测 backend port） ────────────────────
function hasPendingPermission(port) {
  if (!port) return false;
  const r = spawnSync(
    "curl",
    ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "1",
     `http://localhost:${port}/api/permission/pending`],
    { encoding: "utf8" },
  );
  return r.stdout.trim() === "200";
}

// ── 读 spawn-done flag ───────────────────────────────────────────────────────
function getDoneFlag(name) {
  const flagFile = path.join(FLAG_DIR, `${name}.json`);
  if (!existsSync(flagFile)) return null;
  try {
    return JSON.parse(readFileSync(flagFile, "utf-8"));
  } catch {
    return { task_id: name, _error: "malformed" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

if (!existsSync(EVA_JSON_PATH)) {
  console.error("eva.json not found");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(EVA_JSON_PATH, "utf-8"));
const active = (raw.worktrees || []).filter((w) => w.status === "active");

console.log(`\nWorker status · ${new Date().toLocaleTimeString()}\n`);

if (active.length === 0) {
  console.log(color("  (no active worktrees in eva.json)", "37"));
  process.exit(0);
}

const COL_NAME  = 30;
const COL_BRANCH = 32;

const header = `${"WORKTREE".padEnd(COL_NAME)} ${"BRANCH".padEnd(COL_BRANCH)} STATE`;
console.log(color(header, "37"));
console.log(color("─".repeat(header.length), "37"));

for (const wt of active) {
  const name = wt.name ?? "?";
  const branch = wt.branch ?? "?";

  // ── state determination ──────────────────────────────────────────────────
  const doneFlag = getDoneFlag(name);

  let stateLabel;
  let stateDetail = "";

  if (doneFlag) {
    stateLabel = color("Done ✅", "32");
    const pr = doneFlag.pr_url ? `  pr: ${doneFlag.pr_url}` : "";
    const artifact = doneFlag.artifact_ok === false ? color("  ⚠ artifact_ok=false", "33") : "";
    stateDetail = `(awaiting collect${pr}${artifact})`;
  } else {
    const running = isClaudeRunningAt(wt.path ?? "");
    if (running) {
      const waiting = hasPendingPermission(wt.port);
      if (waiting) {
        stateLabel = color("Waiting 💬", "33");
        stateDetail = `(permission pending on :${wt.port})`;
      } else {
        stateLabel = color("Running 🤖", "36");
      }
    } else {
      stateLabel = color("Idle ⏸", "37");
      stateDetail = "(no claude process detected)";
    }
  }

  const row = `${name.slice(0, COL_NAME).padEnd(COL_NAME)} ${branch.slice(0, COL_BRANCH).padEnd(COL_BRANCH)} ${stateLabel}`;
  console.log(row + (stateDetail ? `  ${color(stateDetail, "37")}` : ""));

  // owns 摘要
  if (wt.owns && wt.owns.length > 0) {
    const owned = wt.owns.slice(0, 3).map((o) => o.replace(/#.*$/, "")).join(", ");
    const more = wt.owns.length > 3 ? ` +${wt.owns.length - 3}` : "";
    console.log(color(`  owns: ${owned}${more}`, "37"));
  }
}

console.log("");
console.log(color("Done ✅  = spawn-done flag exists  →  run: pnpm eva:collect", "37"));
console.log(color("Running 🤖 = claude process detected at worktree cwd", "37"));
console.log(color("Waiting 💬 = pending permission request on backend port", "37"));
console.log(color("Idle ⏸   = no running claude process", "37"));
console.log("");
