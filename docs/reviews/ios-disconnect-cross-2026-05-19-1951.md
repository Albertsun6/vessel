Backlog: 0 in_progress · 0 planned · 4 blocked

# Cross Review — IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL

**Reviewer**: vessel-cross-reviewer  
**Model**: GPT-5.5, Cursor plan mode  
**Date**: 2026-05-19 19:57  
**Files reviewed**:
- `docs/proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md`
- provided ground-truth excerpts from `packages/backend/src/index.ts`, `WebSocketClient.swift`, `BackendClient.swift`, `protocol.ts`, `PermissionSheet.swift`

---

## Summary

- Blockers: 2
- Majors: 4
- Minors: 3
- Lens 5 findings: 2
- 总体判断：必须先修

## Numeric Score

| Lens | Score (0..5) |
|---|---:|
| 正确性 | 3.2 |
| 跨端对齐 | 2.8 |
| Eva 改造 + Vessel 硬约束 | 4.0 |
| 安全 + 4 类硬触发 | 4.2 |
| 集体盲区检测 | 3.0 |

**Overall**：3.6（有 BLOCKER，上限 3.9）

## Findings

### B1 [BLOCKER] Phase A “零 wire 协议改动”不成立

**Where**: `docs/proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md §5 Phase A`, `§9 OQ4`, `packages/shared/src/protocol.ts ServerMessage`

**Lens**: 1, 2, 5

**Issue**: Phase A 要求 iOS 重连后判断 run 是“仍在跑 / 已完成 / 已失败 / 阻塞在 permission / 阻塞在 workflow_paused”，但提案同时声称“不引入新 ServerMessage 字段、零协议改动”。现有 ground truth 只显示服务端消息有 `permission_request`、`vessel_workflow_paused` 等事件流；没有可验证的 reattach/inspect/run-status client message 或 HTTP endpoint。

**Why this is a blocker**: 如果没有一个明确的重挂握手，iOS 只能“拉 transcript + 猜 busy 状态”。这能补回“已完成并落盘”的结果，但不能可靠处理仍在 streaming、仍在跑但尚未落完整 jsonl、已被回收、阻塞在 permission、阻塞在 workflow pause 的状态。Phase A 的核心承诺是“后台长回合存活”，而不是“回来后尽量 refetch”。当前方案在最难的 live rebind 上没有接口契约。

**Suggested fix**: 把 Phase A 改成“最小协议增量”，不要强行说零协议改动。至少定义一个 reattach/inspect 契约，例如：
- client 重连后发送 `{ type: "reattach_run", runId, conversationId, sessionId, cwd }`
- backend 返回明确状态：`running | completed | failed | aborted | expired | waiting_permission | waiting_workflow_choice`
- 若 `completed`，iOS 走 transcript 全量回放
- 若 `running`，backend 把该 run 的后续消息重新绑定到新 WS
- 若 `waiting_*`，backend 重投 pending request
- 若 `expired/failed`，iOS 才 force-clear

### B2 [BLOCKER] “复用 8min watchdog”不是服务端资源上界

**Where**: `docs/proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md §5 Phase A`, `§6 I-1`, ground truth `BackendClient.swift:562-585`

**Lens**: 1, 4

**Issue**: 提案建议 detached run “超过现有 8min watchdog 阈值且无客户端才回收”，但 ground truth 里的 8min watchdog 是 iOS `BackendClient.tickWatchdog()`，不是 backend orphan-run watchdog。app 进入后台/挂起后，这个 watchdog 本身未必运行；WS 断开后它也不能约束服务端 CLI 子进程。

**Why this is a blocker**: Phase A 要把 run 生命周期从 WS 连接中解耦，资源安全必须转移到服务端。若仍把客户端 watchdog 当成边界，detached CLI 可能在无客户端、无路由、等待 permission、或 stdout 卡住时无限占用资源。个人单机工具也不能接受无界 orphan process。

**Suggested fix**: Phase A 必须新增 backend-owned orphan manager，且写清楚：
- detachedAt、lastActivityAt、sessionId、cwd、runId、pendingPermission/pendingWorkflow 状态
- hard TTL，例如 `max(detachedAt + 8min, lastActivityAt + N)` 或更简单的 detached 8min
- permission/workflow pending 的更短 TTL 或 fail strategy
- cleanup 必须调用同一套 abort + unregisterPermission + map cleanup
- telemetry 记录 `run.detached`, `run.reattached`, `run.orphan_aborted`, `run.completed_detached`

### M1 [MAJOR] OQ1 仍是问题，不只是 open question

**Where**: `docs/proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md §9 OQ1`, ground truth `index.ts:688-704`

**Lens**: 1, 3

**Issue**: 提案指出 `interrupt` 和 `ws.close` 当前复用同一个 `abort.abort()`，但 Phase A 没有给出新的状态机。只说“interrupt 消息 vs ws.close 必须语义分离”还不够。

**Why this matters**: 改成 ws.close 不 abort 后，所有“连接消失”都会变成 detached，包括浏览器关页、iOS app 被杀、用户退出页面、网络断开。显式停止仍可通过 `interrupt` abort，但“用户关闭客户端是否等价于放后台等待完成”这个产品语义没有定义。否则 backend 会保留用户其实不想要的 run。

**Suggested fix**: 在 Phase A 前补状态机：
- `attached_running`
- `detached_running`
- `interrupting`
- `completed_detached`
- `expired`
并定义事件：`client_interrupt`、`ws_close`、`reattach`、`ttl_expired`、`process_exit`。明确只有 `client_interrupt` 进入 abort，`ws_close` 只 detach。

### M2 [MAJOR] Phase A 依赖 jsonl 完成态回放，但没有验证落盘完整性

**Where**: `docs/proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md §4`, `§5 Phase A`, `§9 OQ2`

**Lens**: 1

**Issue**: 提案把 `~/.claude/projects/.../*.jsonl` 当作 durable log，这是合理方向，但没有确认 cli-runner 与 Claude CLI 的落盘时机：断线期间的 assistant final、tool result、error、session end 是否都能在 iOS 拉 transcript 时完整出现。

**Why this matters**: 如果 jsonl 写入是 CLI 内部异步完成，或者某些 stream-json event 不进入 saved transcript，iOS “全量回放”可能补不回与直连一致的 UI 状态。尤其 `session_ended` 不是 jsonl 用户内容，busy 清理需要额外判定。

**Suggested fix**: Phase A 加一个 characterization test：同一长 prompt 在直连和后台断连场景下，对比 transcript 解析后的 `ChatLine[]` 数量、最后 assistant 内容、sessionId、busy 清理结果。通过后再把 jsonl 定为 Phase A 的完成态 truth。

### M3 [MAJOR] pending permission/workflow 的重投机制没有后端存储设计

**Where**: `docs/proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md §6 I-4`, ground truth `routes/permission.ts PermissionDecision`, `protocol.ts vessel_workflow_paused`

**Lens**: 1, 2

**Issue**: 提案正确指出重挂必须重投 pending 选择，但没有说明 pending request 在 WS close 后存在哪里。现有 ground truth 显示 close 时会 `h.unregisterPermission()`，而 Phase A 如果不 unregister，就必须保证 pending registry 不再绑定旧 connection。

**Why this matters**: 断线时如果 run 卡在 PreToolUse permission，旧连接已死。若 pending 仍绑定旧 `send`，新 iOS 不会看到 sheet；若 timeout fail-open，可能在用户没同意时自动 allow；若 unregister，run 可能永远等不到决策。

**Suggested fix**: Phase A 明确 pending registry 从 connection-owned 改为 run-owned，reattach 时把 pending request replay 给新 connection。并定义 close 时是否保留 permission、保留多久、timeout 后是否沿用现有 fail-open。

### M4 [MAJOR] Phase C 被称为 A/B 价值前置 gate，但又可并行，优先级表述冲突

**Where**: `docs/proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md §5 Phase C`, `§6 I-4`

**Lens**: 2, 5

**Issue**: 文档一边说 Phase C 是 A/B 价值前置 gate，一边说“可与 A 并行”。这会让实施者不清楚 Phase A 是否可以单独 ship。

**Why this matters**: 对普通长回合，Phase A 很可能独立有价值；对会触发 permission/workflow pause 的 run，Phase A 不处理 Phase C 会恢复后继续卡死。两类场景应该拆清楚，否则 scope 会被错误放大。

**Suggested fix**: 改成：
- Phase A1：后台长回合完成态恢复，不覆盖 paused-on-choice
- Phase A2/C：pending permission/workflow re-surface
- 验收分别写清楚，避免把选择 UI 当成所有 Phase A 的硬前置。

### m1 [MINOR] 诊断链条总体可信，但“100% 排除网络抖动”措辞过强

**Where**: `docs/proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md §0`

**Lens**: 1

**Issue**: telemetry 显示所有失败都发生在 `app.background` 后，且前台无 `ws.receive.failed`，这足以支持主因判断。但“排除网络抖动 / Tailscale / 后端崩溃”写成绝对排除，证据略过强。

**Suggested fix**: 改成“在该样本中未见前台网络失败，主因高度确定为 iOS 后台挂起导致 WS 断开；网络抖动不是本次样本的解释”。

### m2 [MINOR] Phase B 可能过早引入 seq-buffer 叙事

**Where**: `docs/proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md §1`, `§5 Phase B`

**Lens**: 5

**Issue**: 对个人单机工具，最小可用目标是“回来能看到完整答案”。seq-buffer 适合无缝 live token 恢复，但不是当前痛点的必要条件。提案虽然把 B 延后，但行业架构章节给了它较大篇幅，容易让后续实现过度设计。

**Suggested fix**: 明确 Phase B 是“只有用户明确要求中途 token 无缝续播才做”，并把 Phase A 的验收锁定在 transcript reconciliation，不把 buffer 作为默认路线。

### m3 [MINOR] 安全章节没有点出“detached run 继续执行工具”的用户意图风险

**Where**: `docs/proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md §6 I-1`, `§6 I-4`

**Lens**: 4

**Issue**: 后台继续跑 Claude CLI 意味着 app 已断线时 tool calls 仍可能继续。现有 permission fail-open timeout 如果保留，断线期间可能自动 allow。

**Suggested fix**: 在 Phase A 安全护栏里加一条：detached 状态下遇到新的 permission request，默认应暂停等待 reattach，不能因为客户端不在线而扩大 fail-open 行为；如沿用 fail-open，必须明确记录风险和 telemetry。

## False-Positive Watch

- F? `B1` 可能已有未贴出的 client message 或 HTTP endpoint 可查询 run 状态；但 ground truth 和 proposal 没有给出。author 若能指出现有接口，B1 可降为 MAJOR。
- F? `M2` 取决于 Claude CLI jsonl 是否确实完整持久化所有 assistant 输出。proposal 把它作为事实使用，但当前材料只证明 jsonl 存在和 iOS 能解析历史 transcript，未证明断线完成态等价于直连 UI。
- F? `M3` 取决于 `permission` registry 的实现细节。ground truth 只说明 close 时当前会 unregister；若 Phase A 计划同步重构 registry，则 finding 应并入 B1 的 reattach contract。

## What I Did Not Look At

- 未读取完整 `packages/backend/src/index.ts`、`cli-runner.ts`、`routes/permission.ts`，只基于你提供的 ground-truth excerpt 做 fact-check。
- 未运行 `pnpm audit`，所以 CVE/license 只做 proposal 静态层面判断。
- 未验证 Apple / Socket.IO / RingCentral 外部链接原文，只评审 proposal 对这些资料的使用是否和 Vessel 设计相容。
- 未检查完整 iOS UI 代码，只使用你给出的 `PermissionSheet.swift` 与 `vessel_workflow_paused` grep 结论。
