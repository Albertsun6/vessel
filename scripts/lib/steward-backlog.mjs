// Shared BACKLOG.md parser + ADR-019 schema checks (zero runtime deps when yaml unavailable).

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");
export const BACKLOG_PATH = path.join(REPO_ROOT, "docs/BACKLOG.md");

const ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
const STATUSES = new Set(["planned", "in_progress", "blocked", "done", "dropped"]);
const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const SIZES = new Set(["S", "M", "L"]);
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const require = createRequire(import.meta.url);

function tryYamlParse(text) {
  try {
    const { parse } = require(path.join(REPO_ROOT, "packages/backend/node_modules/yaml"));
    return parse(text);
  } catch {
    return null;
  }
}

/** @returns {{ updatedAt: string | null, blocks: { section: string, items: object[] }[] }} */
export function parseBacklogFile(filePath = BACKLOG_PATH) {
  if (!existsSync(filePath)) {
    throw new Error(`BACKLOG not found: ${filePath}`);
  }
  const content = readFileSync(filePath, "utf-8");
  const updatedAt = content.match(/^\*\*最近更新\*\*:\s*(\S+)/m)?.[1] ?? null;

  const blocks = [];
  const sectionRe = /^## (.+)$/gm;
  const yamlRe = /```yaml\n([\s\S]*?)```/g;
  const sections = [];
  let m;
  while ((m = sectionRe.exec(content)) !== null) {
    sections.push({ name: m[1].trim(), index: m.index });
  }

  let ym;
  let yamlIdx = 0;
  while ((ym = yamlRe.exec(content)) !== null) {
    const yamlPos = ym.index;
    let section = "unknown";
    for (let i = sections.length - 1; i >= 0; i--) {
      if (sections[i].index < yamlPos) {
        section = sections[i].name;
        break;
      }
    }
    const parsed = tryYamlParse(ym[1]) ?? parseItemsFallback(ym[1]);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    blocks.push({ section, items });
    yamlIdx++;
  }

  return { updatedAt, blocks, allItems: blocks.flatMap((b) => b.items) };
}

function parseItemsFallback(yamlText) {
  const items = [];
  const parts = yamlText.split(/\n\s+-\s+id:\s*/);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const idLine = chunk.split("\n")[0].trim().replace(/^["']|["']$/g, "");
    const item = { id: idLine };
    const lines = chunk.split("\n").slice(1);
    let key = null;
    for (const line of lines) {
      const kv = line.match(/^\s{4}([a-z_]+):\s*(.*)$/);
      if (kv) {
        key = kv[1];
        item[key] = unquoteScalar(kv[2]);
        continue;
      }
      const arr = line.match(/^\s{6}-\s+(.+)$/);
      if (arr && key) {
        const val = unquoteScalar(arr[1]);
        if (!Array.isArray(item[key])) item[key] = [];
        item[key].push(val);
      }
    }
    items.push(item);
  }
  return { items };
}

function unquoteScalar(s) {
  const t = s.trim();
  if (t === "[]") return [];
  if (t === "null" || t === "") return null;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** @returns {{ errors: string[], warnings: string[] }} */
export function validateBacklog(parsed) {
  const errors = [];
  const warnings = [];
  const byId = new Map();

  for (const { section, items } of parsed.blocks) {
    for (const item of items) {
      const where = `${section} · ${item.id ?? "(no id)"}`;

      if (!item.id || typeof item.id !== "string") {
        errors.push(`${where}: missing id`);
        continue;
      }
      if (!ID_RE.test(item.id)) {
        errors.push(`${where}: id '${item.id}' does not match ^[a-z][a-z0-9-]{2,63}$`);
      }
      if (byId.has(item.id)) {
        errors.push(`duplicate id '${item.id}'`);
      }
      byId.set(item.id, { ...item, _section: section });

      if (!item.status || !STATUSES.has(item.status)) {
        errors.push(`${where}: invalid status '${item.status}'`);
      }

      if (item.priority !== undefined && !PRIORITIES.has(item.priority)) {
        errors.push(`${where}: invalid priority '${item.priority}'`);
      }
      if (item.size !== undefined && !SIZES.has(item.size)) {
        errors.push(`${where}: invalid size '${item.size}'`);
      }

      if (item.status === "blocked" && !item.blocked_reason) {
        errors.push(`${where}: blocked requires blocked_reason`);
      }
      if (item.status === "done") {
        if (!item.completed_at) {
          errors.push(`${where}: done requires completed_at (ISO-8601 UTC + Z)`);
        } else if (!ISO_Z.test(item.completed_at)) {
          errors.push(`${where}: completed_at must end with Z (${item.completed_at})`);
        }
      }

      const activeSection = section.toLowerCase().includes("active");
      const blockedSection = section.toLowerCase().includes("blocked");
      const doneSection = section.toLowerCase().includes("done");

      if (activeSection && (item.status === "done" || item.status === "dropped")) {
        warnings.push(`${where}: in Active section but status=${item.status} (I10: trust status field)`);
      }
      if (doneSection && item.status !== "done" && item.status !== "dropped") {
        warnings.push(`${where}: in Done section but status=${item.status}`);
      }
      if (blockedSection && item.status !== "blocked") {
        warnings.push(`${where}: in Blocked section but status=${item.status}`);
      }
    }
  }

  for (const [id, item] of byId) {
    for (const dep of item.depends_on ?? []) {
      if (!byId.has(dep)) errors.push(`${id}: depends_on unknown '${dep}'`);
    }
    for (const c of item.conflicts_with ?? []) {
      if (!byId.has(c)) errors.push(`${id}: conflicts_with unknown '${c}'`);
    }
  }

  if (parsed.updatedAt && !ISO_Z.test(parsed.updatedAt)) {
    warnings.push(`顶部最近更新 '${parsed.updatedAt}' 建议用 ISO-8601 UTC + Z`);
  }

  return { errors, warnings };
}

export function countByStatus(items) {
  const counts = { planned: 0, in_progress: 0, blocked: 0, done: 0, dropped: 0 };
  for (const item of items) {
    if (counts[item.status] !== undefined) counts[item.status]++;
  }
  return counts;
}

export function backlogSummaryLine(parsed) {
  const c = countByStatus(parsed.allItems);
  return `Backlog: ${c.in_progress} in_progress · ${c.planned} planned · ${c.blocked} blocked · ${c.done} done · ${c.dropped} dropped`;
}
