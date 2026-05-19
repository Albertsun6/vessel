#!/usr/bin/env node
// scripts/eva-conflict-check.mjs — pre-check file conflicts before starting a task.
//
// 用法：
//   node scripts/eva-conflict-check.mjs <task-id>
//   pnpm eva:conflict-check <task-id>
//
// 行为：
//   1. 从 docs/BACKLOG.md 读取 <task-id> 的 parallel_safe_files
//   2. 从 eva.json 读取所有 active worktree 的 owns 列表
//   3. 跑 git diff --name-only HEAD..origin/dev（或 origin/main）得到当前脏文件
//   4. 对以上三组做 intersection：
//      - 新任务 parallel_safe_files vs active worktrees owns → 跨任务冲突
//      - 新任务 parallel_safe_files vs git diff 文件 → 当前 branch 脏文件冲突
//   5. 输出冲突报告（exit 0=无冲突, exit 1=有冲突需人工确认）
//
// 用于 Steward dispatch 协议：`开始干 <id>` 时 Claude 先跑此脚本，有冲突则标红。

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EVA_JSON_PATH = path.join(REPO_ROOT, "eva.json");
const BACKLOG_PATH = path.join(REPO_ROOT, "docs", "BACKLOG.md");

function fail(msg) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exit(2);
}

function color(text, code) {
  return process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

// ── Parse BACKLOG.md to find task's parallel_safe_files ──────────────────────
function findTaskInBacklog(taskId) {
  if (!existsSync(BACKLOG_PATH)) fail(`BACKLOG.md not found: ${BACKLOG_PATH}`);
  const content = readFileSync(BACKLOG_PATH, "utf8");

  // Extract all ```yaml blocks
  const yamlBlocks = [];
  const blockRe = /```yaml\n([\s\S]*?)```/g;
  let m;
  while ((m = blockRe.exec(content)) !== null) {
    yamlBlocks.push(m[1]);
  }

  for (const block of yamlBlocks) {
    // Simple line-by-line YAML item parser (no external dep)
    const items = parseBacklogYaml(block);
    const task = items.find(it => it.id === taskId);
    if (task) return task;
  }
  return null;
}

// Minimal YAML parser for BACKLOG items — handles the specific structure used.
function parseBacklogYaml(text) {
  const items = [];
  let current = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();

    // New item
    if (/^\s{2}-\s+id:/.test(line)) {
      if (current) items.push(current);
      current = { id: line.replace(/^\s{2}-\s+id:\s*/, "").replace(/"/g, "").trim() };
      continue;
    }
    if (!current) continue;

    // Scalar fields
    const scalarMatch = line.match(/^\s{4}(\w+):\s*"?([^"#\n]*)"?\s*$/);
    if (scalarMatch) {
      const [, key, val] = scalarMatch;
      current[key] = val.trim();
      continue;
    }

    // parallel_safe_files: ["a", "b"]  (inline array)
    const inlineArr = line.match(/^\s{4}parallel_safe_files:\s*\[([^\]]*)\]/);
    if (inlineArr) {
      current.parallel_safe_files = inlineArr[1]
        .split(",")
        .map(s => s.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
      continue;
    }

    // parallel_safe_files: (multi-line list)
    if (/^\s{4}parallel_safe_files:\s*$/.test(line)) {
      current._readingPSF = true;
      current.parallel_safe_files = [];
      continue;
    }
    if (current._readingPSF) {
      const listItem = line.match(/^\s{6}-\s+"?([^"]+)"?\s*$/);
      if (listItem) {
        current.parallel_safe_files.push(listItem[1]);
      } else {
        current._readingPSF = false;
      }
    }
  }
  if (current) items.push(current);
  return items;
}

// ── Read active worktrees from eva.json ──────────────────────────────────────
function getActiveWorktrees() {
  if (!existsSync(EVA_JSON_PATH)) return [];
  const data = JSON.parse(readFileSync(EVA_JSON_PATH, "utf8"));
  return (data.worktrees || []).filter(w => w.status === "active");
}

// ── Get changed files vs base branch ─────────────────────────────────────────
function getDirtyFiles() {
  const bases = ["origin/dev", "origin/main"];
  for (const base of bases) {
    const r = spawnSync("git", ["diff", "--name-only", `HEAD..${base}`], {
      cwd: REPO_ROOT, encoding: "utf8",
    });
    if (r.status === 0) {
      return r.stdout.trim().split("\n").filter(Boolean);
    }
  }
  return [];
}

// ── Intersection helper ───────────────────────────────────────────────────────
// Returns entries from `files` that start with or match any pattern in `patterns`.
function intersect(files, patterns) {
  if (!patterns || patterns.length === 0) return [];
  return files.filter(f =>
    patterns.some(p => {
      const clean = p.replace(/#.*$/, ""); // strip #symbol
      return f === clean || f.startsWith(clean.endsWith("/") ? clean : clean + "/");
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const taskId = process.argv[2];
if (!taskId) {
  console.error("Usage: eva-conflict-check.mjs <task-id>");
  process.exit(64);
}

const task = findTaskInBacklog(taskId);
if (!task) {
  console.error(`Task '${taskId}' not found in BACKLOG.md`);
  process.exit(2);
}

const psf = task.parallel_safe_files || [];
const activeWorktrees = getActiveWorktrees();
const dirtyFiles = getDirtyFiles();

let hasConflict = false;

console.log(`\nConflict pre-check for task: ${color(taskId, "36")}`);
console.log(`parallel_safe_files: [${psf.map(f => color(f, "33")).join(", ")}]`);

// 1. Check vs active worktrees' owns
if (activeWorktrees.length > 0) {
  console.log(`\nChecking vs ${activeWorktrees.length} active worktree(s):`);
  for (const wt of activeWorktrees) {
    const owns = wt.owns || [];
    const hits = intersect(psf, owns).concat(intersect(owns, psf));
    const unique = [...new Set(hits)];
    if (unique.length > 0) {
      console.log(`  ${color("⚠ CONFLICT", "31")} with worktree '${wt.name}' (branch: ${wt.branch})`);
      console.log(`    overlapping: ${unique.map(f => color(f, "31")).join(", ")}`);
      hasConflict = true;
    } else {
      console.log(`  ${color("✓", "32")} no overlap with '${wt.name}'`);
    }
  }
} else {
  console.log("\nNo active worktrees — skip worktree conflict check.");
}

// 2. Check vs current branch dirty files
if (dirtyFiles.length > 0) {
  const hits = intersect(dirtyFiles, psf).concat(intersect(psf.map(p => p.replace(/#.*$/, "")), dirtyFiles.map(() => ""))).filter(Boolean);
  // Re-do clean intersection
  const dirtyHits = dirtyFiles.filter(f =>
    psf.some(p => {
      const clean = p.replace(/#.*$/, "");
      return f === clean || f.startsWith(clean.endsWith("/") ? clean : clean + "/");
    })
  );
  if (dirtyHits.length > 0) {
    console.log(`\n  ${color("⚠ DIRTY FILES", "33")} on current branch overlap with task's safe files:`);
    dirtyHits.forEach(f => console.log(`    ${color(f, "33")}`));
    hasConflict = true;
  } else {
    console.log(`\n${color("✓", "32")} No dirty-file conflicts on current branch.`);
  }
} else {
  console.log(`\n${color("✓", "32")} Current branch is clean vs base.`);
}

if (hasConflict) {
  console.log(`\n${color("⚠ Conflicts detected — review before spawning.", "31")}`);
  process.exit(1);
} else {
  console.log(`\n${color("✓ No conflicts — safe to spawn.", "32")}`);
  process.exit(0);
}
