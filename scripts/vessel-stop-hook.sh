#!/usr/bin/env bash
# scripts/vessel-stop-hook.sh — Claude Code Stop hook: auto-trigger steward-signal-done.
#
# 安装：在 ~/.claude/settings.json 的 hooks.Stop 数组中加：
#   {"type": "command", "command": "bash /path/to/scripts/vessel-stop-hook.sh"}
#
# 行为：
#   1. 读 stdin JSON，尝试从中取 cwd；失败则用 $PWD
#   2. 在 cwd 找 .vessel-task-id（JSON）
#   3. 若找到：调用其中的 signal_script，传 task_id
#   4. 若未找到：静默 exit 0（非 Vessel worker session）
#
# .vessel-task-id 格式（由 eva-hook.mjs post-start 自动写入）：
#   {"task_id":"<worktree-name>","signal_script":"<abs-path>/steward-signal-done.sh"}

set -euo pipefail

# ── 读 stdin JSON，提取 cwd ───────────────────────────────────────────────────
INPUT=$(cat)
CWD=""
if [ -n "$INPUT" ]; then
  CWD=$(echo "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('cwd') or d.get('project_root') or '')
except Exception:
    print('')
" 2>/dev/null || true)
fi
CWD="${CWD:-${CLAUDE_PROJECT_ROOT:-$PWD}}"

TASK_ID_FILE="$CWD/.vessel-task-id"
if [ ! -f "$TASK_ID_FILE" ]; then
  exit 0
fi

# ── 解析 .vessel-task-id ─────────────────────────────────────────────────────
TASK_ID=$(python3 -c "
import json, sys
try:
    d = json.load(open('$TASK_ID_FILE'))
    print(d.get('task_id', ''))
except Exception:
    print('')
" 2>/dev/null || true)

SIGNAL_SCRIPT=$(python3 -c "
import json, sys
try:
    d = json.load(open('$TASK_ID_FILE'))
    print(d.get('signal_script', ''))
except Exception:
    print('')
" 2>/dev/null || true)

if [ -z "$TASK_ID" ] || [ -z "$SIGNAL_SCRIPT" ]; then
  echo "[vessel-stop-hook] WARNING: .vessel-task-id malformed at $TASK_ID_FILE" >&2
  exit 0
fi

if [ ! -f "$SIGNAL_SCRIPT" ]; then
  echo "[vessel-stop-hook] WARNING: signal_script not found: $SIGNAL_SCRIPT" >&2
  exit 0
fi

# ── 调 steward-signal-done.sh ────────────────────────────────────────────────
echo "[vessel-stop-hook] task=$TASK_ID → signaling done" >&2
bash "$SIGNAL_SCRIPT" "$TASK_ID"
