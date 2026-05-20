---
name: auto-ship
description: |
  Auto-merge orchestrator for Vessel PRs. Runs the full pipeline: 本地 review → commit → push → 开 PR →
  PR 上 AI review loop（Claude 自审 + cursor-agent 异构并行，最多 3 轮）→ CI 绿后 auto-merge。
  覆盖 CLAUDE.md I13（代码改动默认 NOT auto-merge），等于用户显式 opt-in "全信任 auto-merge mode"。

  Use when the user says:
  "auto-ship" / "/auto-ship" / "自动 ship" / "ship 这个 PR" / "auto-merge 这个分支" /
  "从 review 到 merge 全自动" / "一键发布这个 PR" /
  "把这个分支自动 merge 到 main"

  **关键前提**：用户已经写完代码，**只想把现有分支跑完 review → merge 流水线**。如果代码还没写完
  / 还要做全栈实施 → 不是这个 skill。

  Do NOT use for:
  - 还没写代码、想全栈实施一个新功能 → 用 feature-fullstack（"ship 这个功能" / "全做"）
  - 只是想生成 commit message → 用 conventional-commit
  - 只是想 review 代码 → 用 pre-land-review
  - 只是想开个 PR（不要自动 merge）→ 直接 `gh pr create`
  - 想 merge 但拒绝 auto-merge → 直接 `gh pr merge` 手动

  本 skill 重载 CLAUDE.md I13 + I8。第一步会 echo "auto-ship mode 启动" banner +
  5 秒撤回窗（Ctrl-C）；cursor-agent CLI 不可用时降级到仅 Claude self-review + banner 警告。
---

# /auto-ship — 从 review 到 merge 全自动

## 工作流总览

```
Phase 1 Preflight 启动 banner + 5 秒撤回 + 环境/分支/远端检查       [Read phases/01-preflight.md]
  → Phase 2 本地 review（复用 pre-land-review skill）              [Read phases/02-local-review.md]
  → Phase 3 commit + push + 开 PR（复用 conventional-commit skill） [Read phases/03-commit-push-pr.md]
  → Phase 4 PR review loop（Claude self + cursor-agent 异构并行）   [Read phases/04-pr-review-loop.md]
       ├─ 两边 zero finding → 跳 Phase 5
       ├─ 有 finding → 贴 PR 评论 + auto-fix + push → 下一轮
       ├─ 连续 2 轮 finding diff hash 一致 → ping-pong 中止
       └─ 第 3 轮仍有 finding → 中止 auto-merge, 留 PR 给用户
  → Phase 5 auto-merge（gh pr merge --auto --squash --delete-branch）[Read phases/05-auto-merge.md]
```

**为何默认就走异构 + auto-merge**：用户已显式选择"全信任 auto-merge mode"。但**集体盲区**（Claude 自审 = 同模型既当 author 又当 reviewer）是真风险——auto-merge + 单一模型 review = 把一个盲区错误直接 ship 上 main。所以 review 阶段**强制**喂 cursor-agent (gpt-5.5-medium) 作为异构 reviewer。这是 auto-ship 跟手动 ship 的核心 trade-off：你接受 0 人工 review，那 AI 端就必须双模型并行。

**无 opt-out flag**：auto-ship 只有一条高质量路径。想跳过 review？直接手动 `gh pr merge`。

---

## Prompt Template Read Gate（硬约束，不可绕过）

进入以下阶段**前**，主 agent 必须 Read 对应 phase 文件（禁止凭记忆重建）：

| 阶段 | 必读文件 | 强制 gate 语句 |
|---|---|---|
| Phase 1 启动 | `phases/01-preflight.md` | "我现在 Read phases/01-preflight.md，按里面的 banner + 检查清单跑" |
| Phase 2 本地 review | `phases/02-local-review.md` | "我现在 Read phases/02-local-review.md，按里面的 review/auto-fix/中止规则跑" |
| Phase 3 commit + push + PR | `phases/03-commit-push-pr.md` | "我现在 Read phases/03-commit-push-pr.md，按里面的 commit/push/PR 创建顺序跑" |
| Phase 4 PR review loop | `phases/04-pr-review-loop.md` | "我现在 Read phases/04-pr-review-loop.md，按里面的双 reviewer + 收敛/ping-pong/max-rounds 规则跑" |
| Phase 5 auto-merge | `phases/05-auto-merge.md` | "我现在 Read phases/05-auto-merge.md，按里面的 merge flag 组合跑" |

**为什么这么死板**：[anthropics/skills issue #591](https://github.com/anthropics/skills/issues/591) 指出长对话里 skill instructions 会衰减——LLM 容易"演"模板内容。auto-ship 是 destructive end-to-end 自动化，演错一行可能 ship 一个垃圾 PR 到 main。所有 phase 内容**必须**实时 Read，不靠记忆。

---

## 行为契约（不可破，违反 = bug）

1. **启动 banner + 5 秒撤回窗永远存在**——见 phases/01-preflight.md
2. **cursor-agent fallback**：CLI 不可用时降级 Claude-only + banner 警告"⚠️ 异构 review 失效，本次 ship 集体盲区风险升高"。不静默
3. **PR review loop 最多 3 轮**——硬上限，不接 `--max-rounds` flag
4. **ping-pong 检测**：连续 2 轮 review finding 的归一化文本 SHA-256 一致 → 立即中止
5. **协议层警戒**：diff 含 `packages/shared/` / `packages/backend/src/routes/` / `packages/backend/src/harness-config.ts` / `packages/ios-native/Sources/ClaudeWeb/HarnessProtocol.swift` 时，Phase 1 加二次 5 秒撤回窗（半 I13 兼容，给用户最后机会撤回）
6. **Worktree merge 后自动清**：Phase 5 轮询确认 PR=MERGED 之后会自动 `git worktree remove $WORKTREE_PATH` + 删本地分支。用户触发 `/auto-ship` 本身即是 CLAUDE.md I8 的 explicit affirmative（用户已 opt-in 此 destructive 行为）。如果 Phase 5 轮询超时（180s 内未 merge），worktree + 分支保留，吐手动清理命令
7. **base branch = main**：不允许从 main 直接 ship；分支必须是 feat/* / fix/* / chore/* / docs/*（2026-05-20 起 dev 分支已弃用）

## 复用的现有 skill

| Phase | 复用 | 路径 |
|---|---|---|
| 2 | pre-land-review | `~/.claude/skills/pre-land-review/SKILL.md` |
| 3 | conventional-commit | `~/.claude/skills/conventional-commit/SKILL.md` |
| 4 | reviewer-cross（cursor-agent prompt 源） | `.claude/skills/reviewer-cross/SKILL.md` |

## 失败模式速查

| 症状 | 哪步 | 处理 |
|---|---|---|
| `git ls-remote` timeout | Phase 1 | abort，"远端不可达，无法 ship" |
| `gh auth status` fail | Phase 1 | abort，`gh auth login` 后重试 |
| pre-land-review 有不可自动修项 | Phase 2 | abort + 吐 findings，等用户决定 |
| `git push` rejected | Phase 3 | abort + 吐 stderr（可能远端有别人的 commit；用户自决 rebase/force） |
| `gh pr create` fail (PR 已存在) | Phase 3 | 改用 `gh pr view --json url` 拿到现存 PR，进入 Phase 4 |
| cursor-agent exit 69 | Phase 4 | 降级 banner + Claude-only review |
| cursor-agent exit 65/66/124 | Phase 4 | 重试 1 次；仍失败则降级 + banner |
| 3 轮 review 仍未收敛 | Phase 4 | abort auto-merge + 吐 round-by-round summary，留 PR 给用户 |
| `gh pr merge --auto` reject (branch protection 不允许) | Phase 5 | abort + 提示用户检查 GitHub branch protection 设置 |
| CI fail（after `--auto` flag set） | 自然不 merge | gh 不会强行 merge；PR 保持 open 状态 |
