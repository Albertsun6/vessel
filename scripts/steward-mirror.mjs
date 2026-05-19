#!/usr/bin/env node
// Steward backlog mirror — ~/.vessel/backlog-mirror.jsonl
//
//   pnpm steward:mirror --record --id <task> --from planned --to in_progress
//   pnpm steward:mirror --snapshot          # full items snapshot (same as validate --mirror)
//   pnpm steward:mirror --show <task-id>    # last known snapshot for one id
//   pnpm steward:mirror --tail [N]          # last N lines (default 5)

import { parseBacklogFile } from "./lib/steward-backlog.mjs";
import {
  appendMirrorEntry,
  appendMirrorSnapshot,
  findLastItemSnapshot,
  readMirrorLines,
  MIRROR_PATH,
} from "./lib/steward-mirror.mjs";

const args = process.argv.slice(2);

function usage() {
  console.log(`Usage:
  pnpm steward:mirror --snapshot
  pnpm steward:mirror --record --id <id> --from <status> --to <status> [--note text]
  pnpm steward:mirror --show <task-id>
  pnpm steward:mirror --tail [N]

Mirror file: ${MIRROR_PATH}`);
  process.exit(2);
}

if (args.includes("--snapshot")) {
  const parsed = parseBacklogFile();
  const line = appendMirrorSnapshot(parsed.allItems, "manual-snapshot");
  console.log(`appended snapshot (${parsed.allItems.length} items) @ ${line.ts}`);
  process.exit(0);
}

const showIdx = args.indexOf("--show");
if (showIdx >= 0) {
  const id = args[showIdx + 1];
  if (!id) usage();
  const snap = findLastItemSnapshot(id);
  if (!snap) {
    console.error(`no mirror entry for id=${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify(snap, null, 2));
  process.exit(0);
}

if (args.includes("--tail")) {
  const n = parseInt(args[args.indexOf("--tail") + 1], 10) || 5;
  const lines = readMirrorLines().slice(-n);
  for (const row of lines) console.log(JSON.stringify(row));
  process.exit(0);
}

if (args.includes("--record")) {
  const idIdx = args.indexOf("--id");
  const fromIdx = args.indexOf("--from");
  const toIdx = args.indexOf("--to");
  const noteIdx = args.indexOf("--note");
  const id = idIdx >= 0 ? args[idIdx + 1] : null;
  const from = fromIdx >= 0 ? args[fromIdx + 1] : null;
  const to = toIdx >= 0 ? args[toIdx + 1] : null;
  if (!id || !to) usage();
  let snapshot = null;
  try {
    const parsed = parseBacklogFile();
    snapshot = parsed.allItems.find((it) => it.id === id) ?? null;
  } catch {
    /* best-effort */
  }
  const line = appendMirrorEntry({
    event: "status",
    id,
    from: from ?? null,
    to,
    note: noteIdx >= 0 ? args[noteIdx + 1] : undefined,
    snapshot,
  });
  console.log(`recorded ${id}: ${from ?? "?"} → ${to} @ ${line.ts}`);
  process.exit(0);
}

usage();
