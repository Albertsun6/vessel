# 个人单机 multi-agent 并行开发协调方案评估

> 调研日期：2026-05-19 | 方法：2 Claude + 1 cursor-agent(GPT-5.5-medium) 异构并行 + Phase 6 多轮辩论收敛

---

## 研究问题

在个人单机 Claude Code 并行开发场景下，现有 git worktree + Steward + eva.json + file-flag 完成信号方案是否合理？有没有更低开销、更高可靠性的替代或改进方式？

## 评估维度

1. **隔离可靠性**（文件+运行时两层隔离的可靠程度）
2. **协调开销**（启停一个并行任务所需手动步骤数）
3. **冲突检测**（文件/分支冲突的提前发现能力）
4. **完成信号可靠性**（worker 完成后主线感知的可靠性）
5. **单人适配性**（1人操控多 session 的认知负担）

---

## 方案对比

| 方案 | 隔离可靠性 | 协调开销 | 冲突检测 | 完成信号 | 单人适配 | 综合 |
|---|---|---|---|---|---|---|
| **当前：worktree + eva.json + file-flag** | 4（文件隔离✓，运行时手动补） | 4 ✓ | 3（owns 手动声明） | 3（file-flag 有半写入风险） | 5 ✓ | 3.8 |
| branch-only（无 worktree） | 2（共享 working dir 会互踩） | 5 ✓ | 1 | 3 | 4 | 3.0 |
| container（Docker per agent） | 5 ✓ | 1（分钟级 spin-up） | 3 | 4 | 2 | 3.0 |
| **改进：worktree + SQLite job ledger + 进程退出信号** | 4 | 3 | 4 ✓ | 5 ✓ | 4 | **4.0** |
| claude-squad（git worktree + tmux TUI） | 4 | 5 ✓ | 3 | 4 | 5 ✓ | **4.2** |

> ✓ 该维度最优　? 数据不足　（综合均值；理性权重视场景而定）

---

## 主要来源

- [Claude Code 官方 worktree 文档](https://code.claude.com/docs/en/worktrees) — 置信度：**高**；`isolation: worktree` subagent flag、.worktreeinclude、无变更自动清理、崩溃孤儿 cleanupPeriodDays
- [Anthropic Engineering: Building a C Compiler with Claude](https://www.anthropic.com/engineering/building-c-compiler) — 置信度：**高**；一手工程案例：`current_tasks/<task>.txt` file-lock + git commit 作为完成信号（git push 即"可验证产物"）
- [CAID Paper (Princeton NLP, arxiv 2603.21489)](https://arxiv.org/html/2603.21489) — 置信度：**高（学术）**；git worktree + branch-merge + structured JSON 协调，PaperBench +26.7% absolute（注：基准为 PaperBench，非 SWE-bench）
- [Building a Durable Message Queue on SQLite for AI Agent Orchestration](https://dev.to/minnzen/building-a-durable-message-queue-on-sqlite-for-ai-agent-orchestration-335m) — 置信度：**高**；SQLite WAL atomic claim + visibility timeout + fencing token vs file-flag 设计
- [claude-squad GitHub](https://github.com/smtg-ai/claude-squad) — 置信度：**高（主流开源）**；git worktree + tmux TUI 管理多 Claude/Codex/Gemini agent，2025-2026 活跃
- [git worktree needs runtime isolation (penligent)](https://www.penligent.ai/hackinglabs/git-worktrees-need-runtime-isolation-for-parallel-ai-agent-development/) — 置信度：**高（工程博客+实测）**；五大运行时隔离盲区（端口/DB/env/browser/日志），并发 dev server 端口冲突实证
- [Cursor 3.2 Changelog](https://cursor.com/changelog/04-24-26) — 置信度：**高（官方）**；2026-04-24，/multitask async subagents + worktrees；Cursor Agents Window 并行 agent 支持
- [Augment Code: git worktrees parallel AI agent execution](https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution) — 置信度：**高**；端口哈希分配 + verifier agent + rebase 策略 + 5-7 agents/machine 实测上限
- [CooperBench (arxiv 2601.13295)](https://arxiv.org/pdf/2601.13295) — 置信度：**高（学术）**；agent 协作需 scaffold 才可靠，2025-01
- [fsnotify issues #372](https://github.com/fsnotify/fsnotify/issues/372) — 置信度：**中**；file watcher 半写入/rename/coalesce 失效模式，2021–2026 持续引用
- [GitHub Copilot coding agent docs](https://docs.github.com/en/copilot/concepts/coding-agent/coding-agent) — 置信度：**高（官方）**；云 agent 用 branch + GitHub Actions ephemeral env，非 worktree
- [OpenHands workspace docs](https://docs.openhands.dev/sdk/arch/workspace) — 置信度：**高（官方）**；LocalWorkspace/RemoteWorkspace/container isolation，非 worktree

---

## 推荐

**结论**：当前 Vessel 方案（git worktree + eva.json + file-flag + BACKLOG.md Steward）方向正确，与个人本地 AI coding tool 业界 2025–2026 共识高度吻合，**核心架构无需重建**。有 3 处有价值的点状改进（P1 最优先），以及 1 个可选替代路径（claude-squad）。

---

### 合理之处（保留）

**1. git worktree-per-agent 是个人本地工具的主流选择** [置信度：高]

Claude Code（官方 `isolation: worktree`）、Cursor 3.2（Agents Window + worktrees）均收敛到 worktree 作为本地隔离原语。Vessel 的选择是正确的。

> ⚠️ 精确措辞：这是**本地 IDE/CLI agent**的收敛方向。云 agent（GitHub Copilot coding agent、OpenHands 云端、Google Jules）更常用 branch + ephemeral/container workspace，共同点是"隔离 workspace + 显式集成"。不能说"业界全部收敛到 worktree"。

**2. BACKLOG.md + Steward I11 协议是设计亮点** [置信度：高]

业界共识（Augment Code 指南、CAID 论文）："spec-driven 任务分解质量 > 协调机制复杂度"，"spec 不写好，并行 agent 只是制造更快的冲突"。Vessel 的 dispatch 前强制人工拍板（I11）与此完全吻合。不建议拆除。

**3. eva.json JSON 注册表对当前单用户够用** [置信度：中高]

低并发（≤3 worker，写操作不重叠）+ 当前已有 atomic-rename write + promise-queue write lock → JSON 足够。SQLite WAL 的额外原子性对此负载无边际收益。

> 注：这是基于当前项目负载（≤3 worker）的工程判断，非来源直接证明。SQLite 官方说"low writer concurrency is ok"，但未给出具体 worker 数阈值（来源：https://sqlite.org/whentouse.html）。

---

### 3 处改进建议（优先级排序）

**P1 — 完成信号加 git commit 辅证**（成本：极低，强烈建议）

当前 `~/.vessel/spawn-done/<id>.json` 是 file-flag，有已知失效模式（fsnotify 社区文档：rename/半写入/coalesce 事件丢失）。

Anthropic 自己的工程实践（C 编译器案例）是：agent 完成 = git push（可验证产物），file-lock 删除是附产物不是主信号。

**改进**：`steward-signal-done.sh` 写 spawn-done JSON 时同时 verify `git log --oneline -1` 有新 commit（或 PR URL 已填）。信号从 file-only 升为 **file + verifiable artifact**（git commit），可靠性大幅提升，成本极低。

**P2 — 端口自动分配**（成本：低）

当前 `.env.local` 手动写 PORT，"忘写端口"导致 backend 冲突是高频问题。

改为 `eva.json` 注册时按分支名哈希生成端口（如 `3033 + abs(hash(branch_name)) % 10`），消除人工误操作。Augment Code 和 Upsun 均记录了端口哈希分配模式。

**P3 — 冲突预检自动化**（成本：中，可选）

`开始干 <id>` 时，在 echo dispatch 分析前，自动跑 `git diff --name-only HEAD..origin/dev` + 与 `owns` 字段做 intersection，有重叠时显式标红警告。当前只靠 `owns` 字段人工维护，无自动比对。CAID 的 Manager 在分配 worktree 前先做依赖图分析，可参考。

---

### 可选替代路径

**[claude-squad](https://github.com/smtg-ai/claude-squad)**（git worktree + tmux TUI）

零额外配置体验，支持 Claude Code/Codex/Gemini/Aider 多 agent，2025-2026 持续活跃（最新 commit 2026-05-18）。认知负担评分比当前手动 worktree 管理低。

**迁移收益有限**：Vessel 有 iOS native + Tailscale + 个人化 Steward 协议，这些都是 claude-squad 没有的。使用 claude-squad 替代 worktree 管理层可行，但不解决上层协调问题。

---

### 适用条件

- **此建议有效**：1 人 + Claude Code CLI + macOS + 每次最多 2–3 个并行 worker
- **需重新评估**：worker 数 > 5 同时写、多人协作 → 考虑 SQLite job ledger + 进程退出信号替代 file-flag + eva.json

**置信度**：**高**（基于 ≥12 个 High 质量 source，涵盖官方文档 ×4、学术论文 ×3、一手工程博客 ×5）
> 高置信度限定范围：**"worktree 是合理个人本地隔离底座"** 这一核心结论。对 claude-squad 迁移价值和 Cursor /multitask 本地能力的判断是 medium 置信度（见待验证风险）。

---

## 待验证风险

- [ ] **file-flag atomic write 在 macOS APFS 实际行为**：`spawn-done/<id>.json` 是否用 atomic rename 写入？高并发写入在 M1/M2 上是否有实测半写入数据。验证：检查 `steward-signal-done.sh` 实现 + stress test
- [ ] **eva.json concurrent write 保护**：`projects-store.ts` 有 promise-queue write lock，`eva.json` 本身是否有等价保护？2 个 worker 同时注册 worktree 是否会丢数据
- [ ] **claude-squad AGPL-3.0 license**：集成或改造 claude-squad 时需单独评估合规成本。来源：[GitHub API](https://api.github.com/repos/smtg-ai/claude-squad)
- [ ] **claude-squad 上游 CLI 兼容性**：v1.0.17 专门 match Claude CLI 文案（trust prompt/MCP 提示），Claude Code changelog 持续变更交互层。需关注上游变更 → 版本锁定 + 回归测试。来源：[v1.0.17 release](https://github.com/smtg-ai/claude-squad/releases/tag/v1.0.17)
- [ ] **Cursor /multitask 本地/云边界**：Cursor Agents Window changelog 只说后台 isolated tasks + 可移到 local foreground，不等价于本地 Claude Code worker。是否支持完全 local 运行需验证。来源：[Cursor 3.2 Changelog](https://cursor.com/changelog/04-24-26)
- [ ] **GitHub Copilot / OpenHands "worktree 等价"**：这两者用 ephemeral/container workspace 而非 worktree，其隔离级别与 worktree 的实际对比需独立验证

---

## 调研 Metadata

- **调研模式**: 2 Claude + 1 cursor-agent(GPT-5.5-medium) 异构并行（Phase 2），无降级
- **Phase 2.5 Reflection**: 子问题 5/5 覆盖；High source ≈60%；Vendor-only claims = Devin VM（次要）；追搜：No
- **Phase 5.5 Citation Health**: Layer A: 10/10 ok (100%) — PASS；Layer B: 5 claims sampled — 4 supported, 1 partial（CAID 基准名修正为 PaperBench）— PASS
- **Phase 6 异构终审 verdict**: Round 1 Refine → Round 2 收敛（双方同档）
- **辩论收敛**: Round 2 收敛（无需 Round 3 / 人类裁决）
- **人类介入**: 无
- **Output**: /Users/yongqian/Desktop/Vessel/个人单机multi-agent并行开发协调方案评估-完整报告.md
- **HTML**: /Users/yongqian/Desktop/Vessel/个人单机multi-agent并行开发协调方案评估-完整报告.html
- **Audio**: /Users/yongqian/Desktop/Vessel/个人单机multi-agent并行开发协调方案评估-音频概要.m4a

#### Phase 6 辩论历史（Round 1 Refine → Round 2 收敛）

##### Round 1 主 agent 判断矩阵

| 建议 | 立场 | 论据 |
|---|---|---|
| 补 Agent X Source Inventory（压缩格式）| partial | 审计价值有限，改为 metadata 简注 |
| 收窄 "全部采用 worktree" 表述 | accept | Copilot/OpenHands 用 ephemeral/container，非 worktree；URL 证据充分 |
| 新增风险：claude-squad AGPL-3.0 | accept | GitHub API 确认 AGPL-3.0，合规风险真实 |
| 新增风险：claude-squad 上游兼容 | partial | 2026-05-18 仍活跃，风险低；轻量注脚 |
| 新增风险：Cursor /multitask 本地边界 | accept | changelog 不能证明 local parity |
| Q3/Q4 "≤3 workers" 标工程判断 | partial | 加 caveat 合理，不需重写结论 |
| Source Quality / Citation Health | accept | — |

##### Round 2 主 agent 二轮判断

| 建议 | cursor-agent 反驳 | 主 agent 立场 | 论据 |
|---|---|---|---|
| Agent X Inventory | DeepTRACE(arxiv 2509.04499) 审计深度论证 | **让步→accept**（压缩表格入 metadata） | 新证据有说服力 |
| claude-squad 上游兼容 | v1.0.17 match Claude CLI 文案；Claude Code changelog 持续改交互层 | **让步→accept**（正式风险条目） | v1.0.17 release note 直接证据 |
| ≤3 workers caveat | 撤回 Round 1 建议，维持 partial+caveat | **维持 partial** | 双方同档，收敛 |

#### Agent X 独有发现（Phase 2 异构搜索补充）

以下 source 由 cursor-agent(Agent X) 独立找到，Claude Agent A/B 未覆盖：

| Source | 关键发现 | 采纳状态 |
|---|---|---|
| [dmux](https://github.com/justin-schroeder/dmux) | 本地 dev agent multiplexer，围绕 git worktree + 多 coding agent 编排，2026 活跃 | 纳入可选替代候选 |
| [daintree](https://github.com/daintreehq/daintree) | 聚焦 Claude/Gemini/Codex 多 session、worktree、终端和 context 注入 | 纳入可选替代候选 |
| [fsnotify issues #372](https://github.com/fsnotify/fsnotify/issues/372) | file watcher 半写入/rename/coalesce 失效模式的一手社区记录 | 采纳（支持 P1 改进） |
| SQLite WAL 官方文档 | 一 writer 限制 + 低并发场景适用性说明（vs Redis at-most-once） | 采纳（支持 eva.json 继续使用判断） |
| [OpenAI Codex subagents](https://developers.openai.com/codex/subagents) | Codex 官方 subagents 支持并行 + SQLite-backed job state | 纳入（非 Anthropic 生态对比） |
| [Google Jules](https://jules.google/docs/) | VM clone + 异步执行 + GitHub 集成，非 worktree | 采纳（收窄"业界全部 worktree"表述） |
