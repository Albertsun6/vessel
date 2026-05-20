# Phase 3 Arbitration — IOS_DISCONNECT_REATTACH_CONTRACT

> Author: claude (opus-4-7) · Date: 2026-05-19 · Mode: contract
> Inputs: [p1-arch](contract-reattach-arch-2026-05-19-2114.md) · [p1-cross GPT-5.5](contract-reattach-cross-2026-05-19-2114.md) · [p2-react-arch](contract-reattach-react-arch-2026-05-19-2114.md) · [p2-react-cross](contract-reattach-react-cross-2026-05-19-2114.md)

## Convergence summary

Phase 2 produced **very strong bilateral convergence**. react-arch honestly self-upgraded F3 MAJOR→BLOCKER and **added F8 (= cross B2)** acknowledging a collective blindspot its arch lens under-weighted (saw the closure capture in F1-F5 but scoped it as a narrow race, not the contract's central inert mechanism). react-cross收下 arch F1/F2/F7（自己 Phase 1 漏项），并把自己 M5 从"范围偏大"升级为**结构性** finding。Net BLOCKERs: 2 → **4**, all bilateral with agreed fixes. No genuine technical disagreement remains; 1 user-confirm (touches proposal §8 lock).

## Judgment matrix

| # | Finding (源) | 双向状态 | 裁决 | v0.2 动作 |
|---|---|---|---|---|
| B-ADR | ADR-025 不存在；ledger 在 docs/adr/README.md 预留 021(Steward)/023 (arch F1 / cross NF1) | agree | ✅ 接受 | 全文 ADR-025→**ADR-023**（不占 Steward 021）；§0 注明编号源=`docs/adr/README.md` ledger 非 `ls vessel/` |
| B-WORKFLOW | `waiting_workflow_choice` 结构不可路由——workflow 是 `workflowId` + `broadcastToAll` 子系统（executor.ts:153-168 / index.ts:367-385），零 runId/runs/run-registry 耦合 (arch F2 / cross M5→结构性 / NF2) | agree（结构论 > budget 论，cross FP-watch 已溶解） | ✅ 接受 | `waiting_workflow_choice` **移出本 wire 契约**；status enum 去掉它。Phase C 工作流暂停**意图保留**=纯 additive iOS UI 渲染已广播的 `vessel_workflow_paused`（workflow 已靠 broadcast+/resume 服务端存活，唯一缺口=iOS 无渲染器），列为紧邻 sibling UI 项，不需 wire lock。reattach_run 范围=cli-runner runs only。**触 §8 用户锁→1 条用户确认**（意图不减，仅承载层从 wire 移到 UI） |
| B-PERMTIMER | 已 armed 的 590s fail-open `resolve("allow")` 在 detach 后仍触发=安全承重墙；且移除同步 deny 后 hook fetch 会 zombie (cross B1 + arch F3升级 + cross M4 合并) | agree（BLOCKER；arch 从 MAJOR 收敛） | ✅ 接受 | C5 重写为 **permission resolver 生命周期子契约**，单一 owner=`permission.ts`。新 API：`detachPermissionChannel(token,{waitingTtlMs})`=清已 armed allow-timer + 改 armed detached-expire timer；`reattachPermissionChannel(token,send)`=重绑+恢复 attached 计时；`terminatePermissionChannel(token,"deny")`=终结所有 pending。`run-registry` 只发事件**绝不碰 timer**。`WAITING_DETACHED_TTL` 到期=expire run + **`resolve("deny", reason="run expired while detached")`** + clear timer（**永不 allow、永不无限挂起**→无 zombie hook）。3 个终态转移，无第 4 种 |
| B-SINK | `RegisteredRun` 无可重绑 output sink——onMessage/onClearRunMessages/session_ended/error **闭包捕获** per-connection `send`（index.ts:438/558-566/586-604）；reattach→running 结构空心 (cross B2 / arch F8新增) | agree（**最高严重度**，跨两 Phase 1） | ✅ 接受 | C4 新增 run-owned sink：`attachedSend?`/`attachConnectionId?`/`attachGeneration` 进 `RegisteredRun`；**所有** emission（sdk_message/clear/session_ended/error/permission_request）只经 `registry.get(runId)?.attachedSend` 发，不再闭包捕获连接 send；reattach=**原子换 sink + generation fence**（旧 sink 写入按 generation 丢弃，subsumes process_exit-during-reattach 竞态 m1/F5p1）；detach 窗口产出**不内存 buffer**（无界风险）→ reattach→running 时经 transcript catch-up 补回 |
| M-INTERRUPTING | interrupting→reattach 过早合成 aborted（cli-runner SIGTERM 后 5s SIGKILL 窗口内进程可能仍出消息/正常完成）→全新 fleet 自相矛盾 (arch F5p2 / cross M2) | agree | ✅ 接受 | status enum **加 `interrupting`**；`interrupting` 态 reattach 回 `interrupting`，由真实 `session_ended` 驱动终态，**绝不**在 SIGTERM 5s grace 内合成 aborted；registry 抑制 abort 后续输出 + terminal cleanup 幂等 |
| M-LIVENESS | attached-but-zombie（TCP half-open / iOS 挂起静默死）无 TTL=新无界态旧码没有 (arch F4 / cross M3) | agree（cross 纠正：`heartbeatRecordSpawn` index.ts:571 是 run-spawn 健康统计，**非 WS 心跳**，无可复用 probe） | ✅ 接受 | C4 加 **backend-owned WS liveness**（新增 WS ping/pong 或 app-level heartbeat，**不**伪复用 heartbeatRecordSpawn）；`attached_running` 改"liveness 有效则不计 detached TTL"，超 `ATTACHED_LIVENESS_TTL` 无 pong→`detached_running`→走 orphan TTL；iOS 8min watchdog 新语义下须发 HTTP/pending interrupt 非仅本地清 |
| M-SWIFT | C2 Swift 仅"加 decode case"不够——`ServerMessage.runId`/`typeName`/`BackendClient.handle` 路由入口也须改否则 decode 成功仍被 drop (cross M1) | agree（arch 核实 Protocol.swift switch self 穷举=加 case 是编译错非静默 drop，更安全，但仍须做） | ✅ 接受 | §8 三端表补 Swift 4 触点：`ServerMessage.case runStatus` + `decode` + `runId` accessor + `typeName` + `BackendClient.handle` status 分发 |
| m-REGISTRY | "旧调用不破" 与必填新字段自相矛盾（run-registry 是 internal API 无外部消费者） (arch F6 / cross F6) | agree | ⚠️ 部分接受 | 删 §1/§5 "新增字段全可选/旧调用不破" 话术；明写 index.ts:569-570 call-site **被改**传初始 `state=attached_running`/`lastActivityAt`/`capabilityReattach`（internal-only，无 wire 影响，非兼容破坏） |
| m-CWD | reattach_run.cwd 须 `verifyAllowedPath` 后才用于 transcript fallback（user_prompt 在 index.ts:537-542 已做） (cross m2) | agree | ✅ 接受 | C1 backend 语义加：reattach_run.cwd 必过 `verifyAllowedPath`，失败回 `error`/`run_status:unknown`，不得用于 fallback |
| m-INTBLAST | reconnect Stop replay 丢 runId 会走 index.ts:475-480 abort-all，survive 后 sibling 更多→ blast radius 比现行大 (arch F7 / cross NF3) | agree | ✅ 接受 | C3 硬规定 reattach/HTTP Stop replay **必带具体 runId**；禁无-runId→abort-all 用于 reconnect Stop；runId 未知（pre-systemInit 不变量#8）→仅本地 force-clear 不发服务端 abort |

🚫 反驳：无。
🟡 用户决定：1 条（见下）。其余皆 author-resolvable 技术正确性修复。

## 🟡 待用户确认（1 条，触 proposal §8 锁定）

**workflow 暂停的承载层**：评审结构性证明 `waiting_workflow_choice` 不能进 runId-keyed reattach wire（workflow 是 workflowId 广播子系统）。裁决=从**本 wire 契约移出**，但你 §8 锁定的"Phase C 并入"**意图不减**——workflow 暂停在 iOS 的渲染缺口（你点名的"选择页面有些没有"）仍 100% 交付，做法是纯 additive iOS UI 渲染**已经在广播的** `vessel_workflow_paused`（workflow 本就靠 broadcast+/resume 服务端存活，不需要 reattach 续命）。即：permission 暂停走 reattach wire；workflow 暂停走 UI 渲染。两者都在本次范围内，只是技术承载不同。**请确认**这个"同一范围、拆两条技术路径"的处理（默认按此推进）。

## 收敛判断

v0.2 应用全部 ✅+⚠️ 后：4 BLOCKER 经评审**自带的代码级修法**消解（非作者臆造）；引入的两个新机制（rebindable sink、permission resolver 3-API 生命周期）由评审双方逐字段指定。无 reviewer "未被说服"，无新 BLOCKER。剩 1 条用户确认（§8 承载层，意图不减）。→ **收敛**。

**诚实标注**（非"装收敛"）：v0.2 含两个**新的代码级契约**（C4 sink rebind、C5 permission lifecycle），它们由评审指定但本身未单独过一轮 phase-1。按 contract mode 设计，这正是 §11 **dogfood gate 在 patch 阶段强制验证**的对象（契约形状测试 + 安全单测 `ask→detach→advance 590s→assert≠allow` + I-12 静态检查）。这是 contract→patch 的正确交接，不是评审缺口。
