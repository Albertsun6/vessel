# Phase 3 — Commit + push + 开 PR

## Step 3.1: 生成 commit message

```
Read ~/.claude/skills/conventional-commit/SKILL.md
```

按里面的规则，基于**当前 `git status` + `git diff`** 生成 commit message。

要求：
- 不臆测，基于真实 diff
- type 必须能从分支前缀推：`feat/*` → `feat`、`fix/*` → `fix`、`chore/*` → `chore`、`docs/*` → `docs`、`refactor/*` → `refactor`
- scope 从主改动路径推（`packages/backend/` → `backend`、`.claude/skills/foo/` → `skill`、etc.）
- subject ≤ 72 字符，祈使句，不加句号
- body 解释 why，不解释 what

把生成的 message 存到变量 `$COMMIT_MSG`。

## Step 3.2: stage + commit

**只 stage 应该 stage 的文件**——不要 `git add -A` / `git add .`：

```bash
# 看哪些是本次该 ship 的（已 modified / untracked 且 NOT 在 .gitignore 里）
git status --porcelain
```

按 `git status` 输出，**点名 stage**每个该 ship 的文件：

```bash
git add path/to/file1 path/to/file2 ...
```

然后 commit（用 HEREDOC 避免转义问题）：

```bash
git commit -m "$(cat <<'EOF'
<subject from $COMMIT_MSG>

<body from $COMMIT_MSG>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Step 3.3: push

```bash
git push -u origin "$CURRENT_BRANCH" 2>&1
```

**失败处理**：
- "rejected" + "non-fast-forward" → abort，echo "远端有别人的 commit，请 `git pull --rebase` 后重试"
- "permission denied" → abort，echo "push 权限不足，检查 git remote 配置"
- 其它 → abort + 吐 stderr

## Step 3.4: 创建 PR

```bash
gh pr create \
  --base main \
  --head "$CURRENT_BRANCH" \
  --title "<subject from $COMMIT_MSG>" \
  --body "$(cat <<'EOF'
## Summary

<1-3 行总结，从 commit body 抽>

## Test plan

- [x] 本地 review (auto-ship Phase 2 `pre-land-review`) PASS
- [ ] CI `test` 等 GitHub Actions
- [ ] PR review loop (Claude self + cursor-agent) 等下一步

## auto-ship metadata

- branch: <CURRENT_BRANCH>
- files changed: <DIFF_FILES>
- shortstat: <DIFF_LINES>

🤖 Generated with [Claude Code](https://claude.com/claude-code) via auto-ship
EOF
)" 2>&1
```

抓输出的 PR URL，存到 `$PR_URL`。从 URL 抽 PR number 存到 `$PR_NUM`：

```bash
PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
echo "PR_NUM=$PR_NUM PR_URL=$PR_URL"
```

**失败处理**：
- "a pull request for branch ... already exists" → 用 `gh pr view --json url,number` 拿现存 PR，复用
- 其它 → abort + 吐 stderr

## Step 3.5: 进入 Phase 4

echo："Phase 3 done. PR=$PR_URL → 进入 Phase 4 (PR review loop)"
Read `phases/04-pr-review-loop.md`。
