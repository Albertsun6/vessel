# iOS 断线 Reattach — 实施计划（patch-plan）

> **Status**: plan（patch mode 前置）· **Date**: 2026-05-19 · **Author**: claude (opus-4-7)
> **锁定输入**：[contract v0.2](IOS_DISCONNECT_REATTACH_CONTRACT.md)（收敛）· [ADR-023](../adr/vessel/ADR-023-ios-disconnect-reattach-contract.md) · [proposal v0.2](../proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md)
> **不写代码前提**：本文件是执行 plan；按 CLAUDE.md 阶梯层，wire 已由 ADR-023 锁；实施走 patch mode（code → dogfood gate → PR per HARNESS_PR_GUIDE）。**待用户定分支策略后再落代码**（见 §5）。

## 1. 范围（来自收敛决策）

做：**A1**（完成态/在跑态重挂止血）+ **A2**（permission 暂停重挂）+ **C**（选择 UI 补全：PermissionSheet 拒绝并指示 + vessel_workflow_paused 渲染）。
不做：Phase B seq-buffer（按需另起 contract）；workflow 暂停的 reattach 续命（不需要，服务端已存活）；SQLite schema（无）。
门控：`VESSEL_RUN_SURVIVES_DISCONNECT`（默认 OFF）+ `clientCapabilities.reattach` 双门控；未门控旧 iOS 逐字节不变。

## 2. 实施切片（按依赖排序，每片独立可验证）

> 每片末尾 = 对应 contract §11 dogfood 测试号（patch 阶段硬门禁）。

### S1 — 协议类型（三端 additive，无行为变更，最先落）
- `packages/shared/src/protocol.ts`：ClientMessage 加 `reattach_run`；ServerMessage 加 `run_status`（7 status）；`user_prompt` 加 `clientCapabilities?:{reattach?:boolean}`。
- `packages/ios-native/.../Protocol.swift`：`ClientMessage` 加 `reattachRun` case+encode；`ServerMessage` 加 `runStatus` case + decode(`?? .unknown`) + **`runId` switch 分支 + `typeName` switch 分支**（M-SWIFT 4 触点缺一即 drop）。
- 验证：**dogfood #1**（TS↔Swift round-trip，含未知 status→.unknown 不崩）。

### S2 — run-registry 扩展为 run-owned sink + 状态 + terminal record（核心，B-SINK）
- `packages/backend/src/run-registry.ts`：`RegisteredRun` 加 `state/lastActivityAt/detachedAt?/sessionId?/conversationId?/capabilityReattach/pending?/terminal?` + `attachedSend?/attachConnectionId?/attachGeneration`；加 `attach(runId,send,gen)` 原子换 sink、`setState`、`recordTerminal`、reaper `setInterval(30s)`。
- `packages/backend/src/index.ts`：run 的**全部** emission（onMessage/onClearRunMessages/session_ended/error）改为经 `registry.get(runId)?.attachedSend` + generation fence，**删除闭包捕获 per-connection `send` 用于 run 输出**；`registerRun()` call-site（:569-570）传初始 `state=attached_running/lastActivityAt/capabilityReattach`。
- 验证：**dogfood #3**（中途 ws_close→reattach→后续 sdk_message 到新连接、旧 gen 丢弃）+ **#6** I-13 grep（run 输出无闭包捕获连接 send）。

### S3 — Run 状态机 + ws_close 改 detach（B-?, I-12）
- `index.ts:688 ws.on("close")`：受门控的 run 改发 `ws_close` 事件→`detached_running`（**删 `h.abort.abort()`**）；未门控 run 维持现行 abort。
- 加状态机转移（§4 表）；`interrupt`(:475) → `client_interrupt`（唯一+ttl_expired 调 abort，I-12）；Stop replay 强制带 runId，无 runId 禁 abort-all（m-INTBLAST）。
- 验证：**dogfood #5**（ws_close 不产 abort / client_interrupt 产 abort / interrupting reattach 回 interrupting）+ **#6** I-12 grep（abort 仅状态机两处）。

### S4 — permission resolver 生命周期（B-PERMTIMER 安全承重墙）
- `packages/backend/src/routes/permission.ts`：加 `detachPermissionChannel(token,{waitingTtlMs})`（clear 已 armed 590s allow-timer + arm WAITING_DETACHED_TTL→`resolve("deny",reason)`）、`reattachPermissionChannel(token,send)`、`terminatePermissionChannel(token,"deny")`；timer 生杀**仅在此文件**（I-14）。
- `index.ts:688`：ws_close 调 `detachPermissionChannel`（**删现行同步 deny 闭包**，NF1）。
- 验证：**dogfood #2**（arm /ask→ws_close→advance >590s→assert decision≠"allow"；≤WAITING_DETACHED_TTL 后 deny+expire+timer cleared+无 zombie hook）+ **#6** I-14 grep。

### S5 — backend WS liveness（M-LIVENESS，half-open zombie）
- `index.ts`：新增 backend-owned WS ping/pong（**不复用** heartbeatRecordSpawn）；无 pong>`ATTACHED_LIVENESS_TTL`→`liveness_lost`→`detached_running`。
- 验证：**dogfood #5**（无 pong→ATTACHED_LIVENESS_TTL 内转 detached）。

### S6 — reattach_run dispatch + cwd allowlist + capability 门控（C1/C6）
- `index.ts` ws.on(message) 加 `reattach_run` 分支：先 `verifyAllowedPath(cwd)`（失败回 error，m-CWD）→ 查 run 态 → 回 `run_status` + 若 running 经 S2 原子绑新 sink。
- env `VESSEL_RUN_SURVIVES_DISCONNECT` 读取 + `RegisteredRun.capabilityReattach` 写入（来自 user_prompt.clientCapabilities）。
- 验证：**dogfood #7**（flag OFF/无 capability→ws_close 逐字节同现行）+ **#4** characterization（直连/后台完成/断线落 tool_use↔tool_result 三场景 ChatLine[] 一致）。

### S7 — iOS reattach 客户端行为（A1/A2）
- `BackendClient.swift`：`clearStuckRunsAfterReconnect` 改为发 `reattach_run`（替换无条件 force-clear）；按 `run_status.status` 分支（running→等重路由+transcript catch-up；interrupting→保持等 session_ended；completed→transcript reconcile；unknown→现兜底）；`interrupt()` WS-down 分支入 `pendingInterruptRunIds` reconnect 带 runId 真 abort；声明 `clientCapabilities.reattach=true`。
- 验证：**dogfood #4** + 模拟器 e2e（ios-sim-e2e skill）。

### S8 — Phase C 选择 UI 补全（A2/C，纯 additive iOS UI）
- `Views/PermissionSheet.swift`：加"拒绝并指示 Claude 改做什么"（自由文本 deny）；后端 `permission_reply` 扩 deny+message（注意 PreToolUse hook 协议 OQ-E，实施期核 permission-hook.mjs stdout）。
- 新增 `vessel_workflow_paused` 选项渲染 sheet（**消费已广播的** workflow 消息，不经 reattach wire——承载层独立确认项已定）。
- 验证：构造 paused workflow→iOS 渲染推进；deny+指示→Claude 收指示文本。

## 3. 顺序与并行性

```
S1(协议) ──┬─ S2(sink) ── S3(状态机) ──┬─ S6(dispatch+门控) ── S7(iOS reattach) ── S8(选择UI)
           ├─ S4(permission lifecycle) ┘
           └─ S5(liveness) ────────────┘
```
S1 必首。S2/S4/S5 可并行（不同文件域：run-registry / permission.ts / liveness）。S6 汇聚。S7 依赖 S6。S8 可与 S7 并行（纯 UI，不依赖 wire 重路由）。

## 4. PR 结构（per HARNESS_PR_GUIDE）

建议拆 2 个 PR（降 review 面、隔离风险）：
- **PR-A**：S1-S6（backend + 协议，门控默认 OFF→零行为变更可安全合）。PR body 含 what/why/risk/rollback(env flip) + 链回 ADR-023 + 5 review 文件。
- **PR-B**：S7-S8（iOS reattach + 选择 UI）+ 翻 flag ON 的灰度说明。依赖 PR-A 合入。
全程跑 contract §11 dogfood 7 项 = merge 硬门禁；I-12/13/14 静态检查入 CI。

## 5. 阻塞项（实施前必须由用户定）

1. **分支策略**（git 现状：`docs/ios-disconnect-run-survival` 混入了并行 worker 的 `20527cb feat(steward)`）：实施代码落在 (a) 当前混合分支 / (b) cherry-pick 我的 docs commit 到干净 `feat/eva-ios-reattach` 新分支再在其上实施 / (c) 你协调那个 worker 后再定。**代码 PR 前必须定**，否则 PR diff 会混入 feat(steward)。
2. patch mode 是大工程（8 切片 + 2 PR + 7 dogfood gate）—— 确认现在就开 plan→code，还是 contract 先沉淀、择期实施。

## 6. Open Questions（实施期解决，contract §10 + 本阶段新增）

- 继承 contract OQ-A/B/C/D。
- OQ-E（S8 新增）：`permission_reply` 扩 deny+message 是否触 PreToolUse hook stdout 协议（permission-hook.mjs 只写 allow/deny）？扩 payload 不得破 fail-open 语义——实施期先读 permission-hook.mjs 原文核。
