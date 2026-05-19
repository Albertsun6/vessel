#!/usr/bin/env bash
# scripts/steward-signal-done.sh — Steward V0.5 R1 Layer 1: worker signals done.
#
# 用法：
#   ./scripts/steward-signal-done.sh <task-id> [--pr <url>] [--summary <text>]
#
# 行为：
#   写 ~/.vessel/spawn-done/<task-id>.json，主线 (master Claude session) 之后用
#   `pnpm eva:collect` 看到这个 flag，再 ack 关 worktree / 改 BACKLOG。
#
# 主线"收"侧契约（不在本脚本内）：
#   - 主 Claude 看到 flag 后 echo 给用户：worker X 完成 (commit Y, PR Z, summary W)
#   - 用户 ack "收线" / "ok" 之后主线删 flag + update BACKLOG.md status=done
#   - flag 文件 24h 不被主线收掉就 stale，pnpm eva:collect 会标 stale

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <task-id> [--pr <url>] [--summary <text>]" >&2
  exit 64
fi

TASK_ID="$1"
shift

PR_URL=""
SUMMARY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pr)
      PR_URL="${2:-}"
      shift 2 || exit 64
      ;;
    --summary)
      SUMMARY="${2:-}"
      shift 2 || exit 64
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 64
      ;;
  esac
done

if [[ ! "$TASK_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "ERROR: task-id must match [a-zA-Z0-9_-]+, got '$TASK_ID'" >&2
  exit 65
fi

FLAG_DIR="$HOME/.vessel/spawn-done"
mkdir -p "$FLAG_DIR"

FLAG_FILE="$FLAG_DIR/$TASK_ID.json"

BRANCH="$(git branch --show-current 2>/dev/null || echo unknown)"
COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
WORKTREE_PATH="$(pwd)"
COMPLETED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# ── Verifiable artifact check ────────────────────────────────────────────────
# 可验证产物 = 分支有新 commit（vs origin/dev 或 origin/main），或提供了 --pr URL。
# 若两者都缺，写 warning 但不阻断（worker 可能是纯文档任务无新 commit）。
ARTIFACT_OK=false
if [ -n "$PR_URL" ]; then
  ARTIFACT_OK=true
else
  BASE_SHA="$(git rev-parse origin/dev 2>/dev/null \
    || git rev-parse origin/main 2>/dev/null \
    || echo unknown)"
  if [ "$COMMIT_SHA" != "unknown" ] && \
     [ "$BASE_SHA" != "unknown" ] && \
     [ "$COMMIT_SHA" != "$BASE_SHA" ]; then
    ARTIFACT_OK=true
  fi
fi

if [ "$ARTIFACT_OK" = false ]; then
  echo "⚠️  WARNING: no verifiable artifact" >&2
  echo "   分支与 origin/dev 的 HEAD 相同（无新 commit），且未提供 --pr URL。" >&2
  echo "   建议：先 git commit，或加 --pr <url>，再跑 signal-done。" >&2
  echo "   （flag 仍会写入，主线收线时会看到 artifact_ok=false 提示）" >&2
fi
# ─────────────────────────────────────────────────────────────────────────────

# atomic write via tmp + rename
TMP_FILE="$FLAG_FILE.tmp.$$"
{
  printf '{\n'
  printf '  "schema": "vessel-spawn-done-v1",\n'
  printf '  "task_id": "%s",\n' "$TASK_ID"
  printf '  "branch": "%s",\n' "$BRANCH"
  printf '  "commit_sha": "%s",\n' "$COMMIT_SHA"
  printf '  "worktree_path": "%s",\n' "$WORKTREE_PATH"
  printf '  "artifact_ok": %s,\n' "$ARTIFACT_OK"
  printf '  "completed_at": "%s"' "$COMPLETED_AT"
  if [ -n "$PR_URL" ]; then
    printf ',\n  "pr_url": "%s"' "$PR_URL"
  fi
  if [ -n "$SUMMARY" ]; then
    ESCAPED_SUMMARY="$(printf '%s' "$SUMMARY" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g')"
    printf ',\n  "summary": "%s"' "$ESCAPED_SUMMARY"
  fi
  printf '\n}\n'
} > "$TMP_FILE"

mv "$TMP_FILE" "$FLAG_FILE"

if [ "$ARTIFACT_OK" = true ]; then
  echo "OK: wrote $FLAG_FILE  [artifact_ok=true]"
else
  echo "OK: wrote $FLAG_FILE  [artifact_ok=false — 建议补 commit 或 --pr]"
fi
echo "   主线下次 \`pnpm eva:collect\` 会看到 task=$TASK_ID 等收线"
