# Phase 4 — PR review loop（最多 3 轮）

## 整体节奏

```
ROUND=1
LAST_FINDING_HASH=""

while ROUND <= 3:
  1. fetch PR diff
  2. 并行起两个 reviewer：
     - Claude self-review（read diff, output findings）
     - cursor-agent reviewer-cross prompt（via run-cursor-agent.sh）
  3. 合并 findings → 归一化 → SHA-256 hash
  4. 如果 findings 为空 → break, 进 Phase 5
  5. 如果 hash == LAST_FINDING_HASH → ping-pong 中止
  6. 在 PR 上贴评论
  7. auto-fix 可修项 → commit + push
  8. LAST_FINDING_HASH = hash; ROUND += 1

ROUND > 3 → abort auto-merge, 留 PR
```

## Step 4.1: Round 开始

```bash
echo "═══ PR review round $ROUND / 3 ═══"
gh pr diff "$PR_NUM" > /tmp/auto-ship-pr-${PR_NUM}-round${ROUND}.diff
```

## Step 4.2: Claude self-review

**主 Claude 直接做**——不调 subagent（cost 考虑；这一阶段是 4 类 lens 的 mechanical check）：

读 `/tmp/auto-ship-pr-${PR_NUM}-round${ROUND}.diff`，按下面 4 lens 扫：

1. **结构性**：SQL 注入 / race / 不可逆操作 / 错误处理缺失
2. **协议层**：HarnessProtocol / ServerMessage 是否前后端同步 / iOS HarnessStore 是否同步
3. **CLAUDE.md 高频 pitfall**：用了 `@anthropic-ai/claude-agent-sdk` / 用了 `claude --bare` / 用 `localhost:3030` 硬编码 / runIdToConversation 没清理 / 等
4. **dead code / over-abstraction / 不必要错误处理**（CLAUDE.md ② Simplicity）

输出到 `/tmp/auto-ship-pr-${PR_NUM}-round${ROUND}-claude.txt`，格式：

```
## Claude self-review (round N)

[file:line] severity — finding description
[file:line] severity — finding description
...
```

或者只有一行 `## Claude self-review (round N)\n\n(no findings)`。

## Step 4.3: cursor-agent review

如果 `CURSOR_AGENT_AVAILABLE=true`：

1. 拼 prompt 文件 `/tmp/auto-ship-pr-${PR_NUM}-round${ROUND}-cursor-prompt.txt`：
   ```
   你正在 review 一个 Vessel 项目的 PR。你的角色：cross-reviewer (heterogeneity)。

   请按 .claude/skills/reviewer-cross/SKILL.md 里的 lens 检查以下 diff。
   重点找 Claude 容易漏的集体盲区：
   - 协议层前后端 / iOS 同步
   - 不可逆 git 操作
   - LLM trust boundary（外部输入直接进 prompt 模板）
   - Vessel 4 个 hard-triggers
   
   diff:
   <粘 /tmp/auto-ship-pr-${PR_NUM}-round${ROUND}.diff 全文>

   输出格式（每条 finding 一行）：
   [file:line] severity — finding description

   零 finding 则只输出：(no findings)
   ```

2. 跑：
   ```bash
   bash .claude/skills/auto-ship/run-cursor-agent.sh \
     /tmp/auto-ship-pr-${PR_NUM}-round${ROUND}-cursor-prompt.txt \
     /tmp/auto-ship-pr-${PR_NUM}-round${ROUND}-cursor.txt
   ```

3. 处理 exit code：
   - 0 → OK
   - 65 / 66 / 124 → 重试 1 次；仍 fail → 设 `CURSOR_AGENT_AVAILABLE=false` + banner "⚠️ cursor-agent 调用失败，本轮起降级到 Claude-only"
   - 69 → 早该在 Phase 1 catch，但兜底处理同上

如果 `CURSOR_AGENT_AVAILABLE=false`：写空 `/tmp/auto-ship-pr-${PR_NUM}-round${ROUND}-cursor.txt`（标记"未跑"），并已在 banner 警告过。

## Step 4.4: 合并 + 归一化 + hash

合并两边 findings 到一个 list：

```
all_findings = parse(claude.txt) + parse(cursor.txt)
```

**归一化**（重要——hash 用来检 ping-pong）：

- 去掉行号（review 修了之后行号会变；只比内容）
- 去掉 severity 标签
- 按 file path 字典序排
- 同一文件内按 finding text 字典序排

```bash
# 伪代码：把归一化结果写到 /tmp/auto-ship-pr-${PR_NUM}-round${ROUND}-normalized.txt
# 然后 hash:
HASH=$(shasum -a 256 /tmp/auto-ship-pr-${PR_NUM}-round${ROUND}-normalized.txt | awk '{print $1}')
```

**已知 limitation**：这个 hash 只 catches **逐字一致**的 ping-pong——如果 reviewer 把"function X uses
deprecated API"和"deprecated API use in function X"轮流输出，hash 不同，ping-pong 不会被
detect 到。**这是 acceptable 的——max-rounds=3 是真正的硬安全网**。hash 只是优化（让明显的
ping-pong 早 1-2 轮中止）；模糊的 ping-pong 由 max-rounds catch。**不要**为追求"完美 ping-pong
detection"引入相似度匹配/LCS——那是过度工程，max-rounds 已经足够安全。

## Step 4.5: 收敛 / ping-pong / 推进判定

```
findings_count = wc -l < normalized.txt

if findings_count == 0:
  echo "✓ Round $ROUND: 0 findings → 收敛, 进入 Phase 5"
  Read phases/05-auto-merge.md
  return

if HASH == LAST_FINDING_HASH:
  echo "✗ ping-pong: round $((ROUND-1)) 和 round $ROUND 的 findings 一致, reviewer 反复要求相同改动"
  abort auto-merge
  echo "PR 留在 open 状态: $PR_URL"
  return

# 否则: 贴评论 + auto-fix + push + 下一轮
```

## Step 4.6: 在 PR 上贴 review 评论

汇总成一条（避免刷屏）：

```bash
gh pr review "$PR_NUM" --comment --body "$(cat <<EOF
## 🤖 auto-ship review round $ROUND

### Claude self-review
$(cat /tmp/auto-ship-pr-${PR_NUM}-round${ROUND}-claude.txt)

### cursor-agent (gpt-5.5-medium) reviewer-cross
$(cat /tmp/auto-ship-pr-${PR_NUM}-round${ROUND}-cursor.txt 2>/dev/null || echo "(degraded: cursor-agent unavailable)")

---
下一步：auto-fix 可修项 + push。如果你想接管，回贴评论后 Ctrl-C auto-ship。
EOF
)"
```

## Step 4.7: auto-fix + push

对每条 finding 判断：

- **可机械修**（同 Phase 2 的 auto-fix 范围 + "review 明确指出怎么改"的情况）→ 用 Edit 修
- **不可机械修**（要求架构改动 / API 重新设计 / 需要新代码）→ abort auto-merge

```bash
git status --porcelain  # 应该只有 review 要求改的文件
git add <被修文件>
git commit -m "fix: address auto-ship review round $ROUND"
git push 2>&1
```

push 失败处理同 Phase 3.3。

## Step 4.8: 准备下一轮

```bash
LAST_FINDING_HASH=$HASH
ROUND=$((ROUND + 1))
```

回到 Step 4.1。

## Step 4.9: max-rounds 到达

如果 `ROUND > 3` 仍未收敛：

```
═══════════════════════════════════════════════════════════
  ✗ auto-ship 中止：3 轮 review 仍未收敛
═══════════════════════════════════════════════════════════

Round 1: <findings 简述>
Round 2: <findings 简述>
Round 3: <findings 简述>

PR 留在 open 状态: $PR_URL
你可以接管：手动 review + push 修复 + 手动 `gh pr merge`，
或者粘 review 反馈到 debate-review skill。
```

不 merge。
