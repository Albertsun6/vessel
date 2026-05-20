#!/usr/bin/env bash
# /auto-ship skill — cursor-agent invocation helper for Phase 4 PR review
#
# 在异构 review 模式下被主 Claude 调用（默认开启；Phase 1 探测到 cursor-agent 不在
# PATH 时 fallback 到 Claude-only + banner）。用 cursor-agent (GPT-5.5-medium) 跑
# reviewer-cross prompt 作为异构 reviewer。失败时优雅退出，让主 Claude 加 banner
# 并降级。
#
# 借自 ~/.claude/skills/survey/run-cursor-agent.sh，timeout 缩到 180s（review 比
# survey 短）。
#
# 用法：
#   ./run-cursor-agent.sh <prompt-file> <output-file>
#
# 参数：
#   <prompt-file>  : 已含完整 reviewer-cross prompt + PR diff 的文件路径
#                    （主 Claude 在 Phase 4 Step 4.3 拼装）
#   <output-file>  : cursor-agent 输出落盘路径
#
# Exit codes：
#   0   成功，<output-file> 已写入有效内容
#   64  参数错误
#   65  调用失败（auth / network / 其他）—— 主 Claude 写 banner "cursor-agent error"
#   66  输出为空或 prompt 文件不存在 —— 主 Claude 写 banner "cursor-agent returned empty output"
#   69  cursor-agent CLI 未安装（command -v 失败）—— 主 Claude 写 banner
#       "cursor-agent not found"
#   124 timeout 触发（>180s）—— **仅当系统装了 timeout 或 gtimeout 时才会发生**。
#       macOS 默认无 timeout 命令（GNU coreutils 才有），此场景下脚本裸跑 cursor-agent，
#       超时保护由调用方（主 Claude Bash 工具的 timeout 参数）兜底。

set -uo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <prompt-file> <output-file>" >&2
  exit 64
fi

PROMPT_FILE="$1"
OUTPUT_FILE="$2"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: prompt file not found: $PROMPT_FILE" >&2
  exit 66
fi

if ! command -v cursor-agent >/dev/null 2>&1; then
  echo "ERROR: cursor-agent not in PATH" >&2
  echo "Install: open Cursor → Settings → CLI tools (or cursor.com/cli)" >&2
  exit 69
fi

# 180s timeout（一般 review 1-2 min）
TIMEOUT_SEC=180

# 探测可用的 timeout 命令——macOS 默认无 `timeout`（GNU coreutils 才有），Homebrew 装为
# `gtimeout`。两个都没装时裸跑，靠主 Claude Bash 工具的 timeout 兜底。
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
fi

# 调用 cursor-agent
if [ -n "$TIMEOUT_BIN" ]; then
  "$TIMEOUT_BIN" "$TIMEOUT_SEC" cursor-agent \
    --print \
    --model gpt-5.5-medium \
    --output-format text \
    --sandbox enabled \
    --force \
    "$(cat "$PROMPT_FILE")" \
    > "$OUTPUT_FILE" 2>/tmp/auto-ship-cursor-agent-stderr.log
else
  cursor-agent \
    --print \
    --model gpt-5.5-medium \
    --output-format text \
    --sandbox enabled \
    --force \
    "$(cat "$PROMPT_FILE")" \
    > "$OUTPUT_FILE" 2>/tmp/auto-ship-cursor-agent-stderr.log
fi

EXIT=$?

if [ "$EXIT" -eq 124 ]; then
  echo "ERROR: cursor-agent timeout (>${TIMEOUT_SEC}s)" >&2
  exit 124
fi

if [ "$EXIT" -ne 0 ]; then
  echo "ERROR: cursor-agent exited $EXIT" >&2
  echo "stderr tail:" >&2
  tail -20 /tmp/auto-ship-cursor-agent-stderr.log >&2 || true
  exit 65
fi

if [ ! -s "$OUTPUT_FILE" ]; then
  echo "ERROR: cursor-agent returned empty output" >&2
  exit 66
fi

echo "OK: cursor-agent wrote $(wc -c < "$OUTPUT_FILE") bytes to $OUTPUT_FILE"
exit 0
