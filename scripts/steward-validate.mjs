#!/usr/bin/env node
// pnpm steward:validate — lint docs/BACKLOG.md against ADR-019 schema.
//
//   --mirror   append full snapshot to ~/.vessel/backlog-mirror.jsonl on success
//   --json     machine-readable output

import { parseBacklogFile, validateBacklog } from "./lib/steward-backlog.mjs";
import { appendMirrorSnapshot, mirrorStats } from "./lib/steward-mirror.mjs";

const args = process.argv.slice(2);
const wantMirror = args.includes("--mirror");
const wantJson = args.includes("--json");

function color(text, code) {
  return process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

let parsed;
try {
  parsed = parseBacklogFile();
} catch (err) {
  console.error(color(`✗ ${err.message}`, "31"));
  process.exit(2);
}

const { errors, warnings } = validateBacklog(parsed);

if (wantJson) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings, summary: parsed }, null, 2));
} else {
  console.log(color("steward:validate", "1"));
  console.log(`  file: docs/BACKLOG.md`);
  console.log(`  items: ${parsed.allItems.length}`);
  const ms = mirrorStats();
  console.log(`  mirror: ${ms.lines} lines (${ms.bytes} bytes) → ${process.env.HOME}/.vessel/backlog-mirror.jsonl`);
  for (const w of warnings) console.log(color(`  ⚠ ${w}`, "33"));
  for (const e of errors) console.log(color(`  ✗ ${e}`, "31"));
  if (errors.length === 0) console.log(color("  ✓ schema OK", "32"));
}

if (errors.length > 0) process.exit(1);

if (wantMirror) {
  appendMirrorSnapshot(parsed.allItems, "validate-snapshot");
  if (!wantJson) console.log(color("  → mirror snapshot appended", "32"));
}

process.exit(0);
