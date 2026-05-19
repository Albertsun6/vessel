#!/usr/bin/env node
// scripts/eva-gen-port.mjs — deterministic port generator for worktree isolation.
//
// 用法：
//   node scripts/eva-gen-port.mjs <branch-name>
//   pnpm eva:gen-port <branch-name>
//
// 输出：
//   PORT=3033
//   DATA_DIR=/Users/you/.claude-web-<slug>
//   （可直接重定向到 .env.local）
//
// 端口范围：3033–3042（主线 prod 在 :3032，不会碰撞）
// 分配算法：djb2 hash(branch) % 10 + 3033，确定性——同分支名永远同端口。
//
// 例子：
//   node scripts/eva-gen-port.mjs feat/my-feature > .env.local
//   node scripts/eva-gen-port.mjs feat/my-feature --json

import { homedir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const branch = args.filter(a => !a.startsWith("--"))[0];

if (!branch) {
  console.error("Usage: eva-gen-port.mjs <branch-name> [--json]");
  process.exit(64);
}

// djb2 hash — fast, deterministic, good distribution for short strings
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

const PORT_BASE = 3033;
const PORT_RANGE = 10;
const port = PORT_BASE + (djb2(branch) % PORT_RANGE);

// slug: strip leading "feat/", "fix/", "chore/" etc., replace / and non-alnum with -
const slug = branch
  .replace(/^[a-z]+\//, "")
  .replace(/[^a-z0-9]+/gi, "-")
  .replace(/^-+|-+$/g, "")
  .toLowerCase()
  .slice(0, 20);

const dataDir = path.join(homedir(), `.claude-web-${slug}`);

if (jsonMode) {
  console.log(JSON.stringify({ branch, port, dataDir, slug }, null, 2));
} else {
  console.log(`PORT=${port}`);
  console.log(`CLAUDE_WEB_DATA_DIR=${dataDir}`);
}
