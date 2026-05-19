#!/usr/bin/env node
// scripts/eva-hook.mjs — manually invoke a worktree lifecycle hook (H13 v1).
//
// 用法：
//   pnpm eva:hook [--dry-run] [--verbose] [--yes] <hookName> <worktreeName>
//
// flags:
//   --dry-run     只打印解析后命令，不执行（cross M4）
//   --verbose     打印完整命令字符串（默认隐藏，cross M2 redact）
//   --yes         高危 hook（含 rm -rf / pkill / killall / git worktree remove /
//                 git push --force / chown / chmod 的）必须显式 --yes 才执行
//   --no-env-sync 跳过 post-start 的 .env* 自动同步（P5）
//
// hookName: pre-start | post-start | post-merge | pre-remove
// worktreeName: 对应 eva.json worktrees[].name 字段
//
// 行为：
//   1. 读 + 验证 eva.json（cross M1 修：CLI 复用 schema 等同校验）
//   2. 取 entry.hooks[hookName] 命令
//   3. pre-remove 允许 path 不存在（fall back to REPO_ROOT — cross m1 修），
//      其他 hook 仍要求 path 存在
//   4. **post-start 内置步骤（P4/P5，在用户 hook 命令之前运行）**：
//      P4: 写 <worktree>/.vessel-task-id（供 vessel-stop-hook.sh 自动触发 signal-done）
//      P5: 同步 REPO_ROOT 的 .env* 文件到 worktree 相同相对路径（--no-env-sync 跳过）
//   5. 在 worktree path（或 REPO_ROOT for pre-remove）下用 `bash -c` 执行用户 hook
//   6. **curated env**（cross M3 修）：strip BASH_ENV / ENV / SHELLOPTS / CDPATH，
//      只透传白名单
//   7. **redacted log**（cross M2 修）：默认隐藏 cmd 字面，--verbose 才打印；
//      --verbose 也对 TOKEN/SECRET/PASSWORD/KEY 模式做 redact
//   8. blocking 等结束，子进程退码即本进程退码

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { homedir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EVA_JSON_PATH = path.resolve(REPO_ROOT, "eva.json");

const VALID_STATUSES = new Set(["active", "done", "released"]);
const VALID_HOOK_KEYS = new Set(["pre-start", "post-start", "post-merge", "pre-remove"]);
const HOOK_CMD_MIN = 1;
const HOOK_CMD_MAX = 2000;
// 高危 hook 命令模式 — 含此类命令必须 --yes（cross M4 修）
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-r/i,
  /\brm\s+--recursive/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\bgit\s+worktree\s+remove\b/i,
  /\bgit\s+push\s+(-f|--force)/i,
  /\bchown\b/i,
  /\bchmod\s+-R/i,
];
// Env 白名单（cross M3 修）：只透传明确不敏感且 hook 常需的
const ENV_WHITELIST = new Set([
  "HOME", "PATH", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  // dev tooling commonly required
  "NVM_DIR", "PNPM_HOME", "HOMEBREW_PREFIX", "NPM_CONFIG_USERCONFIG",
]);
// Env strip 黑名单（即使 whitelist 没列也强制 strip）
const ENV_STRIP_ALWAYS = new Set(["BASH_ENV", "ENV", "SHELLOPTS", "CDPATH"]);

function fail(msg, code = 1) {
  console.error(`[31m✗[0m ${msg}`);
  process.exit(code);
}

function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p.startsWith("~/") || p === "~") return path.join(homedir(), p.slice(1));
  return p;
}

function parseFlags(argv) {
  const opts = { dryRun: false, verbose: false, yes: false, noEnvSync: false };
  const positional = [];
  for (const a of argv) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--verbose") opts.verbose = true;
    else if (a === "--yes") opts.yes = true;
    else if (a === "--no-env-sync") opts.noEnvSync = true;
    else if (a.startsWith("--")) fail(`unknown flag '${a}'`);
    else positional.push(a);
  }
  return { opts, positional };
}

/** Cross M1 修：CLI 校验对齐 shared schema (手写 mirror). */
function validateConfig(raw) {
  if (typeof raw !== "object" || raw === null) fail("eva.json must be JSON object");
  if (raw.version !== 1) fail(`eva.json version must be 1 (got ${JSON.stringify(raw.version)})`);
  if (!Array.isArray(raw.worktrees)) fail("eva.json worktrees must be array");
  for (const [i, w] of raw.worktrees.entries()) {
    const where = `worktrees[${i}]`;
    if (typeof w?.name !== "string" || !w.name) fail(`${where} missing or non-string name`);
    if (typeof w?.branch !== "string" || !w.branch) fail(`${where} missing branch`);
    if (typeof w?.path !== "string" || !w.path) fail(`${where} missing path`);
    if (!VALID_STATUSES.has(w.status)) fail(`${where} bad status='${w.status}'`);
    if (w.hooks !== undefined) {
      if (typeof w.hooks !== "object" || w.hooks === null || Array.isArray(w.hooks)) {
        fail(`${where}.hooks must be plain object`);
      }
      for (const [hk, hv] of Object.entries(w.hooks)) {
        if (!VALID_HOOK_KEYS.has(hk)) fail(`${where}.hooks unknown key '${hk}' (valid: ${[...VALID_HOOK_KEYS].join(", ")})`);
        if (typeof hv !== "string") fail(`${where}.hooks['${hk}'] must be string`);
        if (hv.length < HOOK_CMD_MIN || hv.length > HOOK_CMD_MAX) {
          fail(`${where}.hooks['${hk}'] length ${hv.length} out of [${HOOK_CMD_MIN}, ${HOOK_CMD_MAX}]`);
        }
      }
    }
  }
}

/** Cross M2 修：redact secret-like assignments before printing. */
function redactCommand(cmd) {
  return cmd.replace(/\b([A-Z_]*(?:TOKEN|SECRET|PASSWORD|KEY|API)[A-Z_]*)=([^\s'"]+)/gi, "$1=<redacted>");
}

function curatedEnv(parentEnv) {
  const out = {};
  for (const k of ENV_WHITELIST) {
    if (k in parentEnv && !ENV_STRIP_ALWAYS.has(k)) out[k] = parentEnv[k];
  }
  return out;
}

const { opts, positional } = parseFlags(process.argv.slice(2));
const [hookName, worktreeName] = positional;

if (!hookName || !worktreeName) {
  console.error("Usage: pnpm eva:hook [--dry-run] [--verbose] [--yes] <hookName> <worktreeName>");
  console.error("  hookName: pre-start | post-start | post-merge | pre-remove");
  console.error("  worktreeName: matches eva.json worktrees[].name");
  console.error("");
  console.error("Flags:");
  console.error("  --dry-run   print resolved cmd, do not execute");
  console.error("  --verbose   print full cmd (default: redacted summary)");
  console.error("  --yes       confirm destructive hooks (rm -rf / pkill / git push --force / etc.)");
  process.exit(2);
}

if (!VALID_HOOK_KEYS.has(hookName)) {
  fail(`unknown hook '${hookName}'. valid: ${[...VALID_HOOK_KEYS].join(", ")}`);
}

if (!existsSync(EVA_JSON_PATH)) fail(`eva.json not found at ${EVA_JSON_PATH}`);

let raw;
try {
  raw = JSON.parse(readFileSync(EVA_JSON_PATH, "utf-8"));
} catch (err) {
  fail(`eva.json invalid JSON: ${err.message}`);
}
validateConfig(raw);

const entry = raw.worktrees.find((w) => w.name === worktreeName);
if (!entry) {
  const known = raw.worktrees.map((w) => w.name).join(", ") || "(none)";
  fail(`worktree '${worktreeName}' not found. Known: ${known}`);
}

const cmd = entry.hooks?.[hookName];

// Cross m1 修：pre-remove 允许 path 不存在（晚期 cleanup），fall back to REPO_ROOT
const expandedPath = expandHome(entry.path);
let cwd = expandedPath;
if (!existsSync(expandedPath)) {
  if (hookName === "pre-remove") {
    console.log(`[33m⚠[0m pre-remove: worktree path '${entry.path}' missing — running from REPO_ROOT`);
    cwd = REPO_ROOT;
  } else {
    fail(`worktree path '${entry.path}' (resolved '${expandedPath}') does not exist. Run pre-start first.`, 3);
  }
}

// ── P4: post-start 内置步骤：写 .vessel-task-id ───────────────────────────
if (hookName === "post-start" && cwd !== REPO_ROOT && !opts.dryRun) {
  const taskIdFile = path.join(cwd, ".vessel-task-id");
  const signalScript = path.join(REPO_ROOT, "scripts", "steward-signal-done.sh");
  const payload = JSON.stringify({ task_id: entry.name, signal_script: signalScript });
  try {
    writeFileSync(taskIdFile, payload + "\n", "utf-8");
    console.log(`[32m✓[0m wrote .vessel-task-id  (task=${entry.name})`);
  } catch (err) {
    console.warn(`[33m⚠[0m could not write .vessel-task-id: ${err.message}`);
  }
}

// ── P5: post-start 内置步骤：同步 .env* 文件 ────────────────────────────────
if (hookName === "post-start" && cwd !== REPO_ROOT && !opts.noEnvSync && !opts.dryRun) {
  const synced = [];
  const skipped = [];
  function syncEnvFiles(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isDirectory()) {
        const sub = path.join(dir, name.name);
        if (name.name === "node_modules" || name.name === ".git") continue;
        syncEnvFiles(sub);
      } else if (/^\.env($|\.|_)/.test(name.name) || name.name === ".env") {
        const rel = path.relative(REPO_ROOT, path.join(dir, name.name));
        const src = path.join(REPO_ROOT, rel);
        const dst = path.join(cwd, rel);
        if (!existsSync(dst)) {
          try {
            mkdirSync(path.dirname(dst), { recursive: true });
            copyFileSync(src, dst);
            synced.push(rel);
          } catch (err) {
            console.warn(`[33m⚠[0m env-sync: could not copy ${rel}: ${err.message}`);
          }
        } else {
          skipped.push(rel);
        }
      }
    }
  }
  syncEnvFiles(REPO_ROOT);
  if (synced.length > 0) {
    console.log(`[32m✓[0m env-sync: copied ${synced.length} file(s): ${synced.join(", ")}`);
  }
  if (skipped.length > 0) {
    console.log(`[37m  env-sync: ${skipped.length} already exist (skipped): ${skipped.join(", ")}[0m`);
  }
  if (synced.length === 0 && skipped.length === 0) {
    console.log(`[37m  env-sync: no .env* files found in repo root[0m`);
  }
}

if (!cmd) {
  console.log(`[33m⚠[0m hook '${hookName}' not configured for '${worktreeName}' (no user-defined command)`);
  process.exit(0);
}

// Cross M4 修：高危 hook 检查 + dry-run 出口
const isDestructive = DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd));
if (isDestructive && !opts.yes && !opts.dryRun) {
  console.error(`[31m✗[0m hook '${hookName}' looks destructive (matched pattern). Re-run with --yes to confirm:`);
  console.error(`  pnpm eva:hook --yes ${hookName} ${worktreeName}`);
  console.error(`  Or test first:`);
  console.error(`  pnpm eva:hook --dry-run ${hookName} ${worktreeName}`);
  process.exit(5);
}

const cmdDisplay = opts.verbose ? redactCommand(cmd) : `<${cmd.length} chars; --verbose to show>`;

console.log(`[36m→[0m ${opts.dryRun ? "DRY-RUN " : ""}hook '${hookName}' for '${worktreeName}'`);
console.log(`  cwd:  ${cwd}`);
console.log(`  cmd:  ${cmdDisplay}`);
if (isDestructive) console.log(`[33m  ⚠ destructive pattern detected (rm/pkill/force)`);
console.log("");

if (opts.dryRun) {
  console.log(`[36m→[0m dry-run: not executing. Re-run without --dry-run to actually run.`);
  process.exit(0);
}

const result = spawnSync("bash", ["-c", cmd], {
  cwd,
  stdio: "inherit",
  env: curatedEnv(process.env),
});

if (result.error) fail(`hook spawn failed: ${result.error.message}`, 4);

if (result.status === 0) {
  console.log(`\n[32m✓[0m hook '${hookName}' for '${worktreeName}' completed`);
  process.exit(0);
} else {
  console.error(`\n[31m✗[0m hook '${hookName}' for '${worktreeName}' exited ${result.status}`);
  process.exit(result.status ?? 1);
}
