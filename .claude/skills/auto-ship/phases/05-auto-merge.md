# Phase 5 — Auto-merge + worktree 自动清

## Step 5.1: 设置 auto-merge

```bash
gh pr merge "$PR_NUM" --auto --squash --delete-branch 2>&1
```

**flag 说明**：

- `--auto`：**等 CI `test` job PASS 后才自动 merge**——这是 auto-ship 安全的最后一道闸门。即使 review 通过，CI fail 就不会 merge。`gh` 帮你"挂"这个 merge intent 在 GitHub 上
- `--squash`：跟 Vessel branch model 一致——feat/* PR squash 进 main
- `--delete-branch`：merge 完自动删**远端**分支（本地分支 + worktree 由 Step 5.3 处理）

**失败处理**：

| stderr 包含 | 原因 | 处理 |
|---|---|---|
| `pull request is not in a mergeable state` | 通常因为 base 有 conflict | abort + 提示用户手动 rebase |
| `not enough permissions` / `restricted` | branch protection 不允许 auto-merge | abort + 提示用户检查 GitHub Settings → Branches |
| `required status checks` not configured | CI 没设成必需 | abort + 提示用户在 branch protection 加 require status checks |

## Step 5.2: 轮询 merge 完成（最多 180s）

`--auto` flag 是异步的：CI 还在跑时 gh 只挂 intent，实际 merge 等 CI 绿才发生。轮询直到 PR `state=MERGED` 或超时：

```bash
WORKTREE_PATH=$(pwd)
TIMEOUT=180
ELAPSED=0
INTERVAL=10

while [ $ELAPSED -lt $TIMEOUT ]; do
  STATE=$(gh pr view "$PR_NUM" --json state --jq '.state' 2>/dev/null)
  if [ "$STATE" = "MERGED" ]; then
    echo "✓ PR #$PR_NUM merged after ${ELAPSED}s"
    break
  fi
  if [ "$STATE" = "CLOSED" ]; then
    echo "✗ PR #$PR_NUM was closed without merge (rare); 跳过 cleanup"
    exit 0
  fi
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done

if [ "$STATE" != "MERGED" ]; then
  echo "⚠️ ${TIMEOUT}s 内未完成 merge (CI 可能仍在跑或排队中)"
  echo "   PR 已挂 auto-merge intent，CI 绿后会自动 merge"
  echo "   merge 完成后手动清 worktree："
  echo "     cd <main-repo-or-other-worktree>"
  echo "     git worktree remove $WORKTREE_PATH"
  echo "     git branch -d $CURRENT_BRANCH"
  exit 0
fi
```

**为什么 180s**：观察 Vessel CI `test` job 一般 30-60s 完成（pnpm install + vitest + typecheck），180s 留充足 buffer。如果你的 CI 经常 >3min，调高 `TIMEOUT`。

## Step 5.3: Cleanup worktree + 本地分支

**用户已显式 opt-in auto-cleanup**（CLAUDE.md I8 destructive 的 explicit affirmative 由 "/auto-ship" 触发本身满足）。

```bash
# 1. cd 出当前 worktree（不能在 worktree 内删自己）
#    用 git rev-parse 找主 repo 路径
MAIN_REPO=$(git worktree list --porcelain | awk '/^worktree/ {print $2; exit}')
cd "$MAIN_REPO"

# 2. 删 worktree
git worktree remove "$WORKTREE_PATH" 2>&1

# 3. 删本地分支（-d 是 safe delete，merged 才让删；保险）
#    --delete-branch flag 已删远端；这里收尾本地
git branch -d "$CURRENT_BRANCH" 2>&1 || {
  # squash merge 时 -d 可能 warn "merged to remote but not HEAD"——仍 OK，因为已 merge 上 main
  # 用 -D 强删兜底
  git branch -D "$CURRENT_BRANCH"
}
```

**为什么 -d 兜底 -D**：squash merge 后远端 HEAD 是新 commit hash，本地分支看自己不是 HEAD 的祖先 → `-d` 报 warning。但远端 PR 已 MERGED 状态 → 本地分支确实可以安全删，用 `-D` 收尾。Step 5.2 已 confirm PR state=MERGED，所以 `-D` 是安全的。

## Step 5.4: 终态 echo

```
═══════════════════════════════════════════════════════════
  ✓ auto-ship 完成
═══════════════════════════════════════════════════════════

PR: $PR_URL (MERGED)
合并: squash 上 main
清理:
  - 远端分支:    已删 (gh --delete-branch)
  - 本地分支:    已删 ($CURRENT_BRANCH)
  - worktree:    已删 ($WORKTREE_PATH)
  - 当前 cwd:    $MAIN_REPO
```

如果 Step 5.2 超时（PR 未 merge），echo 跟超时分支的提示一致，**不**做 Step 5.3。

## Step 5.5: 不做的事（明确列出）

- ❌ **不**操作 main 分支本地 checkout 或 pull——cleanup 后 cwd 在 main repo，用户自己决定是否 `git pull`
- ❌ **不**主动 close 别的 PR / 操作别的分支 / 操作别的 worktree
- ❌ **不**做"用 `-D` 跳过 PR=MERGED 检查"——Step 5.3 的 `-D` 兜底必须发生在 Step 5.2 confirm MERGED **之后**

## Step 5.6: 失败回滚（best-effort）

如果 Step 5.1 fail（merge 设置失败）：

- PR 已开，但没 auto-merge
- 已 push 的 commits 仍在远端分支上
- worktree + 本地分支保留（Step 5.2/5.3 不跑）
- **不**做"自动 close PR" 或 "自动 revert commits"——这些是 destructive，用户来决定

只 echo：

```
auto-ship 进到 Phase 5 但 merge 设置失败。PR 仍 open: $PR_URL
worktree + 本地分支保留: $WORKTREE_PATH / $CURRENT_BRANCH
你可以：
- 修 branch protection 后手动 `gh pr merge $PR_NUM --auto --squash`
- 或者放弃这次 ship: `gh pr close $PR_NUM` + `git push origin --delete $CURRENT_BRANCH` + cleanup
```
