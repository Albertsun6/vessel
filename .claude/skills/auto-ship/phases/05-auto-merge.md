# Phase 5 — Auto-merge

## Step 5.1: 设置 auto-merge

```bash
gh pr merge "$PR_NUM" --auto --squash --delete-branch 2>&1
```

**flag 说明**：

- `--auto`：**等 CI `test` job PASS 后才自动 merge**——这是 auto-ship 安全的最后一道闸门。即使 review 通过，CI fail 就不会 merge。`gh` 帮你"挂"这个 merge intent 在 GitHub 上
- `--squash`：跟 Vessel branch model 一致——feat/* PR squash 进 main
- `--delete-branch`：merge 完自动删远端 + 本地分支（worktree 不受影响）

**失败处理**：

| stderr 包含 | 原因 | 处理 |
|---|---|---|
| `pull request is not in a mergeable state` | 通常因为 base 有 conflict | abort + 提示用户手动 rebase |
| `not enough permissions` / `restricted` | branch protection 不允许 auto-merge | abort + 提示用户检查 GitHub Settings → Branches |
| `required status checks` not configured | CI 没设成必需 | abort + 提示用户在 branch protection 加 require status checks |

## Step 5.2: 终态 echo

```
═══════════════════════════════════════════════════════════
  ✓ auto-ship 完成
═══════════════════════════════════════════════════════════

PR: $PR_URL
状态: 已挂 auto-merge, 等 CI test PASS 后自动 merge 到 main
合并方式: squash + delete branch

后续观察:
- gh pr view $PR_NUM --json mergedAt,state    # 看 merge 状态
- gh run list --branch $CURRENT_BRANCH         # 看 CI

worktree 在 $(pwd), 想清就跑 `git worktree remove <path>`（destructive, 需你拍板）
```

## Step 5.3: 不做的事（明确列出）

- ❌ **不**主动 `git worktree remove`——destructive，CLAUDE.md I8
- ❌ **不**等 merge 完才退出 skill——CI 可能跑 5-15 min，没必要堵着；`--auto` flag 帮你挂 intent
- ❌ **不**主动 close 别的 PR / 操作别的分支
- ❌ **不**操作 main 分支本地 checkout 或 pull

## Step 5.4: 失败回滚（best-effort）

如果 Step 5.1 fail：

- PR 已开，但没 auto-merge
- 已 push 的 commits 仍在远端分支上
- **不**做"自动 close PR" 或 "自动 revert commits"——这些是 destructive，用户来决定

只 echo：

```
auto-ship 进到 Phase 5 但 merge 设置失败。PR 仍 open: $PR_URL
你可以：
- 修 branch protection 后手动 `gh pr merge $PR_NUM --auto --squash`
- 或者放弃这次 ship: `gh pr close $PR_NUM` + `git push origin --delete $CURRENT_BRANCH`
```
