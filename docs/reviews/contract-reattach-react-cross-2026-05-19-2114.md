Backlog: 0 in_progress · 0 planned · 4 blocked

# Phase 2 React — cross-correctness lens
> Reviewer: vessel-cross-reviewer · Date: 2026-05-19 · Phase 2 (cross-pollinate, contract mode)

## 对 arch verdict 的逐条表态

### F1 — agree
**对方原文**: “ADR numbering is wrong… Next is ADR-021, not ADR-025.”

**我的表态**: agree

**理由**: 我 Phase 1 漏掉了 ADR ledger。`docs/adr/README.md:39-45` 明确列出 ADR-019/020/022/024，并声明 `ADR-021` 空闲且预留、`ADR-023` 空闲。contract 只按目录末尾推 `ADR-025`，事实依据不够。

**新建议**: contract 应改为“ADR 编号来源以 `docs/adr/README.md` 为准”，具体 slot 由 owner 选 `ADR-021` 或 `ADR-023`；我倾向 `ADR-023`，避免打断 Steward 021 预留。

### F2 — agree
**对方原文**: “`waiting_workflow_choice` is unroutable: workflow engine is a separate runId-less subsystem.”

**我的表态**: agree

**理由**: arch 的结构性证据解决了我 Phase 1 的 FP caveat。`workflow/executor.ts:153-168` 在 HITL step 里广播 `vessel_workflow_paused`，字段是 `workflowId/step/message/options`，没有 `runId`。`index.ts:367-385` 把 workflow router 注入 `broadcastToAll`，不是 per-run sink，也不进入 `runs`/`run-registry`。因此 `reattach_run { runId }` 物理上不能查到 workflow pause。

**新建议**: `waiting_workflow_choice` 必须从本 wire contract 移出。Phase C 可以保留为“iOS 渲染已有 `vessel_workflow_paused` 广播”的 sibling UI work，不应挂在 runId reattach contract 上。

### F3 — refine
**对方原文**: “already-armed 590s `resolve("allow")` timer is owned by the closure…”

**我的表态**: refine

**理由**: 同意问题，但我维持 BLOCKER，不只是 MAJOR。`permission.ts:71-79` 的 timer callback 无条件 `resolve("allow")`，这直接违反 contract I-9 “无客户端时禁止扩大 fail-open”。这是安全承重行为，不修不能锁 wire/runtime contract。

**新建议**: timer 单一 owner 应是 `permission.ts`，不要让 `run-registry` 直接碰 timer。定义 API：`detachPermissionChannel(token, { waitingTtlMs })` 清掉已 armed fail-open timer 并改为 detached-expire timer；`reattachPermissionChannel(token, send)` 重绑 send 并恢复 attached 决策计时；`terminatePermissionChannel(token, "deny")` 终结所有 pending。`run-registry` 只发状态事件，不拥有 resolver/timer。

### F4 — refine
**对方原文**: “attached-but-zombie client has no TTL.”

**我的表态**: refine

**理由**: 与我的 M3 收敛，但我不同意“piggyback existing heartbeat”这个默认方向。`index.ts:58-62` 的 heartbeat import 是后端运行健康统计，`index.ts:571` 的 `heartbeatRecordSpawn()` 是 run spawn 记录，不是 WS ping/pong。当前 backend 没看到可复用的 WS liveness probe。

**新建议**: contract 应明确新增 WS-level ping/pong 或 app-level heartbeat。`attached_running` 不是“不计 TTL”，而是“只要连接 liveness 有效就不计 detached TTL”；超过 `ATTACHED_LIVENESS_TTL` 先转 `detached_running`，再走现有 orphan TTL。

### F5 — refine
**对方原文**: “process_exit during reattach, and abort SIGTERM-5s window vs reattach→status=aborted.”

**我的表态**: refine

**理由**: 同意 race，但 arch 仍低估了我 B2 的输出 sink 问题。`index.ts:586-594` 的 `onMessage/onClearRunMessages` 捕获的是旧连接 `send`；`index.ts:596-604` 的 terminal/error 也捕获同一个 send。没有 run-owned mutable sink，`C2 running = 已重路由` 是空话。这不是单个 race 的 MAJOR，而是 reattach 核心能力不成立，所以我保持 B2=BLOCKER。

**新建议**: C4 必须先定义 run-owned sink：`attach(runId, send, generation)` 原子替换输出通道；所有 `sdk_message/clear/session_ended/error/permission_request` 都只能经 registry 当前 sink 发。再处理 `attaching` transient 和 `interrupting` status，避免 SIGTERM 5s 内提前合成 aborted。

### F6 — agree
**对方原文**: “`RegisteredRun` required fields contradict old call-site backward-safety claim.”

**我的表态**: agree

**理由**: `run-registry.ts:6-16` 当前 `register()` 接收完整 `RegisteredRun`。contract 新 interface 若把 `state/lastActivityAt/capabilityReattach` 写成 required，`index.ts:569-570` 的旧 call-site 必然要改；若写 optional，又会削弱 reaper invariant。

**新建议**: 不要声称“旧调用不破”。这是 internal API，直接规定 `index.ts` call-site 必须传初始 state：`attached_running`、`lastActivityAt`、`capabilityReattach`。wire 仍 additive，内部类型不需要假装兼容。

### F7 — agree
**对方原文**: “`interrupt` global-scan fallback may over-abort sibling runs.”

**我的表态**: agree

**理由**: 我 Phase 1 漏掉了这个 blast radius。`index.ts:475-480` 在 `interrupt` 无 `runId` 时 abort 当前连接所有 runs。survive-disconnect 后同一新连接上可能重挂多个旧 run；WS-down Stop replay 如果丢 runId，会比现行语义杀更多 sibling run，违反 per-conversation 隔离。

**新建议**: contract 应硬性规定 reattach/HTTP Stop replay 必须带具体 `runId`。如果 runId 缺失，禁止走 unscoped interrupt；只能本地 force-clear 或返回 explicit error。

## 我自己 Phase 1 verdict 的自我修正

- **B1 keep + strengthen**: 保持 BLOCKER。arch F3 证实 timer owner 是关键盲点；我补充具体 owner：`permission.ts` 管 timer，`run-registry` 只触发 detach/reattach/terminate。
- **B2 keep**: 保持 BLOCKER。wire additivity 为真，但 reattach 的 `running` 语义依赖 output sink rebinding；没有 sink，合同核心能力不存在。
- **M1 keep**: Swift `ServerMessage.runId`/`typeName`/`BackendClient.handle` 入口仍必须写进 contract，否则 `run_status` decode 成功也会被 route guard 丢弃。
- **M2 keep, refined**: 应新增 `interrupting` status，不能在 SIGTERM 5s grace 内合成 `aborted`。
- **M3 keep, refined**: half-open liveness 需要新 WS ping/pong 或 app heartbeat；`heartbeatRecordSpawn` 不是连接心跳。
- **M4 keep**: hook HTTP 收尾必须明确 deny/expired，不得 allow，也不得让 hook fetch zombie。
- **M5 upgrade**: 从“范围偏大”升级为结构性 finding：`waiting_workflow_choice` 应从 run reattach wire contract 移出。
- **m1 keep**: `completed_detached` terminal record consume/GC 仍需幂等规则。
- **m2 keep**: `reattach_run.cwd` 仍必须 `verifyAllowedPath` 后才能用于 transcript fallback。

## 新发现 (new-finding)

1. **NF1 [BLOCKER] ADR anchor 错误**: `ADR-025` 不是可锁定 slot；以 `docs/adr/README.md` ledger 选 `ADR-021/023`。
2. **NF2 [BLOCKER] workflow pause 不能塞进 run_status**: workflow 是 `workflowId` + broadcast subsystem，不是 runId registry subsystem。
3. **NF3 [MINOR/MAJOR] unscoped interrupt blast radius 扩大**: reconnect Stop replay 必须禁止无 runId abort-all fallback。

## 收敛信号小结

**准 accept / 双方已收敛**:
- 后端保活 + reattach + flag/capability 双门控方向正确。
- permission 590s fail-open timer 必须在 detach 时 disarm。
- attached zombie 必须有 liveness bound。
- abort SIGTERM grace 与 reattach 需要显式 `interrupting` 或等真实 terminal。
- Swift `run_status` 不只是 decode，还要进入 runId routing/handler。
- `waiting_workflow_choice` 不应作为 runId reattach wire 的一部分。

**需要 author arbitration**:
- ADR slot 选 `ADR-021` 还是 `ADR-023`。
- `waiting_workflow_choice` 是完全移出本 work，还是拆成独立 workflowId-keyed follow-up contract。
- B2 severity：我仍判 BLOCKER；arch 原 verdict把相关 race 判 MAJOR。我的理由是没有 run-owned sink 时 `running` 状态语义不成立。
