---
name: steward
description: |
  Steward V0 工作分发+跟踪+收尾总入口。把 docs/BACKLOG.md + 10 个用户短语 + boot ritual
  打包成一个连贯 skill。Use when 用户粘 `/steward`、`/steward <任意短语>`，或直接粘以下
  任一 Steward 短语：
  `/boot` / `看 backlog` / `看 backlog 推荐下一步` /
  `开始干 <id>` / `<id> 收线` /
  `加待办: <title>; P<0-3>; <S/M/L>; [note]` / `即时代办: <title>` /
  `<id> blocked 因为 <reason>` / `<id> unblock` / `<id> 改 P<0-3>` / `<id> drop 因为 <reason>` /
  `现在哪些窗口在干啥` / `看看谁完成了` / `pnpm eva:collect`。
  契约 docs/adr/vessel/ADR-019；硬约束 I1/I5/I8/I9/I11 在本 skill 正文内联，
  打包不稀释人工确认门。这是 9 个 Steward prompt 的统一入口；`/boot` 仍作最小兜底共存。
---

# Steward V0 — 工作分发总入口

被 `/steward` / `/steward <短语>` 触发，或用户直接粘任一 Steward 短语。

**路由**：读到输入 → 匹配下面某一节的触发短语 → 跳该节执行。匹配不到 → echo 节 0 的
10 短语 cheatsheet，问用户要干啥。`/steward` 无参 = 节 0。

> 本 skill 是**可执行精炼版**。短语逐字详解见 [docs/STEWARD_PROMPTS.md](../../../docs/STEWARD_PROMPTS.md)，
> 用户手册见 [docs/STEWARD_USAGE.md](../../../docs/STEWARD_USAGE.md)，契约权威见
> [ADR-019](../../../docs/adr/vessel/ADR-019-steward-v0-contract.md)。本 skill 不复制 docs（I6），
> 内联的 I-约束是**执行提醒副本，语义以 ADR-019 为准**。

## 硬约束（每个写分支执行前必读，内联，打包不可稀释）

- **I1** — `docs/BACKLOG.md` 是状态唯一写入点。worker **不**直接改 BACKLOG / eva.json，
  走 file flag + 主线 `pnpm eva:collect`（I12）。
- **I5** — 用户从不写 YAML。Claude 改完 BACKLOG **先 echo diff**，等用户 `ok`/`yes`/`继续`
  才落盘。
- **I8 三层执行白名单**：
  - read-only auto：`git status` / `ls` / `cat` / `pnpm eva:sessions` / `pnpm eva:collect`
    （不带 `--clear`）→ 默许自动跑
  - write needs ack：`git commit` / 改 BACKLOG / `gh pr edit` / `eva:collect --clear`
    → echo 命令 + 等用户 `ok`/`yes`/`继续`
  - destructive needs explicit affirmative：`rm -rf` / `git push --force` /
    `git worktree remove` / `eva:hook pre-remove --yes` → **永不静默**，要用户主动短语肯定
- **I9 commit 守门** — 改 BACKLOG 后 `git status --porcelain` 检查：纯净则自动 commit；
  有其它 dirty 文件则**只 stage BACKLOG** + ack 后 commit；**决不静默 stage 用户其它文件**。
- **I11 dispatch 必经用户拍板** — `开始干` / `即时代办` 触发时 Claude **不直接动手**：
  先 echo task size + parallel_safe_files + 主窗口状态 + `pnpm eva:sessions` 活窗口 +
  spawn 推荐 + 理由，等用户回 `ok spawn` / `ok stay` / `用户做` 才执行。**永不静默选边。**

---

## 节 0 — `/steward` 无参 / boot ritual

**触发**：`/steward`（无参）/ `/boot` / `看 backlog` / `看 backlog 推荐下一步`

**必做**：等同 [.claude/skills/boot/SKILL.md](../boot/SKILL.md) 的「必须做的 4 步」
（读 `docs/BACKLOG.md` → 顶部"最近更新" > 72h 则首行 ⚠️ stale → 数 status 分布 →
echo 一行摘要 → in_progress > 0 列前 1-3 项）。**权威定义以 boot SKILL.md 为准，不复制**。
若输入含「推荐下一步」：再跑 `pnpm eva:sessions --format json`，输出 top 1-3 候选 +
每项标签（本窗口直接做 / 需开新窗口 / 等着）+ 开窗命令模板。

**echo**：`Backlog: N in_progress · M planned · K blocked · L done · D dropped`

**等什么**：无（read-only auto，I8）

**脚本**：Read `docs/BACKLOG.md`；可选 `pnpm eva:sessions --format json`

结尾邀请：`要做什么？(开始干 <id> / 加待办: ... / 看看谁完成了 / 详见 docs/STEWARD_PROMPTS.md)`

## 节 1 — 开始干 <id>

**触发**：`开始干 <task-id>`

**必做**：找该 id → 验 `status=planned` + `depends_on` 全 done → 跑
`pnpm eva:sessions --format json` → **走 I11**：echo 分析 + 推荐 + 理由 → **停，等拍板**。

**echo**：Task / size / priority / parallel_safe_files / depends_on / 主窗口状态 /
eva:sessions 活窗口 / 建议 `SPAWN`|`STAY`|`USER-MANUAL` / 理由 / 选择菜单

**等什么**：`ok spawn` | `ok stay` | `用户做`（I11，永不静默选边）

**后续**：
- `ok spawn` → echo 5 步 worktree 命令模板 → **再等 1 次 ack**（I8 write）→ 执行 →
  改 BACKLOG `status=in_progress` + `assigned_kind=worktree` + `assigned_cwd` → commit（**I9 守门**）
- `ok stay` → 改 BACKLOG `in_progress` + `assigned_kind=main` → commit（I9）→ 本窗口开始干
- `用户做` → 改 BACKLOG `in_progress` + `assigned_kind=user-manual` → commit（I9）

**脚本**：`pnpm eva:sessions --format json`；改 `docs/BACKLOG.md`；`git commit`（I9）

## 节 2 — <id> 收线

**触发**：`<task-id> 收线`（或承接节 10：`ok 收线 <id>`）

**必做**：找 id → 验 `status=in_progress` → 问 outcome：
- `done` → `status=done` + 写 `completed_at`（ISO-8601 UTC+Z）+ `refs`（PR/commit/ADR）
- `blocked` → `status=blocked` + 必填 `blocked_reason`
- `dropped` → `status=dropped` + 原因写 note + 移 Done 段（I4 永久审计）

若 `assigned_kind=worktree`：echo `pnpm eva:hook pre-remove --dry-run <name>` → 等用户
**显式肯定**（destructive，I8 顶层）→ `--yes` 执行。承接节 10 时还需
`pnpm eva:collect --clear <id>`（I8 write，ack 后）。

**echo**：BACKLOG diff（I5）

**等什么**：outcome 选择；worktree 移除显式肯定（I8 destructive）

**脚本**：改 `docs/BACKLOG.md`；`git commit`（I9）；`pnpm eva:hook pre-remove`；
`pnpm eva:collect --clear <id>`

## 节 3 — 加待办

**触发**：`加待办: <title>; P<0-3>; <S/M/L>; [note]`（字段可省，默认 P3 / M）

**必做**：title slugify 成 id（撞名加 `-2`/`-3`，符合 id 正则）→ 加 BACKLOG Active 段
`status=planned` → **echo diff（I5）** → 等 ack → commit（I9）

**echo**：生成的 YAML 条目 diff

**等什么**：`ok`/`yes`/`继续`（I5 + I8 write）

**脚本**：改 `docs/BACKLOG.md`；`git commit`（I9）

## 节 4 — 即时代办（加+立刻做，v0.4 fastpath）

**触发**：`即时代办: <title>; [P<0-3>]; [<S/M/L>]; [note]`（默认 P1）

**必做**：**一次 echo 同时提议两件事**：(a) 新增 BACKLOG 条目 `status=in_progress`
（跳过 planned）(b) 跑 dispatch 协议（**I11**：size 分析 + spawn 推荐 + 理由）。
用户 1 个 `ok` 同时承认两件事。不破任何契约（仍走 I1/I5/I8/I9/I11）。

**echo**：即时代办条目 diff + dispatch 分析合并块

**等什么**：`ok`（=同时承认写 BACKLOG + 按推荐开始）| `ok spawn` | `用户做` |
`改 P<n>` / `改 size` / `drop`（I5+I9+I11 全保留，不引入新决策权）

**脚本**：改 `docs/BACKLOG.md`；`git commit`（I9）；`pnpm eva:sessions --format json`

## 节 5 — <id> blocked 因为 <reason>

**触发**：`<task-id> blocked 因为 <reason>`

**必做**：改 `status: planned→blocked` + 必填 `blocked_reason`（与 computed-blocked 区分）
→ echo diff（I5）→ ack → commit（I9）

**脚本**：改 `docs/BACKLOG.md`；`git commit`（I9）

## 节 6 — <id> unblock

**触发**：`<task-id> unblock`

**必做**：改 `status: blocked→planned` + 清 `blocked_reason` → echo diff（I5）→ ack →
commit（I9）

## 节 7 — <id> 改 P<0-3>

**触发**：`<task-id> 改 P<0-3>`

**必做**：改 `priority` 字段 → echo diff（I5）→ ack → commit（I9）

## 节 8 — <id> drop 因为 <reason>

**触发**：`<task-id> drop 因为 <reason>`

**必做**：改 `status→dropped` + reason 写 note + 移 Done 段（**I4 审计 trail 永久保留**，
不删）→ echo diff（I5）→ ack → commit（I9）

## 节 9 — 现在哪些窗口在干啥

**触发**：`现在哪些窗口在干啥`

**必做**：跑 `pnpm eva:sessions`（人眼看 ASCII；机器消费 `--format json`）→ 输出每个活
session 的 PID / 分支 / cwd / 最近活动 + 其 assigned 的 BACKLOG 项

**等什么**：无（read-only auto，I8）

**脚本**：`pnpm eva:sessions`

## 节 10 — 看看谁完成了 / pnpm eva:collect（V0.5 R1 主线侧收 worker）

**触发**：`看看谁完成了` / `pnpm eva:collect`（`看 backlog` 顺带扫一遍）

**必做**：跑 `pnpm eva:collect` 扫 `~/.vessel/spawn-done/*.json` → echo pending 完成项
（task_id / branch / pr / summary / 完成多久）。worker **不**直接改 BACKLOG（I1/I12）。

**echo**：pending 完成项列表

**等什么**：用户 `ok 收线 <id>`

**后续**：`ok 收线 <id>` → `pnpm eva:collect --clear <id>`（I8 write，ack 后）→ 走
**节 2「<id> 收线」**协议更新 BACKLOG。

**脚本**：`pnpm eva:collect`；`pnpm eva:collect --clear <id>`；改 `docs/BACKLOG.md`；commit（I9）

> 自动提示：master 会话结束时 Stop hook 会自动跑只读 `eva:collect` 提示有谁待收线
> （ADR-019 I14，notify-only，不自动收线）；长挂会话可粘
> `/loop 15m node /Users/yongqian/dev/Vessel/scripts/eva-collect.mjs --exit-code`
> 周期被动提醒。两者都**只提示不写状态**，收线仍必经你粘 `ok 收线 <id>`。
> worker 侧自报完成用 `./scripts/steward-signal-done.sh`（不在本 skill；I12/I13）。

---

## 不做的

- ❌ boot 时不自动跑 `pnpm eva:sessions`（lazy；用户问"下一步"/"活窗口"才跑）
- ❌ 用户没问不主动推荐下一步
- ❌ 不静默 commit / 不静默 stage 用户其它 dirty 文件（I9）
- ❌ 不让 worker 直接改 BACKLOG / eva.json（I1/I12）
- ❌ 不替代代码 / 评审 / 调研工作本身（走对应 skill）
- ❌ 自动收线提示（Stop hook / `/loop`）只 notify，绝不自动改 BACKLOG / 收线 / dispatch（I14）

## 错误处理

- **BACKLOG.md 不存在** → echo `❌ docs/BACKLOG.md 不存在 — Steward V0 未初始化。详见 docs/STEWARD_USAGE.md。`
- **YAML 解析失败** → echo `❌ BACKLOG.md YAML 解析失败 (line N)。可能需从 ~/.vessel/backlog-mirror.jsonl 复原。详见 STEWARD_USAGE.md §错误恢复。`
- **顶部缺 "最近更新" 时间戳** → 跳过 stale 检查，继续 echo 摘要

## 相关

- 数据：[docs/BACKLOG.md](../../../docs/BACKLOG.md)
- 用户面短语逐字：[docs/STEWARD_PROMPTS.md](../../../docs/STEWARD_PROMPTS.md)
- 详细手册：[docs/STEWARD_USAGE.md](../../../docs/STEWARD_USAGE.md)
- 契约 ADR（语义权威，I1-I14）：[docs/adr/vessel/ADR-019-steward-v0-contract.md](../../../docs/adr/vessel/ADR-019-steward-v0-contract.md)
- 最小兜底（共存）：[.claude/skills/boot/SKILL.md](../boot/SKILL.md)
- Boot ritual 约定在 CLAUDE.md「Session boot ritual (Steward v0)」段
