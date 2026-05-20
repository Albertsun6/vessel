# Phase 1 — Preflight

## Step 1.1: 启动 banner（不可跳过）

把以下整段**逐字** echo 给用户：

```
═══════════════════════════════════════════════════════════
  auto-ship mode 启动
  目标 PR 会在 review 干净 + CI 绿后 AUTO-MERGE 到 main
  这覆盖了 CLAUDE.md I13（代码改动默认 NOT auto-merge）
  撤回方式：5 秒内 Ctrl-C
═══════════════════════════════════════════════════════════
```

然后 `sleep 5`（用 Bash 工具跑 `sleep 5`，给用户撤回窗）。

## Step 1.2: 环境检查（任一 fail → abort）

并行跑（Bash 单 message 多 tool call）：

```bash
# 1. 当前分支
git rev-parse --abbrev-ref HEAD

# 2. 本地 vs main 有 diff
test -n "$(git diff main...HEAD --name-only 2>&1)" && echo "has-diff" || echo "no-diff"

# 3. 远端可达（1s timeout 兜底由主 Claude Bash timeout 控制）
git ls-remote origin HEAD >/dev/null 2>&1 && echo "remote-ok" || echo "remote-fail"

# 4. gh CLI 认证
gh auth status >/dev/null 2>&1 && echo "gh-ok" || echo "gh-fail"

# 5. cursor-agent CLI 可达（不 fail，只是决定是否降级）
command -v cursor-agent >/dev/null 2>&1 && echo "cursor-ok" || echo "cursor-degraded"
```

**判定**：

| 检查 | fail 后果 |
|---|---|
| 当前分支 = `main` / `dev` | abort："拒绝从受保护分支 ship；先开 feat/* 分支" |
| 当前分支不是 `feat/*` / `fix/*` / `chore/*` / `docs/*` / `refactor/*` | abort："分支名不符合 Vessel 约定，无法自动定 commit type" |
| 无 diff | abort："本地 vs main 无 diff，没东西可 ship" |
| 远端不可达 | abort："远端不可达，无法 ship" |
| gh auth fail | abort："`gh auth login` 后重试" |
| cursor-agent 不可达 | **不**abort——降级 + 设 `CURSOR_AGENT_AVAILABLE=false` 给 Phase 4 用，banner 警告：`⚠️ cursor-agent 不可用，异构 review 失效，本次 ship 集体盲区风险升高` |

## Step 1.3: 协议层警戒（半 I13 兼容）

跑：

```bash
git diff main...HEAD --name-only | grep -E '^(packages/shared/|packages/backend/src/routes/|packages/backend/src/harness-config\.ts|packages/ios-native/Sources/ClaudeWeb/HarnessProtocol\.swift|packages/ios-native/Sources/ClaudeWeb/Harness/HarnessStore\.swift)'
```

若有任何匹配 → echo：

```
⚠️ 检测到协议层 / harness-config / HarnessProtocol 改动
   这些路径的改动通常需要人工 review。auto-merge mode 仍会继续，但建议你
   再次确认。撤回方式：5 秒内 Ctrl-C
```

再 `sleep 5`（第二个撤回窗）。

## Step 1.4: 记录 ship 元数据

跑：

```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
DIFF_FILES=$(git diff main...HEAD --name-only | wc -l | tr -d ' ')
DIFF_LINES=$(git diff main...HEAD --shortstat)
COMMIT_COUNT=$(git rev-list --count main..HEAD)
echo "branch=$CURRENT_BRANCH files=$DIFF_FILES commits=$COMMIT_COUNT"
echo "$DIFF_LINES"
```

把这几个值留给后续 phases（commit message 描述、PR body summary 都会用）。

## Step 1.5: 进入 Phase 2

echo："Phase 1 preflight PASS → 进入 Phase 2 (本地 review)"
然后 Read `phases/02-local-review.md`。
