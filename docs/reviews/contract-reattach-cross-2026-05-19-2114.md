Backlog: 0 in_progress · 0 planned · 4 blocked

# Cross Review — IOS_DISCONNECT_REATTACH_CONTRACT

**Reviewer**: vessel-cross-reviewer  
**Model**: GPT-5.5（当前 Cursor 会话；未写入 review 文件）  
**Date**: 2026-05-19 21:15  
**Files reviewed**:
- `docs/contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md`
- `packages/shared/src/protocol.ts`
- `packages/ios-native/Sources/ClaudeWeb/Protocol.swift`
- `packages/backend/src/index.ts`
- `packages/backend/src/run-registry.ts`
- `packages/backend/src/routes/permission.ts`
- `packages/backend/src/cli-runner.ts`
- `packages/backend/scripts/permission-hook.mjs`
- `packages/ios-native/Sources/ClaudeWeb/BackendClient.swift`

---

## Summary

- Blockers: 2
- Majors: 5
- Minors: 2
- Lens 5 findings: 1
- 总体判断：必须先修

## Numeric Score

| Lens | Score (0..5) |
|---|---|
| 正确性 | 2.4 |
| 跨端对齐 | 3.1 |
| Eva 改造 + Vessel 硬约束 | 3.6 |
| 安全 + 4 类硬触发 | 2.2 |
| 集体盲区检测 | 3.0 |

**Overall**：2.9（有 BLOCKER，上限 3.9）

## Findings

### B1 [BLOCKER] detached 后已有 permission timer 仍会 590s fail-open allow

**Where**: `docs/contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md §6 C5`; `packages/backend/src/routes/permission.ts:71-78`  
**Lens**: 4  
**Issue**: C5 只说 detached + 新 permission 不 fail-open，但没有处理“permission 已经 `/ask` 并 armed 590s allow timer 后，客户端才断线”的情况。现有 resolver 的 timer 在创建时就固定为 `resolve("allow")`。  
**Why this is a blocker**: 这是契约的安全承重墙。用户离开后，工具 approval 仍可能在 590s 自动 allow，正好违反 I-9 “无客户端时禁止扩大 fail-open”。这不是实现细节，而是 wire/runtime contract 必须锁住的行为。  
**Suggested fix**: C5 明确 permission resolver 需要状态化：pending resolver 必须知道 `attached/detached`；进入 detach 时取消原 590s allow timer，替换成 `WAITING_DETACHED_TTL` 到期后 `expire run + resolve deny/abort-safe terminal decision`。重新 attached 时再恢复“attached 590s fail-open”或重新开始用户决策 timer。并把这个作为 dogfood gate 的单测：`ask -> detach -> advance 590s` 不得 allow。

### B2 [BLOCKER] reattach 后 sdk_message 重路由缺少真实运行时承载点

**Where**: `docs/contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md §3 C2 running`; `§5 C4 RegisteredRun`; `packages/backend/src/index.ts:586-594`  
**Lens**: 1, 2  
**Issue**: 契约说 `running = backend 已把后续 sdk_message 重路由到本连接`，但 C4 的 `RegisteredRun` 只扩了状态、pending、terminal，没有保存可重绑的 output sink。当前 `runSession.onMessage` 闭包直接捕获旧连接的 `send`，断线后继续发旧 WS，消息会被丢。  
**Why this is a blocker**: `reattach_run` 即使返回 `running`，后续 token/tool/result 仍可能进旧闭包，不会到新连接。这样 contract 表面 additive，实际核心能力不成立。  
**Suggested fix**: C4 必须把 run 的输出通道建模进去，例如 `attachedSend?: (ServerMessage)=>void`、`attachedConnectionId`、`attachGeneration`，所有 `onMessage/onClearRunMessages/session_ended/permission_request` 都通过 registry 当前 sink 发送，而不是闭包捕获 per-connection `send`。reattach 要原子替换 sink，并处理旧 sink 的 generation 丢弃。

### M1 [MAJOR] Swift 端“新增 decode 分支”不够，`runId` 路由入口也必须更新

**Where**: `docs/contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md §3 C2 Swift`; `packages/ios-native/Sources/ClaudeWeb/Protocol.swift:87-100`; `BackendClient.swift:471-478`  
**Lens**: 2  
**Issue**: 当前 iOS 所有 run-bound message 先走 `msg.runId`。如果只新增 `case runStatus` + decode，而忘了在 `var runId` 和 `typeName` 加分支，`run_status` 会被当成 no-runid 或 orphan drop。  
**Why this matters**: 合同把 `run_status` 作为 reattach 应答，但当前架构里“解码成功”不等于“会被处理”。  
**Suggested fix**: C2 Swift 契约明确列出四处必改：`ServerMessage.case runStatus`、`decode`、`runId` accessor、`typeName`，以及 `BackendClient.handle` 中在 routing 后处理各 status。

### M2 [MAJOR] `interrupting -> reattach -> status=aborted` 过早下终态

**Where**: `docs/contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md §4 C3`; `packages/backend/src/cli-runner.ts:227-250`  
**Lens**: 1  
**Issue**: cli-runner abort 是 SIGTERM 后 5s SIGKILL，进程可能还没 close。契约把 `interrupting` reattach 直接回 `aborted`，会让 iOS 释放路由并写终态，但 backend 仍可能随后发 `error/session_ended` 或残余 stdout。  
**Why this matters**: 会产生 UI 终态和 backend 真实进程状态不一致，尤其是 Stop 后马上 reconnect。  
**Suggested fix**: C2/C3 增加 `status: "interrupting"`，或规定 `interrupting` reattach 返回 `aborted` 但必须保证 registry suppress 后续所有 output 且 terminal cleanup 幂等。更稳的是显式 `interrupting`，直到 process close 再发 `aborted`.

### M3 [MAJOR] half-open / zombie attached 连接没有上界

**Where**: `docs/contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md §5 C4`; `packages/ios-native/Sources/ClaudeWeb/BackendClient.swift:598-619`  
**Lens**: 1  
**Issue**: C4 写 `attached_running 不计 TTL`，但没有定义 WS heartbeat / ping-pong / half-open 检测。移动网络里 TCP 不一定及时 FIN；server 可能认为 attached，iOS 已后台冻结，客户端 8 分钟 watchdog 又只清本地，不一定能真正 interrupt backend。  
**Why this matters**: survive-disconnect 本来是为移动断线设计，如果 close 事件不可靠，attached 永不 TTL 会留下无界长跑。  
**Suggested fix**: 契约加 backend-owned liveness：WS ping/pong 或 last outbound ack/heartbeat，超过阈值转 `detached_running`。同时定义 iOS 8min watchdog 在新语义下必须发 HTTP interrupt 或 pending interrupt，而不是只本地清。

### M4 [MAJOR] permission detach/terminate 拆分没有说明 hook HTTP 如何收尾

**Where**: `docs/contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md §6 C5`; `packages/backend/scripts/permission-hook.mjs:54-71`; `packages/backend/src/routes/permission.ts:16-19`  
**Lens**: 1, 4  
**Issue**: 现有 590s timeout 的注释明确是为了避免 hook HTTP 请求卡成 zombie。C5 移除 detach 时同步 deny 后，如果 run 长时间 detached，hook fetch 会一直挂到 reattach、120s TTL、或 590s timeout，但契约没有规定 TTL 到期时 resolver 必须如何 resolve。  
**Why this matters**: 如果只 abort CLI 不 resolve `/ask`，可能留下 hook fetch 和 backend pending；如果 resolve allow，又回到 B1。  
**Suggested fix**: C5 明确 terminal path：`WAITING_DETACHED_TTL` 到期时先 `expire run`，再对所有 pending resolver `resolve("deny")` 或返回明确 `decision:"deny", reason:"run expired while detached"`；不得 allow。并清 timer。

### M5 [MAJOR] Lens 5：合同表面积偏大，但实际最难点反而欠规格化

**Where**: `docs/contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md §3-§6`  
**Lens**: 5  
**Issue**: 合同定义了 8 个 `run_status`、3 个 TTL、workflow pending、terminal GC，但对真正困难的“旧连接闭包如何变成 run-owned mutable routing”和“permission resolver timer ownership”写得不够精确。  
**Why this matters**: 这会诱导实现先补 wire enum 和状态字段，看起来完整，但核心 race 仍留在闭包和 timer 里。  
**Suggested fix**: 收窄 v0.1：先锁最小闭环 `running/completed/failed/aborted/expired/unknown + permission pending`，把 `waiting_workflow_choice` 延后，腾出篇幅把 output sink rebinding、permission timer state machine、generation/atomicity 写成代码级契约。

### m1 [MINOR] `completed_detached` 清 record 的时机有竞态

**Where**: `docs/contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md §4 C3`  
**Lens**: 1  
**Issue**: 表格写 `reattach` 在 `completed_detached` 回 completed/failed + 清 record，但没有定义如果 `process_exit` 和 `reattach` 同时发生，谁负责发送 `session_ended`、谁清 terminal。  
**Suggested fix**: 规定 registry update 是单线程同步临界区：`process_exit` 只写 terminal；`reattach` 读 terminal 后发送 status 并标记 consumed；GC 后删除。避免双发或漏发。

### m2 [MINOR] `reattach_run.cwd` 必须走 allowlist 校验

**Where**: `docs/contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md §2 C1`; `packages/backend/src/index.ts:535-541`  
**Lens**: 4  
**Issue**: `user_prompt.cwd` 当前有 `verifyAllowedPath`，但 C1 只说 cwd fallback 定位 transcript，没有明确 reattach 分支也必须校验。  
**Suggested fix**: C1 backend 语义加一句：`reattach_run.cwd` 必须先 `verifyAllowedPath`，失败返回 `error + run_status unknown/failed` 或直接 error，不得用于 transcript fallback。

## False-Positive Watch

- F? `waiting_workflow_choice` 可能是未来 Vessel workflow 需求，而不是本 iOS run survival 的必需项；如果 owner 已决定 Phase C 必须包含 workflow pause，那 M5 的“延后”只应作为 scope 建议，不应阻塞。
- F? old iOS “忽略未知 ServerMessage type”在当前 `Protocol.swift` 是成立的，因为 default 返回 `.unknown`；但如果还有更旧已发布 build 没有这个 fallback，需要另查发布版本源码。

## What I Did Not Look At

- 没有运行 `pnpm audit`，CVE/license 只做静态风险判断。
- 没有跑测试或模拟器；本轮是 contract Phase 1 静态评审。
- 没有读取其他 reviewer verdict，保持 Phase 1 独立性。
