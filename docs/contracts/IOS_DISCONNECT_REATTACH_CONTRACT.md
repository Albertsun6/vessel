# iOS 断线 → Run 存活与重挂 — Wire 契约 v0.2（收敛后）

> **Status**: contract · **收敛**（contract mode phase 1+2+3 完整跑）· **Date**: 2026-05-19 · **Author**: claude (opus-4-7)
> **Review trail**: [p1-arch](../reviews/contract-reattach-arch-2026-05-19-2114.md) · [p1-cross GPT-5.5](../reviews/contract-reattach-cross-2026-05-19-2114.md) · [p2-react-arch](../reviews/contract-reattach-react-arch-2026-05-19-2114.md) · [p2-react-cross](../reviews/contract-reattach-react-cross-2026-05-19-2114.md) · [arbitration](../reviews/contract-reattach-arbitration-2026-05-19.md)
> **收敛 verdict**: 9 ✅ · 1 ⚠️ · 0 🚫 · 1 🟡（workflow 承载层确认，意图不减）
> **ADR**: [ADR-023](../adr/vessel/ADR-023-ios-disconnect-reattach-contract.md)（编号源 = `docs/adr/README.md` ledger，**非** `ls docs/adr/vessel/`；021 为 Steward 预留，本契约取 023）
> **不可逆度**: 中 — 纯 additive wire + capability/flag 双门控；属 CLAUDE.md 阶梯层 wire 锁定点。无 SQLite schema 改动。
> **v0.1→v0.2 关键变更**：(1) ADR-025→**ADR-023**；(2) `waiting_workflow_choice` **移出 wire**（workflow 是 runId-less 广播子系统，结构不可路由）+ 新增 `interrupting` status；(3) C4 新增 **run-owned 可重绑 output sink**（修 cross B2/arch F8：原 onMessage 闭包捕获死连接 send，reattach→running 空心）；(4) C5 重写为 **permission resolver 生命周期子契约**，单一 owner=permission.ts（修 cross B1/arch F3+M4：detach 后 590s fail-open allow + hook zombie）；(5) C4 加 **backend WS liveness**（修 half-open zombie 无界）；(6) Swift 4 触点 + cwd allowlist + runId-mandatory Stop。

## 0. Context

proposal 已确诊根因 + 收敛（[IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL v0.2](../proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md)，范围锁 A1+A2/C，orphan TTL ~8-10min）。本契约把散文锁成精确 wire+运行时契约，对齐三端。**ADR 编号来源 = `docs/adr/README.md` ledger**（README:44 预留 ADR-021 给 Steward 后续；:45 ADR-023 空闲）→ 本契约取 **ADR-023**。

**Ground truth（读原文核实）**：
- `ClientMessage`=protocol.ts:19-69（无 reattach）；`ServerMessage`=:71-161（无 run_status）。
- `RunHandle`=index.ts:426 `{abort,permissionToken,unregisterPermission}`；per-conn `runs`=:434；`const send`=:438 闭包；`channelSend`=:558-566 闭包捕获 `send`；`onMessage/onClearRunMessages`=:586-594、`session_ended/error`=:596-604 **全部闭包捕获 per-connection `send`**；ws.close=:688 遍历 abort+unregisterPermission。
- `run-registry.ts`（48 行）跨连接 registry，`RegisteredRun{abort,cwd,prompt,startedAt}`，**无 TTL/reaper/state/output sink**；index.ts:569-570 `registerRun()` 传完整 struct（internal API，无外部消费者）。
- `permission.ts`（89 行）：registry keyed by `token`（per-conn send）；`registerPermissionChannel` 返回的 unregister 闭包**同步 `resolve("deny")` 全部 pending** 再 delete（:28-38）；`/ask` 时 armed `setTimeout(resolve("allow"), 590_000)`（:71-78）。`permission-hook.mjs:46-72` 单次阻塞 `await fetch` 无 client timeout（590s 注释即为防 hook zombie）。
- `vessel_workflow_paused` 由 `workflow/executor.ts:153-168` 携 `workflowId/step/message/options`（**无 runId**）经 index.ts:367-385 `broadcastToAll` 广播；workflow 子系统**零** runId/runs/run-registry 耦合 → 与 cli-runner `runs` 是两条独立路径。
- iOS `Protocol.swift`：`enum ServerMessage` decode `default→.unknown`（:159-161，未知 type 不抛、降级丢弃 → 旧端忽略未知 type **为真**）；`runId`(:87-101)/`typeName`(:104-115) 是穷举 `switch self`（加 case = 编译错，非静默 drop）；`BackendClient.swift:471-478` 按 `msg.runId` 路由，nil/无 handle → drop。
- ADR：`docs/adr/README.md` ledger 为编号权威；vessel 现存 ADR-000..020、022(filter-repo 消耗)、024；021 预留 Steward，023 空闲 → 取 **023**。

## 1. 契约总览（6 条）

| # | 契约 | 三端触点 | 兼容性 |
|---|---|---|---|
| C1 | 新入站 `reattach_run`（cwd 过 allowlist） | TS union + Swift Encodable + backend dispatch | additive |
| C2 | 新出站 `run_status`（7 status，含 `interrupting`，**无 workflow_choice**） | TS + Swift（**4 触点**）+ backend | additive，旧端降级丢弃 |
| C3 | Run 状态机（仅 client_interrupt/ttl_expired→abort；Stop replay 必带 runId） | backend 运行时 | 行为变更，双门控 |
| C4 | **run-owned 可重绑 output sink** + orphan manager + **WS liveness** + terminal record + TTL | run-registry.ts + index.ts emission 重构 | internal 重构（非 wire 兼容问题） |
| C5 | **permission resolver 生命周期**（单一 owner=permission.ts，3 终态） | permission.ts + index.ts close | 行为变更，移除同步伪 deny |
| C6 | capability 协商 + flag `VESSEL_RUN_SURVIVES_DISCONNECT`（默认 OFF） | user_prompt 增字段 + backend env | additive + 默认 OFF，rollback=env flip |

**Workflow 暂停（proposal §8 Phase C 的一半）不在本 wire 契约内**：`vessel_workflow_paused` 是 workflowId 广播、服务端本就靠 broadcast+/resume 存活，**不需 reattach 续命**；唯一缺口 = iOS 无渲染器。→ Phase C 工作流暂停 = **纯 additive iOS UI sibling 项**（渲染已广播的 `vessel_workflow_paused`），范围内但技术承载 ≠ reattach wire。reattach_run 仅覆盖 cli-runner runs。

## 2. C1 — `reattach_run` ClientMessage（新增 additive）

**TS**（追加 ClientMessage union，`interrupt` 后）：
```ts
| { type: "reattach_run"; runId: string; conversationId: string; sessionId?: string; cwd: string }
```
**Swift**（Protocol.swift `enum ClientMessage` 加 case + encode 分支，模式同 `interrupt`）：
```swift
case reattachRun(runId: String, conversationId: String, sessionId: String?, cwd: String)
```
**backend**（index.ts ws.on(message) 新 dispatch 分支）：
1. **先 `verifyAllowedPath(msg.cwd)`**（对齐 user_prompt index.ts:537-542）；失败 → `send({type:"error",runId,error:"cwd not allowed"})`，**不**用于 transcript fallback。
2. 按 C3 查 run 态 → 回 C2 `run_status`，并（若 running）按 C4 原子绑定本连接为该 run 的新 output sink。

**语义**：iOS 重连成功后，对每个本地仍 `busy` 的 conversation 发 `reattach_run`（**替换** `clearStuckRunsAfterReconnect` 的无条件 force-clear）。

## 3. C2 — `run_status` ServerMessage（新增；7 status）

**TS**：
```ts
| {
    type: "run_status"; runId: string;
    status: "running" | "interrupting" | "completed" | "failed" | "aborted" | "expired" | "unknown";
    endedReason?: "completed" | "interrupted" | "error";
    sessionId?: string;
    pending?: { kind: "permission"; requestId: string; toolName: string; input: unknown };
  }
```
> **去掉 `waiting_workflow_choice`**（workflow 不可经 runId 路由，见 §1）。**加 `interrupting`**（修 M-INTERRUPTING：SIGTERM→5s→SIGKILL 窗口内不得提前合成 aborted）。7 个 = running/interrupting/completed/failed/aborted/expired/unknown。`pending` 只剩 permission 一种。

**Swift 契约（4 触点，缺一即 decode 成功仍被 drop）**：
1. `enum ServerMessage` 加 `case runStatus(...)`；2. `decode` 分支（`status` 用 `RunStatus(rawValue:) ?? .unknown` 防未来扩 enum 旧 app 崩）；3. `runId` accessor 的 `switch self` 加分支；4. `typeName` 的 `switch self` 加分支；5. `BackendClient.handle` 在 runId 路由后按 status 分发。

**status → iOS 行为（契约绑定）**：
| status | iOS 动作 |
|---|---|
| running | 清"连接中断"占位；后续 sdk_message 经 C4 重绑 sink 续显示；从 transcript catch-up 补 detach 窗口产出 |
| interrupting | 保持 busy + "停止中"；**等真实 session_ended** 再落终态（不立即写 aborted） |
| completed | `handleSessionEnded(completed)` + SessionsAPI.transcript 全量 reconcile |
| failed/aborted/expired | `handleSessionEnded(对应 reason)` + 写终态文案 |
| unknown | 拉 transcript；有完整末轮 assistant→reconcile，否则 force-clear（保留现兜底，覆盖 backend 重启丢态/NF1） |

## 4. C3 — Run 状态机

状态：`attached_running` · `detached_running` · `interrupting` · `completed_detached` · `expired`

| 事件 \ 态 | attached_running | detached_running | interrupting | completed_detached |
|---|---|---|---|---|
| `client_interrupt` | →interrupting，**abort()** | →interrupting，**abort()** | 幂等 | 忽略（已终） |
| `ws_close` | →detached_running（**不 abort**） | 幂等 | 保持 | 保持 |
| `liveness_lost`（无 pong>TTL） | →detached_running | n/a | 保持 | 保持 |
| `reattach` | 刷新 lastActivityAt + 原子换 sink | →attached_running + **原子换 sink**，回 status=running | 回 status=**interrupting**（不回 aborted） | 回 completed/failed/aborted + 标 terminal consumed |
| `ttl_expired` | 不触发（liveness 有效不计） | →expired，**abort()**+cleanup | →expired | record GC |
| `process_exit` | attached→直接 session_ended | 写 terminal→completed_detached（单线程临界区，若 reattach 在途则排队给它） | →terminal record（abort 完成）| 幂等 |

**硬规则**：
- **只有 `client_interrupt` 与 `ttl_expired` 调 `abort()`**（I-12）。`ws_close`/`liveness_lost` 永不 abort。
- `interrupting` 态 reattach **回 `interrupting`**，由真实 `session_ended` 驱动终态；SIGTERM→SIGKILL 5s（cli-runner.ts:233-246）窗口内进程可能仍出消息/正常完成 → **绝不**提前合成 aborted；registry 抑制 abort 后续输出，terminal cleanup 幂等。
- `process_exit` 与 `reattach` 竞态：registry 更新是**单线程同步临界区**；`process_exit` 只写 terminal + consumed-flag；在途 reattach 读 terminal 后发 status 并标 consumed；GC 后删（防双发/漏发）。
- **Stop replay 必带具体 runId**：reconnect 后补发的 Stop（iOS WS-down 期间按下）必须经 `reattach_run` 携带或独立 `POST /api/run/:id/interrupt`（复用 run-registry.interrupt()，OQ-A），**禁止**走 index.ts:475-480 无-runId→abort-all（survive 后同连接 sibling 更多，blast radius 比现行大）；runId 未知（pre-systemInit 不变量#8）→**仅本地 force-clear，不发服务端 abort**。
- iOS `interrupt()` WS-down 分支（BackendClient.swift:399-420）改：入 `pendingInterruptRunIds`，reconnect 后带 runId 真 abort，非仅本地清。

## 5. C4 — Run-owned 可重绑 sink + orphan manager + liveness

### C4.1 可重绑 output sink（修 cross B2 / arch F8 — 最高严重度）
**问题**：index.ts:586-604 的 onMessage/onClearRunMessages/session_ended/error **闭包捕获** per-connection `send`（:438/:558-566）。ws_close 后（I-12 不 abort）子进程继续往死 socket 闭包写 → 丢。`reattach→running` 空心。

**契约**：`RegisteredRun` 加 sink 字段；run 的**全部** emission（sdk_message / clear_run_messages / session_ended / error / permission_request 重广播）**只**经 `registry.get(runId)?.attachedSend` 发，**不再**闭包捕获连接 `send`：
```ts
attachedSend?: (m: ServerMessage) => void;   // 当前绑定连接的 sink；无连接=undefined（丢弃，不 buffer）
attachConnectionId?: string;
attachGeneration: number;                    // 单调递增；每次 reattach +1
```
- reattach = **原子**：critical section 内 `attachedSend=新连接 sink; attachConnectionId=...; attachGeneration++`。
- 旧连接残留写入按 `attachGeneration` fence 丢弃（subsumes process_exit-during-reattach 竞态，§4）。
- detach 窗口产出 **不内存 buffer**（无界风险）→ reattach→running 后 iOS 经 SessionsAPI.transcript **catch-up** 补回（jsonl 是持久内容源，I-3）。

### C4.2 orphan manager + terminal record
`RegisteredRun` 扩（**internal API，index.ts:569-570 call-site 同步改传初始值；run-registry 无外部消费者，非兼容破坏**——删 v0.1 "旧调用不破" 话术）：
```ts
state: "attached_running"|"detached_running"|"interrupting"|"completed_detached"|"expired";
lastActivityAt: number; detachedAt?: number; sessionId?: string; conversationId?: string;
capabilityReattach: boolean;
pending?: { kind:"permission"; requestId:string; toolName:string; input:unknown };
terminal?: { endedReason:"completed"|"interrupted"|"error"; endedAt:number; consumed:boolean };
```
Reaper `setInterval` 30s：detached_running 且 `now-detachedAt>DETACHED_TTL`→abort+cleanup→expired；有 permission pending 的 detached→更短 `WAITING_DETACHED_TTL`；terminal 且 `now-endedAt>TERMINAL_RECORD_TTL`→GC；attached_running 且 liveness 有效→不计 TTL。

### C4.3 backend WS liveness（修 M-LIVENESS — half-open zombie 无界）
**`heartbeatRecordSpawn`（index.ts:571）是 run-spawn 健康统计，不是 WS 心跳，不可伪复用**（cross 纠正）。契约**新增** backend-owned WS ping/pong（或 app-level heartbeat）：`attached_running` 非"不计 TTL"而是"liveness 有效则不计 detached TTL"；超 `ATTACHED_LIVENESS_TTL` 无 pong → `liveness_lost` 事件 → `detached_running` → 走 orphan TTL。覆盖 TCP half-open / iOS 挂起静默死（正是断线场景，proposal §0 step3 实证 abort 仅在 resume 后才浮现）。

### C4.4 TTL 锁定值（用户决策"~8-10min / waiting 更短"，进 ADR-023）
| 常量 | 值 | 依据 |
|---|---|---|
| `DETACHED_TTL` | 600s (10min) | 覆盖合法长回合 5-10min |
| `WAITING_DETACHED_TTL` | 120s (2min) | 无人会回来决策；Socket.IO CSR 默认 120s |
| `ATTACHED_LIVENESS_TTL` | 90s（建议；实施期 dogfood 调，更新 ADR） | 移动网络 RTT 容忍 + 及时回收 zombie |
| `TERMINAL_RECORD_TTL` | 300s (5min) | 覆盖断线-foreground 间隔 2-6min 上沿 |

## 6. C5 — Permission resolver 生命周期子契约（单一 owner = permission.ts）

**问题**（修 cross B1+M4 / arch F3 升 BLOCKER）：`/ask` 时 armed 的 `setTimeout(resolve("allow"),590_000)`（permission.ts:71-78）callback 无条件 allow、零 channel-state 感知。detach 后该 timer 仍 590s 自动 allow = 安全承重墙违反 I-9。移除同步 deny 后若放任 pending → hook `await fetch`（permission-hook.mjs:46-72）zombie。三难题唯一一致解：**TTL 到期 expire + resolve("deny") + clear timer，绝不 allow、绝不无限挂起**。

**契约**：timer/resolver 单一 owner = **`permission.ts`**；`run-registry` reaper **只发 detach/reattach/terminate 事件，绝不直接碰 timer**（跨模块 = 回归 locus）。新 API：
- `detachPermissionChannel(token, { waitingTtlMs })`：`clearTimeout` 已 armed 的 590s allow-timer；改 arm `waitingTtlMs`(=`WAITING_DETACHED_TTL`) 到期 timer，callback = **`resolve("deny", reason:"run expired while detached")`**（非 allow，非无限挂起）；解绑 send（不动 pending 内容）。
- `reattachPermissionChannel(token, send)`：重绑 send；clear detached-expire timer；恢复 attached 计时（重新 arm 590s fail-open，**仅在有 attached 客户端时** fail-open 语义合法）；把 pending 的 `permission_request` 重投新连接（或经 C2 `run_status.pending` 一次性带回）。
- `terminatePermissionChannel(token, "deny")`：现行行为（deny 全部 pending + delete）。仅 run 真终结（aborted/expired/failed）走。

**ws_close → 调 `detachPermissionChannel`（非现行同步 deny 闭包）**，消除 detach 瞬间伪造 deny 污染执行轨迹（proposal NF1）。**3 个终态转移，无第 4 种**：reattach→恢复 / WAITING_DETACHED_TTL→deny+expire / 真终结→terminate-deny。`I-9`：detached 期间**新** permission 同此——挂起至 reattach 或 WAITING_DETACHED_TTL→deny+expire，**绝不** auto-allow。`I-10`：detached 期已 allow 工具继续执行 → `run.detached.tool_exec` telemetry + reattach 回放。

## 7. C6 — Capability 协商 + feature flag

- `user_prompt` 加可选 `clientCapabilities?: { reattach?: boolean }`（additive；旧 iOS 不发=不支持）。
- backend env `VESSEL_RUN_SURVIVES_DISCONNECT` 默认 **OFF**。
- run 启用 survive-disconnect **当且仅当** `flag=ON` 且 创建该 run 的 `user_prompt` 声明 `clientCapabilities.reattach=true`（存 `RegisteredRun.capabilityReattach`，**绑 run 非绑连接**——reattach 由声明过 capability 的同类客户端发起）。
- 否则 `ws_close` 维持现行 abort → 旧 iOS 路径**逐字节不变**（杜绝 NF2 UI↔transcript 分裂——旧端 force-clear 而 backend 续跑的矛盾不发生）。
- rollback = env flip OFF，无需 redeploy/改客户端。

## 8. 三端对齐表

| 字段/类型 | TS protocol.ts | Swift Protocol.swift | backend 运行时 |
|---|---|---|---|
| `reattach_run` | ClientMessage union 追加 | `enum ClientMessage` case+encode | ws.on(message) 新分支 + verifyAllowedPath |
| `run_status` | ServerMessage union 追加 | **4 触点**：case + decode(`?? .unknown`) + `runId` switch + `typeName` switch + `BackendClient.handle` 分发 | 状态机映射后经 C4 sink send |
| `status`(7) | string literal union | Swift enum:String 含 `.unknown` 兜底 | C3 状态机 |
| `pending`(permission) | 单 variant | Swift struct | RegisteredRun.pending |
| `clientCapabilities.reattach` | user_prompt 可选 | userPrompt case 增参+encodeIfPresent | RegisteredRun.capabilityReattach |
| RegisteredRun 扩字段 + attachedSend | — | — | run-registry.ts interface 扩 + index.ts emission 重构 + reaper + liveness |

## 9. 关键不变量（继承 proposal I-1..I-10 + 契约层）

- **I-11 纯 additive wire + 门控**：wire 改动纯 additive；行为变更经 C6 capability+flag 双门控；旧 iOS 路径逐字节不变。
- **I-12 abort 单一入口**：代码层 `abort()` 仅 `client_interrupt`/`ttl_expired` 两处；`ws.on("close")`/`liveness_lost` 直接 abort = 契约违反（grep dogfood 检查）。
- **I-13 output 单一 sink**：run 的所有 emission 只经 `registry.get(runId)?.attachedSend`；任何闭包捕获 per-connection `send` 用于 run 输出 = 契约违反。
- **I-14 permission timer 单一 owner**：timer 生杀只在 permission.ts；run-registry/index.ts 经 3 个 API 间接驱动，不直接 `setTimeout/clearTimeout` permission timer。
- **I-15 detached 不 allow**：detached 态 permission 终态只能 deny/expire，**永不 allow**；终态恰 3 种无第 4。

## 10. Open Questions（实施期解决）

- OQ-A：Stop replay 走 `reattach_run` 携带 vs 独立 `POST /api/run/:id/interrupt`（复用 run-registry.interrupt()，WS 未建好也能停）。倾向两者都要。
- OQ-B：terminal record 内存 ring（简单，重启丢→status=unknown 兜底）vs 落 `~/.vessel/`（跨重启，复杂）。倾向内存 ring。
- OQ-C：多 conversation 并行多 run 同时 detached → reaper 与 `runIdToConversation`（CLAUDE.md 不变量#2）清理并发测试。
- OQ-D：`ATTACHED_LIVENESS_TTL` / `WAITING_DETACHED_TTL` 与 workflow `MAX_STEP_TIMEOUT_MS`(30min) 无耦合（workflow 已出 wire 范围），仅记录避免实施期混淆。

## 11. Dogfood gate（contract mode 必跑；patch 阶段强制）

`scripts/verify-m1-deliverables.mjs` 是 M1 专用，**不复用**。本契约 dogfood 判据：
1. **契约形状测试**：TS↔Swift round-trip `reattach_run`/`run_status`（含 `status` 未来未知值 → Swift `.unknown` 不崩；7 status 全覆盖）。
2. **安全单测（B-PERMTIMER 承重墙）**：`arm permission /ask → ws_close → advance clock past 590s → assert decision ≠ "allow"`（且 ≤ WAITING_DETACHED_TTL 后为 deny + run expired + timer cleared + 无 zombie hook fetch）。
3. **Sink rebind 测试（B-SINK）**：run 中途 ws_close → reattach 新连接 → assert 后续 sdk_message 到新连接、旧 generation 写入被丢弃；detach 窗口产出经 transcript catch-up 补回（对比 ChatLine[] = 直连基线）。
4. **Characterization test**（proposal M2，3 场景）：直连 / 后台断连完成 / 断线落 tool_use↔tool_result 之间 → 对比 ChatLine[]/末 assistant/sessionId/busy 一致。
5. **状态机不变量**：ws_close 不产 abort；client_interrupt 产 abort；interrupting 态 reattach 回 interrupting 不回 aborted；detached+新 permission 不 allow；TTL→expired；half-open（无 pong）→ ATTACHED_LIVENESS_TTL 内转 detached。
6. **I-12/I-13/I-14 静态检查**：grep `abort.abort()` 仅状态机两处；grep run 输出 emission 无闭包捕获连接 send；grep permission timer 操作仅 permission.ts。
7. **门控回归**：flag OFF 或无 capability → ws_close 行为逐字节同现行（旧 iOS）。

无 SQLite schema 改动 → 无 migration/dry-run/旧数据兼容项（显式声明 contract-mode dogfood 的 schema 分支不适用）。

## 12. 评审

contract mode phase 1（arch Claude + cross cursor-agent GPT-5.5 异质 parallel 独立）→ phase 2 cross-pollinate → phase 3 仲裁 → v0.1→v0.2 收敛。4 BLOCKER（ADR / workflow 不可路由 / permission 590s 承重墙 / output sink 空心）经评审自带代码级修法消解，0 反驳，1 用户确认（workflow 承载层，意图不减）。异质价值兑现：GPT-5.5 B2（sink 空心）穿透 Claude arch lens 集体盲区，react-arch 诚实新增 F8 BLOCKER。

> **诚实标注**：v0.2 的两个新代码级机制（C4 sink rebind、C5 permission lifecycle）由评审逐字段指定但本身未单独过一轮 phase-1 —— 按 contract mode 设计这正是 §11 dogfood gate 在 **patch 阶段强制验证**的对象（测试 2/3/6）。contract→patch 的正确交接，非评审缺口。

## 13. 引用源

继承 proposal §11（Apple DTS 716118 / claude-code #34868 / websocket.org / RingCentral / Socket.IO CSR）。契约层 ground truth = §0 全部本仓原文 file:line（含 docs/adr/README.md ledger）。
