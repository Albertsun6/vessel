#!/usr/bin/env bash
# scripts/vessel-stop-hook.sh — Claude Code Stop hook: auto-trigger steward-signal-done.
#
# 安装：在 ~/.claude/settings.json 的 hooks.Stop 数组中加：
#   {"type": "command", "command": "bash /path/to/scripts/vessel-stop-hook.sh"}
#
# 行为：
#   1. 读 stdin JSON，尝试从中取 cwd；失败则用 $PWD
#   2. 在 cwd 找 .vessel-task-id（JSON）
#   3. 若找到（worker worktree）：调用其中的 signal_script，传 task_id
#   4. 若未找到（master / 非 worktree）：在 Vessel 仓库内则跑只读
#      eva:collect --exit-code，确有 pending 才 echo 收线提示（notify-only，
#      ADR-019 I14：绝不改 BACKLOG / 不收线 / 不 dispatch）；否则静默 exit 0
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
  # ── master 分支：无 .vessel-task-id ⟹ 非 worker worktree（与 eva-hook
  #    post-start "仅 worktree 写该文件" 严格对偶）。notify-only 收线提示。
  #    Vessel-repo 闸门：非 Vessel 项目（无 scripts/eva-collect.mjs）静默退，
  #    连 node 都不 spawn —— 全局注册下不污染其它项目的 Stop。
  if [ ! -f "$CWD/scripts/eva-collect.mjs" ]; then
    exit 0
  fi
  # 噪声控制：--exit-code → 10 表示确有非 malformed pending；其余一律静默退。
  # set -e 安全：`|| RC=$?` 捕获非零码，不让 node 退出码掀翻脚本。
  RC=0
  COLLECT_OUT="$(node "$CWD/scripts/eva-collect.mjs" --exit-code 2>/dev/null)" || RC=$?
  if [ "$RC" -ne 10 ]; then
    exit 0   # 零 pending / 解析失败兜底 → 零噪声
  fi
  N=$(printf '%s\n' "$COLLECT_OUT" | grep -cE '^(PENDING|STALE)' || true)
  IDS=$(printf '%s\n' "$COLLECT_OUT" | grep -E '^(PENDING|STALE)' | awk '{print $2}' | tr '\n' ' ' || true)
  echo "[vessel-steward] ${N} 个 worker 已完成待收线: ${IDS}" >&2
  echo "[vessel-steward] 收线：粘 \`ok 收线 <id>\` 或 \`看 backlog\`（本提示只读不写，未改 BACKLOG / 未收线 — ADR-019 I14）" >&2
  # notify-only ⟹ 必须 exit 0。Stop hook exit 2 = 阻止停止语义（stderr 回灌
  # 成 reason、agent 续跑可能成 loop），对 notify-only 是错误行为且全局生效。
  # 故 exit 0 是正确设计，非降级。更显眼呈现待端到端验证后再议。
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
