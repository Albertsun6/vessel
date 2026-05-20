# Phase 2 — Local review

## Step 2.1: Read pre-land-review skill

```
Read ~/.claude/skills/pre-land-review/SKILL.md
```

按里面定义的 lens 跑——SQL safety / LLM trust boundary / 条件副作用 / race / 结构性问题。

输入是 `git diff main...HEAD`（即本分支相对 main 的全部 diff）。

## Step 2.2: Findings 分类

把 pre-land-review 输出的每条 finding 标成：

- `[auto-fix]` — 可以**机械**修的：未用 imports / 拼错的 type / 明显的 typo / formatting / lint
- `[needs-decision]` — 涉及语义 / 架构 / API 设计 / 性能 trade-off / security 判断

## Step 2.3: 处理路径

### A. 全部 `[auto-fix]`（或零 findings）

- 用 Edit 工具修每条 auto-fix
- 跑相关 verifier 确认修对了（如修了 imports，跑 `pnpm --filter @vessel/shared test` 之类）
- echo："Phase 2 fixed N items, 0 needs-decision → 进入 Phase 3"
- Read `phases/03-commit-push-pr.md`

### B. 有任何 `[needs-decision]`

**立即中止 auto-ship**。echo：

```
═══════════════════════════════════════════════════════════
  ⚠️ auto-ship 中止：本地 review 发现 N 条需要决策的 finding
═══════════════════════════════════════════════════════════

[逐条列 needs-decision finding，含文件 + 行号 + 描述]

这些 finding 不能机械修，需要你决定。建议下一步：
- 用 debate-review skill 处理（如果你想就 review 反馈做结构化辩论）
- 或者直接告诉我怎么改，我修完你再触发一次 /auto-ship
```

**不**自动进入 Phase 3。等用户回复。

## Step 2.4: 防御——禁止"修了又留 noise"

跑 `git diff` 检查 Step 2.3.A 阶段的修改：

- 只该有 auto-fix 范围内的改动
- 不该附带"顺手清理的相邻代码"（CLAUDE.md ③ Surgical Changes）

若发现 noise → 用 `git checkout -p` 把多余改动撤回，只保留 auto-fix。
