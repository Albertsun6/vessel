# iOS 后台断线 → 回合存活与重挂 — 调研报告 v0.2（收敛后）

> **Status**: proposal · **收敛** (phase 1+2+3 完整跑) · **Date**: 2026-05-19 · **Author**: claude (opus-4-7)
> **Review trail**: [phase1-arch](../reviews/ios-disconnect-arch-2026-05-19-1951.md) · [phase1-cross(GPT-5.5)](../reviews/ios-disconnect-cross-2026-05-19-1951.md) · [phase2-react-arch](../reviews/ios-disconnect-react-arch-2026-05-19-1951.md) · [phase2-react-cross](../reviews/ios-disconnect-react-cross-2026-05-19-1951.md) · [phase3-arbitration](../reviews/ios-disconnect-arbitration-2026-05-19.md)
> **收敛 verdict**: 12 ✅ 接受 · 2 ⚠️ 部分接受 · 0 🚫 反驳 · 3 🟡 用户决定（**已锁定 2026-05-19，见 §8**：范围=A1+A2/C，Phase C 并入，orphan TTL ~8-10min / waiting_* 更短）
> **下一步**: A1 引入 `reattach_run` wire 协议增量 → 进 **contract mode + ADR-lite** 锁契约后再 plan 实施（非绕过，收敛即触发）。
> **不可逆度**: 中 — Phase A1 引入 `reattach_run` wire 协议增量 → **实施前必须走 contract mode + ADR-lite 锁定该契约**（CLAUDE.md 阶梯层；本 proposal 收敛即触发此升级，非绕过）。Phase A2/C additive UI（低）；Phase B seq-buffer（高，按需才做）。
>
> **v0.1→v0.2 关键变更**：(1) Phase A 的"零协议改动"主张**撤回**——改为"最小协议增量：1 个 `reattach_run` 入站 + 1 个 run-status 回包"；(2) "复用 8min watchdog" 叙事**删除**——8min 是 iOS 端 `tickWatchdog`，backend 对 run 生命周期**零上界**，必加 backend-owned orphan manager；(3) Phase A 拆 **A1**(完成态恢复，独立可 ship) / **A2+C**(pending 重投 + 选择 UI)；(4) 加显式 run 状态机 + 不变量 I-8/I-9/I-10 + NF1 terminal record + NF2 capability 协商。

## 0. Context

**用户问题陈述**：iOS app 等待长回合时断线，会话 `AC35BE4A`（"Set up streaming translation and logging for summary mode"）每次丢答案。要求出诊断 + proposal 走完整评审；附带检查 iOS"选择页面"完整性。

**诊断结论（telemetry + 代码双证据，已确认）**：固定因果链，遥测样本内无一例外——

| # | 事件 | 机制 |
|---|---|---|
| 1 | `prompt.send` → `session.bound` | 回合开始，claude CLI 子进程在跑 |
| 2 | `app.background` | 用户锁屏/切走等长回合（正常行为） |
| 3 | `ws.receive.failed: "Software caused connection abort" (__NSCFError)` | **app 挂起 2–6min 后** iOS 拆掉 URLSession WebSocket |
| 4 | (backend) `ws.on("close")` → `for (h of runs) h.abort.abort()` | 后端**立即 SIGKILL 正在生成的子进程**，服务端工作销毁 |
| 5 | `app.foreground` → `ws.connect.ok` | 用户回来，WS 秒重连成功 |
| 6 | `stuck_run.reconnect_clearing` → `turn.interrupted` → `stuck_run.force_cleared` | iOS 标记中断，写"连接中断，操作已停止"，答案丢失 |

**证据强度（m1 收敛后措辞）**：该 telemetry 样本中所有失败均发生在 `app.background` 之后，且前台从未出现 `ws.receive.failed` —— 主因**高度确定**为 iOS 后台挂起导致 WS 断开；网络抖动 / Tailscale / 后端崩溃不是本样本的解释（非绝对排除一切场景，但本案因果链由代码路径独立佐证）。第 6 步是**正确善后**而非 bug；真 bug 在第 3、4 步设计假设。

**已验证代码定位**：
- backend [index.ts:688-704](../../packages/backend/src/index.ts#L688) — `ws.on("close")` 无条件 `h.abort.abort()` 杀全部 run；该 abort 与用户 `interrupt`（index.ts:475-481）**是同一个 `AbortController`，无信号区分**
- backend [run-registry.ts](../../packages/backend/src/run-registry.ts) 全文无任何 run TTL / 定时回收；`startedAt` 仅供 `/health` 显示 → **服务端对 run 生命周期零上界**
- backend [routes/permission.ts:21-39](../../packages/backend/src/routes/permission.ts) — permission registry **connection-owned**；close 时 `unregisterPermission()` 闭包**同步 `resolve("deny")` 所有 in-flight pending** 再 delete；timeout `PENDING_TIMEOUT_MS≈590s` → `resolve("allow")` fail-open
- backend [cli-runner.ts](../../packages/backend/src/cli-runner.ts) — **不写 jsonl**（transcript 由 `claude` 子进程自身写）；`session_ended` 是 Vessel 在 index.ts:596-597 由 `abort.signal.aborted ? "interrupted":"completed"` **合成**，仅活在 WS 流、**不落盘**
- iOS [WebSocketClient.swift:122](../../packages/ios-native/Sources/ClaudeWeb/Networking/WebSocketClient.swift#L122) `enterBackground()` — 赌"iOS 保活"，用 `URLSessionConfiguration.default`，无 `beginBackgroundTask`
- iOS [BackendClient.swift:564](../../packages/ios-native/Sources/ClaudeWeb/BackendClient.swift#L564) `clearStuckRunsAfterReconnect()` 重连即 force-clear；[:599](../../packages/ios-native/Sources/ClaudeWeb/BackendClient.swift#L599) `tickWatchdog()` 的 8min 阈值由 30s `Timer` 驱动、**纯 iOS 端**、app 挂起时不 fire

**附带任务（选择 UI）**：[PermissionSheet.swift](../../packages/ios-native/Sources/ClaudeWeb/Views/PermissionSheet.swift) 仅 允许/拒绝 + per-tool toggle，缺"拒绝并指示 Claude 改做什么"（CLI 第 4 项）；[protocol.ts:157](../../packages/shared/src/protocol.ts#L157) `vessel_workflow_paused{options}` 在 iOS **全仓无渲染** → paused 即静默卡死。→ Phase A2/C（与重挂有正确性耦合，I-4）。

## 1. 业界典型架构（从轻到重）

> 评审确认：本节是**防过度设计的护栏**（隔离 seq-buffer 进 Phase B 的依据，arch F5 实证），保留。

| 架构 | 代表 | 隔离层（run vs 连接） | 恢复层 | 后台续命 | 适合 |
|---|---|---|---|---|---|
| **连接=生命周期**（现状） | naive ws app | 无解耦，连接断=任务死 | 无 | 无 | demo / 短任务 |
| **客户端后台续命** | iOS `beginBackgroundTask` | 无解耦 | 无 | ~30s（Apple 硬上限） | 极短任务 / 系统弹窗过渡 |
| **reattach + 持久 log**（本提案 Phase A 落点） | tmux / mosh / VS Code Server / Jupyter kernel | 进程独立于连接，scrollback 持久 | 重连按 session id 重挂 + 从持久 log 回放 | 不依赖 | 重：长任务必须存活 |
| **seq+buffer 重连重放** | Socket.IO CSR / RingCentral | run 与连接解耦，per-conn 出站 buffer | 客户端带 `since`/`offset` 重连，服务端重放 | 不依赖 | Phase B：无缝 live token 流（按需） |
| **服务端持久 + push 唤醒** | APNs/PushKit + 服务端任务队列 | 任务服务端独立跑 | push 唤醒 app → 拉结果 | App-Store 友好的唯一"真后台" | 必须后台收结果（未来） |

**Vessel 现状落最轻档，但天然具备"持久 log + reattach"档关键资产**：claude CLI 已把真实 transcript 持久写到 `~/.claude/projects/<cwd>/<sessionId>.jsonl`，`--resume <sessionId>`（cli-runner 已支持）可重挂会话，iOS 已有 `SessionsAPI` + `TranscriptParser`。**但 transcript 是内容源、非 liveness/terminal oracle**（无终止标记，session_ended 不落盘）——所以 reattach 必须有"server 当 liveness oracle"的最小契约（§5）。

## 2. 共识规律（5 篇深读交叉验证）

1. **Apple 权威（DTS 716118）**：关键不是前台/后台，是 **running vs suspended**。`beginBackgroundTask` 只买 ~30s；**Background URLSession 显式不支持 WebSocket task**。→ "保活 socket"原理封顶 ~30s，扛不住分钟级长回合；唯一稳的修法是服务端 run 持久 + 重连重放（或 push）。
2. **重连重放是行业标准**（websocket.org/RingCentral/Socket.IO CSR 一致）：出站消息打单调 seq；重连带 `session+since`；服务端重放 seq>since 再转 live。
3. **服务端保留窗口收敛区间**：websocket.org 2-5min；RingCentral 180s；Socket.IO CSR 默认 120s。→ 消息 buffer 共识 2–5min。
4. **恢复"不总成功"是显式前提**（Socket.IO 原文）→ 必须有 fallback 全量 resync。
5. **任务必须与连接解耦**（三方一致）："decouple long-running job from the WS connection, track by session id"。

## 3. 失败模式清单

| 失败 | 出处 | 原因 | 缓解 |
|---|---|---|---|
| 后台 socket 死→后端杀回合 | **本项目 telemetry（实证）** | ws.close 当作"用户要中止" | 解耦 run 生命周期（§5 状态机，仅 client_interrupt→abort） |
| 重连无 state resync | **anthropics/claude-code #34868**（官方 remote 同类，closed not planned) | 服务端不跨断连维护 session | reattach 契约 + 持久 log 回放（A1） |
| 赌"iOS 保活连接" | Apple DTS 716118 反驳 | 误把 bg≠suspended | 不赌；服务端持久（I-6） |
| **detached run 服务端无上界 = 资源泄漏** | **本项目代码实证（run-registry 零 TTL）** | 8min watchdog 仅 iOS 端、挂起时不跑 | **backend-owned orphan manager + hard TTL**（B2 修复，A1 必做） |
| 恢复假设永远成功 | Socket.IO CSR 原文 | 无 fallback | 重挂失败回退全量 transcript（I-7） |
| transcript 无终止标记，分不清完成/在跑/被杀 | **本项目代码实证（cli-runner 不写 jsonl）** | session_ended 不落盘 | server(runs map+terminal record)=liveness oracle，transcript=内容源（M2，A1 必做） |
| close 同步 deny 污染 pending | **本项目代码实证（permission.ts:32-35）** | unregister 闭包 resolve("deny") | detach 前移除同步 deny（M3 前置，NF1） |
| detached + fail-open 无人值守自动放行 | **本项目代码实证（permission timeout→allow）** | 断线无人决策 | I-9：detached 遇新 permission 暂停等 reattach，不 fail-open |
| 重挂回 paused-on-choice 仍卡死 | 本项目代码（vessel_workflow_paused 无 iOS UI） | 选择 UI 不完整 | Phase A2/C |
| 旧 iOS force-clear 但 backend 续跑→UI↔transcript 语义分裂 | 评审 NF2 推演 | 无 capability 协商 | feature flag + client capability 双门控（NF2） |

## 4. 对接现有 harness 数据模型 / 代码

**✅ 已就绪可复用**：claude CLI 持久 jsonl（内容源）；`--resume <sessionId>`（cli-runner 已支持）；iOS `SessionsAPI` + `TranscriptParser`；`runIdToConversation` 路由表；`session.bound` 绑定。
**❌ 缺口（v0.2 修正后）**：
- 后端 `ws.on("close")` 无条件杀 run + 与 user-interrupt 共用 abort（A1 必改：状态机）
- **后端无 orphan manager / run TTL / terminal-state record**（A1 必加，B2/NF1）
- 后端 permission registry connection-owned + close 同步 deny（A2 必改，M3/NF1）
- 无 `reattach_run` 入站消息 + run-status 回包（A1 必加，B1，触发 ADR-lite）
- iOS 重连 force-clear，未尝试 reattach（A1 必改）
- iOS interrupt() WS-down 分支依赖"backend 已 abort"假设，A1 后变 bug（M1）
- iOS 无 `vessel_workflow_paused` 渲染 + PermissionSheet 缺"拒绝并指示"（A2/C）
- 无 client capability 协商 + feature flag（NF2）

## 5. 推荐方案：分阶段（A1 / A2+C / B），outcome-based 退出

> 排序原则：A1 是能独立 ship 的止血切片（覆盖"普通长回合完成态恢复"，**不覆盖** paused-on-choice）；A2+C 覆盖会暂停的 run；B 仅按需。

### 共同基座 — Run 状态机（A1 前必须先定义，解 M1/OQ1）
状态：`attached_running` · `detached_running` · `interrupting` · `completed_detached` · `expired`
事件：`client_interrupt`（**唯一**进 abort 的事件）· `ws_close`（仅 `attached_running`→`detached_running`，**不 abort**）· `reattach` · `ttl_expired`（→`expired`，触发 orphan abort）· `process_exit`（→ terminal record）
**不变量 I-8**：用户 Stop 必须真停。`client_interrupt` 永远真 abort；`ws_close` 只 detach。iOS `interrupt()` WS-down 分支不得只本地 force-clear——须在 reconnect/`reattach_run` 携带 `pendingInterruptRunIds`，或提供独立 HTTP interrupt endpoint。

### Phase A1 — 完成态/在跑态重挂（止血，可单独 ship；触发 ADR-lite 锁 reattach 契约）
**核心**：
1. 后端 `ws_close` 不再 abort（按状态机 detach）；新增 **backend-owned orphan manager**：每 detached run 记 `detachedAt/lastActivityAt/sessionId/cwd/runId/状态`，hard TTL 回收（§8.3 用户定值），cleanup 复用 `abort` + `unregisterRun`(index.ts:610) + `unregisterPermission` + map 清理；telemetry `run.detached`/`run.reattached`/`run.orphan_aborted`/`run.completed_detached`。
2. 进程退出后保留**短期 terminal-state record**（`completed|interrupted|error|expired` + endedAt + sessionId + cwd），即便 runs map 已清也能答复 reattach（NF1）。
3. **最小协议增量**（B1，D2 裁决）：1 个入站 `reattach_run { runId, conversationId, sessionId, cwd }` + 1 个 run-status 回包 enum：`running | completed | failed | aborted | expired | waiting_permission | waiting_workflow_choice`。`completed` 支**复用现有** `SessionsAPI.transcript`（无新 server→client 消息）；`running` 支 backend 重新路由后续 `sdk_message` 到新 WS。ADR-lite 锁定范围 = 仅 `reattach_run` 消息 + status enum。
4. iOS 重连：`clearStuckRunsAfterReconnect` 改为先发 `reattach_run`；按 status 分支（completed→transcript 全量回放清 busy；running→重绑路由；expired/failed→才 force-clear）。
5. **feature flag + capability 双门控**（NF2）：`VESSEL_RUN_SURVIVES_DISCONNECT` 默认 OFF；仅声明支持 reattach 的新 iOS 启用 survive-disconnect；旧客户端走 close-abort 或短 TTL detached（防 UI↔transcript 语义分裂）。rollback=env flip 无需 redeploy。
**不做**：不引入 seq/offset；不做 mid-stream 逐 token 续传（完成态按 transcript 全量回放即可）。
**退出条件（机器可验证）**：characterization test——同一长 prompt 在 (a) 直连 (b) 后台断连完成 (c) 断线落在 tool_use↔tool_result 之间（arch NF3）三场景，对比 `ChatLine[]` 数量 / 末 assistant 内容 / sessionId / busy 清理结果一致；telemetry 中 `stuck_run.force_cleared` 不再出现于"回合已完成"场景。

### Phase A2 + C — pending permission/workflow 重投 + 选择 UI（覆盖 paused-on-choice）
**核心**：
1. permission registry 改 **run-owned**（M3）；**前置**：移除 close 时同步 `resolve("deny")`（NF1，否则 detach 瞬间伪造 deny 污染执行轨迹）；reattach 时重投 pending request 给新连接；定义 close 时 permission 保留时长 / timeout 策略。
2. **不变量 I-9**：detached 态遇**新** permission request 默认**暂停等 reattach，不 fail-open allow**；若保留 fail-open 必须显式记风险 + telemetry。
3. **不变量 I-10**：detached 期间已 allow 工具继续执行须 `run.detached.tool_exec` telemetry + reattach 回放（CLAUDE.md 不可逆硬触发覆盖）。
4. iOS：PermissionSheet 加"拒绝并指示 Claude 改做什么"（自由文本 deny，对齐 CLI 第 4 项），后端 `PermissionDecision` 扩 deny+message；新增 `vessel_workflow_paused` 选项渲染 sheet；reattach 回 `waiting_*` 时重新 surface 该请求。
**不做**：不重构权限协议主干；不动 PreToolUse hook 机制（CLAUDE.md pitfall #6）。
**退出条件**：构造 paused-on-`vessel_workflow_paused` run，后台→前台 iOS 渲染选项并推进；构造 deny+指示，Claude 收到指示文本而非裸 deny；断线时 run 卡 permission，reattach 后 sheet 重新出现且无伪造 deny。

### Phase B — Mid-stream live 重放（仅按需，硬 gate）
**硬 gate（v0.2 新增）**：仅当 (a) Phase A1 characterization test 通过 **且** (b) 用户**明确要求**后台→前台无缝逐 token 续播 才启动。否则不做。
**核心**：per-run seq 化出站 buffer + 重连握手带 `runId+lastSeq`，重放 seq>lastSeq 再转 live；窗口取业界 2-5min，溢出回退 A1 全量。
**升级要求**：wire 协议字段 → 升 contract mode + ADR-lite，不在本 proposal 实现。

**辅助（非阶段，可选）**：iOS `enterBackground()` 加 `beginBackgroundTask` 包一层，给极短切走买 ~30s——纯缓解，不替代 A1。

## 6. 关键不变量（护栏）

- **I-1 解耦不等于无界**：detached run 必须由 **backend-owned orphan manager** 有界回收（非 iOS watchdog）。
- **I-2 重挂优先 force-clear 兜底**：iOS 重连先发 `reattach_run`，**仅 status=expired/failed** 才 force-clear；不得两路都走。
- **I-3 完成态用持久 jsonl，不用内存 buffer**：A1 回放源是磁盘 transcript（无溢出）；Phase B 内存 buffer 溢出必降级到 I-3。
- **I-4 重挂必须重投 pending 选择**：reattach 回 `waiting_*` 必须重新 surface（且 iOS 能渲染——A2/C），否则对会暂停的 run 零价值。
- **I-5 不破现有路由不变量**：所有恢复路径仍按 `runIdToConversation` 路由（CLAUDE.md iOS 不变量 #1）；不引入全局 messages/busy（pitfall #7）。
- **I-6 不赌 iOS 保活**：正确性不得建立在"iOS 保住后台 socket"上（Apple DTS 已证伪）；`beginBackgroundTask` 仅 best-effort 叠加。
- **I-7 fallback 必存在**：重挂/重放"不总成功"是前提，失败必回退"全量拉 transcript"。
- **I-8 用户 Stop 必须真停**：`client_interrupt` 永远真 abort；`ws_close` 只 detach；iOS WS-down Stop 须携带 `pendingInterruptRunIds` 或走独立 HTTP endpoint。
- **I-9 detached 不扩大 fail-open**：detached 态新 permission 默认暂停等 reattach，不自动 allow。
- **I-10 detached 工具执行可观测**：已授权工具在 detached 期执行须 telemetry + reattach 回放（不可逆硬触发覆盖）。

## 7. 与现有 IDEAS 的合并建议

新增（建议 P 级）：**P-?: iOS 后台回合存活** → 本 proposal，A1 为止血入口。
新增（H 级）：**H-?: 选择 UI 完整性**（vessel_workflow_paused 渲染 + deny+指示）→ A2/C，独立可交付，对 paused-on-choice 是前置 gate。

## 8. 用户决策（已锁定 2026-05-19）

1. **范围** = **A1 + A2/C**。做后台长回合完成态恢复（A1）+ pending permission/workflow 重投 + 选择 UI 补全（A2/C）。**B 不做**（mid-stream seq-buffer 仅未来按需，需另起 contract+ADR）。
2. **Phase C** = **并入本工作**（与 A2 一起）。A1 不再单独标注"paused-on-choice 暂不覆盖"——本次范围即覆盖会暂停的 run。
3. **orphan TTL** = **照长回合上限 ~8–10min**：detached run 允许自然跑完长回合（合法 5–10min），超过才回收；`waiting_permission` / `waiting_workflow_choice` 态用**更短 TTL**（无人会回来决策，避免空等占资源）。具体数值实施时写进 ADR-lite。

## 9. 关键 Open Questions（实施期解决，非阻塞收敛）

- OQ-A：`reattach_run` 走 WS 入站消息 vs 独立 HTTP endpoint？（HTTP 的好处：WS 未建好也能查 run 状态 / 发 pending interrupt）
- OQ-B：terminal-state record 存内存 ring 还是落 `~/.vessel/`？跨 backend 重启是否需要存活（NF2 已指出"backend 重启丢状态"是 iOS 无法区分的情形之一）。
- OQ-C：多 conversation 并行多 run 同时 detached 时，orphan manager 与 `runIdToConversation` 清理（CLAUDE.md 不变量 #2）的交互测试。
- OQ-D：`waiting_workflow_choice` 的 TTL 与 `vessel_workflow_paused` 现有超时语义如何对齐（避免双超时打架）。

## 10. Phase 2/3 评审 — 已完整跑（不 skip）

用户明确要求"走完整的评审"。已执行：Phase 1（arch lens Claude + cross lens cursor-agent GPT-5.5，parallel 独立）→ Phase 2（双向 cross-pollinate react）→ Phase 3（作者仲裁矩阵）→ 修订 v0.1→v0.2 → 收敛判断。**收敛**：2 BLOCKER 经重设计消解，无新 BLOCKER，剩 3 条真·用户偏好决策（≤3，escalation 合法类别）。异质 reviewer 价值兑现：GPT-5.5 在 B2（8min watchdog 是 iOS 端非后端上界）穿透 Claude 集体盲区，arch reviewer 诚实将自身 F1 MAJOR→BLOCKER。

## 11. 引用源

- [Apple Developer Forums 716118 — Prevent WebSocket from closing when background](https://developer.apple.com/forums/thread/716118)
- [Apple Developer Forums 85066 — UIApplication Background Task Notes](https://developer.apple.com/forums/thread/85066)
- [anthropics/claude-code #34868 — Remote control WS disconnects, no state resync](https://github.com/anthropics/claude-code/issues/34868)
- [WebSocket.org — Reconnection: State Sync and Recovery Guide](https://websocket.org/guides/reconnection/)
- [RingCentral — Recovering a WebSocket session](https://developers.ringcentral.com/guide/notifications/websockets/session-recovery)
- [Socket.IO — Connection State Recovery](https://socket.io/docs/v4/connection-state-recovery)
- [Socket.IO — Troubleshooting connection issues](https://socket.io/docs/v4/troubleshooting-connection-issues/)
