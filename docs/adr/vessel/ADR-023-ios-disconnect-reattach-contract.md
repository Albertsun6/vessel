# ADR-023 — iOS 断线 Run 存活与重挂 Wire 契约

> Status: ✅ Accepted（contract mode phase 1+2+3 收敛 2026-05-19）· Lite · Supersedes: — · Related: ADR-000（Eva 基座）/ ADR-013（rename）
> 编号源：`docs/adr/README.md` ledger（021 预留 Steward；023 空闲取之）

## Context

iOS app 等待长回合时切后台/锁屏，iOS 2-6min 后挂起拆 WS socket；backend `index.ts:688 ws.on("close")` 用与用户主动 `interrupt` **同一个 `abort.abort()`** 立即 SIGKILL 正在生成的 `claude` 子进程 → 回合服务端被销毁；iOS 重连 `clearStuckRunsAfterReconnect` force-clear → 答案丢失。telemetry 实证：前台从无 ws abort，100% 后台相关。

上游已收敛 [proposal IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL v0.2](../../proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md)（范围锁 A1+A2/C，orphan TTL ~8-10min/waiting 更短，用户 2026-05-19 拍板）。本 ADR 锁定其 wire/runtime 契约 = [contract IOS_DISCONNECT_REATTACH_CONTRACT v0.2](../../contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md)。属 CLAUDE.md 阶梯层 wire 协议锁定点。

## Decision

锁定 6 条契约（详见 contract v0.2 §2-§7）：
1. **C1** 新入站 `reattach_run{runId,conversationId,sessionId?,cwd}`（cwd 过 `verifyAllowedPath`）。
2. **C2** 新出站 `run_status`，status 7 值 = `running|interrupting|completed|failed|aborted|expired|unknown`（**不含** workflow_choice——workflow 是 runId-less 广播子系统，结构不可经 runId reattach 路由；Phase C 工作流暂停 = 纯 additive iOS UI 渲染已广播的 `vessel_workflow_paused`，承载层 ≠ wire）。Swift 须改 4 触点（case/decode/runId/typeName/handle）。
3. **C3** Run 状态机 `attached_running|detached_running|interrupting|completed_detached|expired`；**仅 `client_interrupt`/`ttl_expired` 调 `abort()`**，`ws_close`/`liveness_lost` 永不 abort；`interrupting` reattach 回 interrupting 不提前合成 aborted；Stop replay 必带具体 runId。
4. **C4** `run-registry.RegisteredRun` 加 **run-owned 可重绑 output sink**（`attachedSend/attachConnectionId/attachGeneration`，所有 emission 经 registry sink 非闭包捕获连接 send，原子换 sink + generation fence）+ orphan manager（state/lastActivityAt/detachedAt/terminal record）+ **backend WS liveness**（新 ping/pong，不复用 heartbeatRecordSpawn）。
5. **C5** permission resolver 生命周期，**单一 owner = `permission.ts`**，3 API（detach/reattach/terminate），3 终态（reattach 恢复 / WAITING_DETACHED_TTL→`resolve("deny")`+expire / 真终结 terminate-deny），**detached 永不 allow**，移除 ws_close 同步伪 deny。
6. **C6** `clientCapabilities.reattach` 协商 + env `VESSEL_RUN_SURVIVES_DISCONNECT`（默认 OFF）双门控；未门控则旧行为逐字节不变。

**TTL 锁定值**：`DETACHED_TTL=600s` · `WAITING_DETACHED_TTL=120s` · `ATTACHED_LIVENESS_TTL=90s`(实施期 dogfood 可调，须回改本 ADR) · `TERMINAL_RECORD_TTL=300s`。

**不做**：seq-buffer mid-stream 续播（proposal Phase B，按需另起 contract）；workflow 暂停的 reattach 续命（不需要，服务端已存活）；SQLite schema 改动（无）。

## Consequences

- **不可逆度 中**：纯 additive wire（新消息类型 + 可选字段）+ capability/flag 双门控；旧 iOS 路径逐字节不变。无 DB migration。
- **回滚路径**：`VESSEL_RUN_SURVIVES_DISCONNECT=OFF`（env flip，无需 redeploy/改客户端）→ 立即回退到现行 ws_close→abort 行为。
- **新增的两个代码级机制**（C4 sink rebind、C5 permission lifecycle）由评审逐字段指定但未单独过 phase-1 → **patch 阶段 dogfood gate 强制验证**（contract §11 测试 2/3/6：590s 安全单测、sink rebind、I-12/13/14 静态检查）。这是 contract→patch 正确交接。
- **风险残留**：half-open liveness 依赖新增 WS ping/pong 正确实现；permission timer 跨模块 owner 收敛到 permission.ts（回归 locus 已识别，I-14 + grep dogfood 守门）。
- **后续**：实施走 patch mode（plan → 代码 → dogfood gate → PR per HARNESS_PR_GUIDE）。Phase C 工作流暂停 iOS 渲染为紧邻 sibling 项（pure additive UI，无 wire lock）。

## Review trail

- Phase 1: [arch](../../reviews/contract-reattach-arch-2026-05-19-2114.md)（2 BLOCKER: ADR#, workflow 不可路由）· [cross GPT-5.5](../../reviews/contract-reattach-cross-2026-05-19-2114.md)（2 BLOCKER: 590s 承重墙, sink 空心）
- Phase 2: [react-arch](../../reviews/contract-reattach-react-arch-2026-05-19-2114.md)（自升 F3→BLOCKER + 新增 F8）· [react-cross](../../reviews/contract-reattach-react-cross-2026-05-19-2114.md)（收下 F1/F2/F7，M5 升结构性）
- Phase 3: [arbitration](../../reviews/contract-reattach-arbitration-2026-05-19.md)（9 ✅ · 1 ⚠️ · 0 🚫 · 1 🟡）
- Contract: [IOS_DISCONNECT_REATTACH_CONTRACT.md v0.2](../../contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md)
- Proposal: [IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md v0.2](../../proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md)
