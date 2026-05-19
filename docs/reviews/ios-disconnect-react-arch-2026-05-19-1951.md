# Phase 2 React — architecture-fit lens
> Reviewer: harness-architecture-review · Date: 2026-05-19 · Phase 2 (cross-pollinate)

## 对 cross verdict 的逐条表态

### B1 — refine
**对方原文**: "Phase A '零 wire 协议改动'不成立 … 至少定义一个 reattach/inspect 契约，例如 client 重连后发送 `{ type: "reattach_run", runId, conversationId, sessionId, cwd }`"
**我的表态**: refine（同意核心事实，部分修正定性，且把它与我的 F1 显式收敛）
**理由**: 事实层面 cross 是对的，且比我的 F1 更精确。我 Phase 1 F1 也指出 Phase A 必须靠"服务端 = liveness oracle 的 reconnect handshake"，但我当时写成"this needs zero protocol change — it's a reconnect handshake on the existing WS"。**这句话现在我撤回**：我 fact-check 了 `packages/shared/src/protocol.ts` 不在我 Phase 1 验证范围（我只验证了 index.ts/cli-runner），而 `index.ts:451-479` 的 `ws.on("message")` 现有 client message 只有 `interrupt` / `vessel_cancel` 等，**没有任何 `reattach_run` / `inspect_run` 入站消息类型**，服务端也没有对应回包。一个新定义的 `client→server` 消息 + 一个 run-status enum 回包，按 CLAUDE.md "阶梯层（骨架）… wire protocol … 靠 up-front proposal 或 ADR-lite + cross review 锁定" 的判据，**这就是 wire 协议改动**，与 Phase A headline "无 wire 协议改动 / 零协议改动 / 不引入新 ServerMessage 字段"（§5、§0 不可逆度行）直接矛盾。
但定性我做一处 refine 而非全盘 agree BLOCKER：cross 的 reattach enum（`running|completed|failed|aborted|expired|waiting_permission|waiting_workflow_choice`）正确，但 enum 里 `completed` 这一支**确实**可以零新协议——iOS 已有 `SessionsAPI.transcript` HTTP endpoint 做全量回放，那条路是现成的。真正强制新协议的是 `running`（live rebind 后续 sdk_message）+ `waiting_*`（重投 pending）这两支。所以准确表述是："Phase A 的**完成态恢复**可零协议；**live/paused 重挂**强制 wire 增量"——这恰好把 cross B1 与提案自己的 Phase A/B 边界对齐了：提案把 mid-stream live 划给 Phase B（需升 contract），但**漏了"判断 run 是否还活着"这个 reattach query 本身**就已经是 Phase A 内的协议增量，不能塞进"零协议"叙事。
**新建议**: Phase A headline 从"零 wire 协议改动"改为"**最小协议增量：1 个 `reattach_run` 入站 + 1 个 run-status 回包**"，并据此把 Phase A 的 阶梯/螺旋 归类从纯螺旋升级为"**螺旋（行为）+ 1 条 ADR-lite 锁 reattach contract**"（不是全 Phase B 那种 seq 化大改，但 reattach 消息形状必须 up-front 锁定 + cross review，符合 CLAUDE.md 阶梯层判据）。enum 采用 cross 的 7 态，但标注 `completed` 走现有 transcript endpoint（零增量）、`running`/`waiting_*` 才是真协议增量。

### B2 — agree
**对方原文**: "'复用 8min watchdog'不是服务端资源上界 … ground truth 里的 8min watchdog 是 iOS `BackendClient.tickWatchdog()`，不是 backend orphan-run watchdog"
**我的表态**: agree（这是异构 reviewer 抓到的集体盲区，我 Phase 1 F1 的修复在这点上有实质漏洞，诚实承认）
**理由**: 我 fact-check 了三处确认 cross **完全正确**：
1. `BackendClient.swift:591-620` — 8min threshold (`let threshold: TimeInterval = 8 * 60`, line 599) 在 `tickWatchdog()` 里，由 `Timer.scheduledTimer(withTimeInterval: 30, repeats: true)`（line 593）驱动，**纯 iOS 端**。它只对 `store.stateByConversation where state.busy`（line 601）生效，且 `Timer` 在 app suspended 时**不 fire**——正是断线场景下它根本不运行。
2. `index.ts` 全文 + `cli-runner.ts` 全文 grep `setTimeout|setInterval|TTL|reaper|orphan|stale`：**服务端唯一的 setTimeout 是 cli-runner.ts:240 的 SIGTERM→SIGKILL 升级 timer**，那只在 abort *已经被触发后*才启动。`run-registry.ts` 全文（48 行）只有 `register/unregister/get/listActive/activeCount/interrupt`，**无任何 TTL / 定时清理**。`registerRun(runId, {abort, cwd, prompt, startedAt})`（index.ts:570）里有 `startedAt` 但没有任何代码读它做超时回收（`listActive` 只拿来算 `runningSec` 给 `/health` 显示）。
3. 结论：**服务端对 run 生命周期没有任何上界**。当前唯一让 detached/孤儿 CLI 子进程死掉的机制就是 `ws.on("close")` → `h.abort.abort()`（index.ts:690-694）。Phase A 一旦移除这条，**服务端就完全没有任何兜底**，提案 §8.1 + §6 I-1 + 我 Phase 1 F4 都把"复用现有 8min watchdog 语义"当成现成资源上界——**这是错的，那个 8min 根本不在服务端，断线时根本不跑**。这正是我 Phase 1 F1 的实质漏洞：我说"the detached run is still in the runs map (index.ts:570) … server is the run-liveness oracle"，正确指出了 liveness 来源，但**完全没有质疑"宽限回收靠什么"**，默认接受了提案的"复用 8min"叙事，没有去验证那个 8min 在哪一端。Cross 的异构视角（GPT-5.5）在这点上比我的 Claude 视角更早穿透——这就是 Phase 2 的价值，承认它是 deliverable 本身。
**（无新建议——cross 的 suggested fix「Phase A 必须新增 backend-owned orphan manager，记录 detachedAt/lastActivityAt/pendingPermission，hard TTL，cleanup 走同一套 abort + unregisterPermission + map cleanup，telemetry 记 run.detached/reattached/orphan_aborted」已经完整且正确，我背书全部，仅补一句：cleanup 必须同时 `unregisterRun(runId)`（index.ts:610），否则 run-registry 泄漏，cross 只点了 unregisterPermission + map cleanup 但 Vessel 有两套 registry）**

### M1 — agree
**对方原文**: "OQ1 仍是问题，不只是 open question … 改成 ws.close 不 abort 后，所有'连接消失'都会变成 detached，包括浏览器关页、iOS app 被杀、用户退出页面、网络断开"
**我的表态**: agree（与我 Phase 1 F2 同源，cross 的状态机表述更系统，应收敛到统一 state-machine 修复）
**理由**: 我 Phase 1 F2 已独立命中同一处：`index.ts:475-481`（interrupt → abort）与 `index.ts:688-693`（ws.close → abort）共用同一个 `AbortController.abort()`，无信号区分。我 fact-check 复核 index.ts:688-694 确认 `ws.on("close")` 无条件 `for (const h of runs.values()) { h.abort.abort(); h.unregisterPermission(); }`，与 cross 引用一致。cross 比我多走一步——把它显式建模为状态机（`attached_running / detached_running / interrupting / completed_detached / expired` + 事件 `client_interrupt / ws_close / reattach / ttl_expired / process_exit`），并补了我没强调的产品语义缺口：**"用户关闭客户端（关页/杀 app）是否等价于'放后台等完成'" 这个语义提案没定义**。我 F2 只覆盖了"用户主动按 Stop 时 WS 已 down"这一支（iOS `interrupt()` 的 WS-down else 分支变 bug），cross 覆盖了更广的"任何 connection 消失都变 detached"——两者是同一根因的不同切面，应**合并为单一状态机修复**：我 F2 的 I-8（interrupt 必真停 + iOS pending-interrupt enqueue）+ cross 的 5 态状态机 = 完整解。两条不冲突，是互补，准 accept。
**（refine 级补充收敛点，写给 author 仲裁）**: 把我 F2 的 I-8 invariant **作为 cross 状态机的转移约束**写入——状态机里只有 `client_interrupt` 事件能进 `interrupting→abort`，`ws_close` 只能进 `detached_running`；并显式定义 cross 提出的产品语义缺口默认值（建议："关页/杀 app = ws_close = detach 并等 orphan-manager 回收"，不等于用户 Stop——因为用户没发 interrupt，符合最小意外原则）。

### M2 — agree
**对方原文**: "Phase A 依赖 jsonl 完成态回放，但没有验证落盘完整性 … 没有确认 cli-runner 与 Claude CLI 的落盘时机"
**我的表态**: agree（与我 Phase 1 F1 前半段同源，cross 的 characterization test 是更可执行的验收，应采纳）
**理由**: 我 Phase 1 F1 已 fact-check 并确认核心事实：`cli-runner.ts` 从不写 session jsonl（唯一 writeFileSync 是 line 193 的 temp system-prompt 文件），transcript 由 `claude` CLI 子进程自己增量写，且**结尾无 terminal marker**（真实 164 行 transcript 末尾是裸 assistant entry，无 result/system-init/success），`session_ended` 是 Vessel 在 index.ts:596-597 合成、只活在 WS 流、永不落盘。cross 的 M2 是这同一事实的"验收化"——它没我 F1 的 root-cause 深度（我证明了 terminal marker 不存在 + session_ended 是合成的），但它给了我 F1 缺的东西：**一个可执行 characterization test**（同一长 prompt，直连 vs 后台断连，对比解析后 `ChatLine[]` 数量 / 最后 assistant 内容 / sessionId / busy 清理结果）。这正好补 §6 缺的 outcome-based gate（Karpathy-④"只有可执行验证才真正约束 agent"）。两者收敛：F1 给"为什么 jsonl 不够"，M2 给"怎么机器验证 jsonl 够不够"——应合并。
**（无独立新建议——采纳 cross 的 characterization test 作为 Phase A 的硬验收门，并与我 F1 的"server = liveness oracle, transcript = content-only"设计绑定：test 必须同时验证 liveness 判定来自 reattach query 而非 transcript 末行启发式）**

### M3 — agree
**对方原文**: "pending permission/workflow 的重投机制没有后端存储设计 … 现有 ground truth 显示 close 时会 `h.unregisterPermission()`，Phase A 如果不 unregister，就必须保证 pending registry 不再绑定旧 connection"
**我的表态**: agree（我 fact-check `routes/permission.ts` + `index.ts` close handler，cross 的事实和危险路径全部坐实，且这与我 F1 的 server-as-oracle 设计深度耦合，cross 抓到了我 F1 没展开的一环）
**理由**: fact-check 三处全部确认 cross 正确：
1. `permission.ts:21-39` — `const registry = new Map<string, RegistryEntry>()`，key 是 `token`（per-run 的 `permissionToken`），`RegistryEntry = { send, pending }`。`send` 是**该连接的** `channelSend`（index.ts:567 `registerPermissionChannel(permissionToken, channelSend)`）→ **pending registry 是 connection-owned**（cross 定性精确）。
2. `permission.ts:28-38` — `registerPermissionChannel` 返回的 unregister 闭包会 **`r.resolve("deny")` 掉所有 in-flight pending** 然后 `registry.delete(token)`。`index.ts:692` `ws.on("close")` 显式调 `h.unregisterPermission()`。所以**当前断线时 pending permission 立即被 resolve 成 deny**——cross 推断的"若 unregister，run 可能永远等不到决策"实际更糟：是**run 收到一个 deny**（不是 hang），Claude CLI 会以为用户拒绝了工具继续跑下去，断线期间产生的是"被误判为拒绝"的语义偏差。
3. `permission.ts:71-89` `/ask` 的 fail-open：`PENDING_TIMEOUT_MS = 590_000`（≈9.8min），timeout 后 `resolve("allow")`。cross 的 m3 风险（断线期间自动 allow）成立，但**优先级排序**：close 时的 `unregisterPermission()` 同步 deny 会**先于** 590s timeout 触发，所以现状是"断线 → 立即 deny pending"，不是"等 590s 后 allow"。Phase A 若按提案移除/改写 close 行为，才会暴露 590s fail-open allow 风险。
这一环我 Phase 1 **完全没碰**——F1 谈了 liveness oracle 和 transcript replay，但没追到"pending permission 的归属随连接死掉"。cross 正确指出 Phase A 必须把 pending registry 从 connection-owned 改 run-owned 才能 reattach replay，这是我 F1"server = liveness oracle"设计的**必要补充组件**（liveness 在 run-registry，但 pending 决策权也得跟着 run 走，否则重挂回来的 run 卡在一个已被 deny 的 permission 上）。这与提案 §6 I-4（重挂必须重投 pending 选择）是同一条线，但 cross 把"重投靠什么存储"这个实现缺口挖出来了，是真贡献。
**（无新建议——cross 的 fix「pending registry connection-owned → run-owned，reattach replay 给新连接，定义 close 时保留与否/保留多久/timeout 是否沿用 fail-open」完整正确。仅补一处实现现实：当前 unregister 会主动 deny，所以 run-owned 化不是"加个保留期"那么简单，要先**移除 close 时的同步 deny**，否则 detach 的 run 在断线瞬间就已被 deny 污染——这点 cross 没点到，归入下方 new-finding）**

### M4 — agree
**对方原文**: "Phase C 被称为 A/B 价值前置 gate，但又可并行，优先级表述冲突 … 这会让实施者不清楚 Phase A 是否可以单独 ship"
**我的表态**: agree
**理由**: 提案 §5 标题行"Phase C — 选择 UI 完整性（A/B 价值前置 gate；可与 A 并行）"+ §0.5 内 §6 I-4 确实自相矛盾："前置 gate"与"可并行"在调度语义上不能同时成立——前置 gate 意味着 A 的价值依赖 C 完成，可并行意味着 A 不依赖 C。cross 的拆解（A1 = 后台长回合完成态恢复，不覆盖 paused-on-choice；A2/C = pending permission/workflow re-surface，分别写验收）是正确的 scope 切分，且与我 Phase 1 的判断一致（我 strong-point #5 说 Phase C 是"correctness prerequisite **for paused runs**"——即只对会 pause 的 run 是前置，对普通长回合不是）。cross 把这个"对哪类 run 是前置"显式建模成 A1/A2 两个子阶段，比提案的模糊措辞和我 Phase 1 的散落表述都更可执行。无异议。

### m1 — agree
**对方原文**: "'100% 排除网络抖动'措辞过强 … 改成'在该样本中未见前台网络失败，主因高度确定…'"
**我的表态**: agree（observation 级，措辞严谨性问题，与我 Phase 1 strong-point #1 不冲突）
**理由**: 我 Phase 1 strong-point #1 说"前台从未发生 ws.receive.failed → 排除网络抖动"的 telemetry discriminator "is methodologically sound"——我维持这个判断（方法论是对的：前台零失败 + 失败 100% 在 background 后，是强 discriminator）。但 cross 的 m1 是更精细的一层：方法论 sound ≠ 措辞可以写绝对排除。"100% 排除 Tailscale / 后端崩溃"在**单一 telemetry 样本**上是过强的——样本内未观察到 ≠ 因果上排除。这不与我的 strong-point 冲突（我背书的是 discriminator 有效，cross 修正的是从 discriminator 到"绝对排除"的措辞跳跃）。两者可共存：保留诊断结论的强度，把"100% 排除"改成 cross 建议的"该样本中未见前台网络失败，主因高度确定为 iOS 后台挂起"。MINOR，准 accept。

### m2 — refine
**对方原文**: "Phase B 可能过早引入 seq-buffer 叙事 … 行业架构章节给了它较大篇幅，容易让后续实现过度设计"
**我的表态**: refine（同意风险存在，但 disagree cross 暗含的"§1 篇幅本身是缺陷"——证据：那一节恰好是我 Phase 1 F5 验证为正确 scope-bounding 的部分）
**理由**: cross 的核心担忧（实现者可能被 §1 行业架构章节带偏、过度设计 seq-buffer）是合理的，这点 agree。但 cross 的措辞"行业架构章节给了它较大篇幅，容易让后续实现过度设计"暗示 §1 的篇幅安排本身是问题——这点我 **disagree-with-evidence**：我 Phase 1 F5 专门 pressure-test 过这个，结论是 §1"Vessel already owns the heavy-tier assets"论点是**正确且恰好在 bound scope**——它把 seq/buffer/retention 复杂度**显式隔离进 Phase B 且 Phase A 不实现**（提案 §5 Phase A "不做：不引入 seq/offset"，§6 I-3 "完成态用持久 jsonl 不用内存 buffer"，§2 共识规律 #3/#4 明确 buffer 是 2-5min 妥协而非默认）。§1 的"业界从轻到重 + Vessel 落最轻档但具备最重档资产"恰恰是**防过度设计的护栏**，不是诱因——它论证的是"Phase A 复用现成 jsonl/--resume/SessionsAPI，不需要 distributed-systems 机器"。所以 refine：cross 的**结论**（锁死 Phase A 验收在 transcript reconciliation、Phase B 仅"用户明确要无缝 token 续播才做"）我完全采纳并背书；但 cross 把 §1 篇幅当成隐患的**前提**应修正为"§1 论点正确，风险不在 §1 而在 §5 Phase B 的'升级要求'段没有把'仅当 Phase A 实测不够'写成硬 gate"。
**新建议**: 不动 §1（它是护栏不是隐患）；改 §5 Phase B 开头加硬 gate 句："**Phase B 仅在 Phase A 的 characterization test（cross M2）通过后、用户仍明确要求'后台→前台无缝看 token 流'时启动**；只看到完成答案即满足时 Phase B 不启动、不写 contract。" 把抑制过度设计的责任放在 Phase B 入口 gate，而非削 §1 篇幅。

### m3 — agree
**对方原文**: "安全章节没有点出'detached run 继续执行工具'的用户意图风险 … 现有 permission fail-open timeout 如果保留，断线期间可能自动 allow"
**我的表态**: agree（安全 lens，与我对 permission.ts 的 fact-check 一致，且与 M3 同根，应合并到同一安全护栏）
**理由**: fact-check `permission.ts:71-89` 确认 cross 的机制描述正确：`PENDING_TIMEOUT_MS = 590_000` timeout → `resolve("allow")`（fail-open by design，注释明说"so the hook doesn't sit forever; the user can always interrupt"）。cross 的安全推论成立：Phase A 让 run 在断线后继续跑，则断线期间触发的**新** permission request，若 close 时不再同步 deny（Phase A 必然要改 close 行为），就会落到 590s fail-open allow——**在用户不在线、无法看到 sheet 的情况下自动放行工具**。这是 4 类硬触发里"安全"的真实风险（断线 = 用户失去对工具执行的知情与否决能力，却仍自动 allow）。与 M3 同根（pending 归属 + fail-open 语义），应合并为单条 Phase A 安全护栏。我 Phase 1 完全没覆盖安全 lens 的这一面（我 4 维里"风险遗漏"只谈了资源/回滚/旧客户端兼容，没谈"断线期间工具自动放行的知情权"）——cross 的安全 lens 补了我的盲区。
**（采纳 cross fix「detached 状态遇新 permission request 默认暂停等 reattach，不因客户端离线扩大 fail-open；如沿用 fail-open 必须明确记录风险 + telemetry」，并与 M3 合并：Phase A 必须新增 invariant —— detached run 的 pending permission 默认 **hold（不 deny 不 allow），等 reattach 重投**；只有 orphan-manager TTL 到期才连同 run 一起 abort，绝不在无人值守时 fail-open allow）**

## 我自己 Phase 1 verdict 的自我修正

**1. F1 MAJOR → 升级为 BLOCKER（接受 cross B1 + B2 的合并定性）。**
我 Phase 1 把 F1 定为 MAJOR 并写了"this needs zero protocol change — it's a reconnect handshake on the existing WS"。**这句话我现在撤回**，理由有二，均有 file:line 反例：
- 反例 a（cross B1）：`index.ts:451-479` 现有入站 client message 无 `reattach_run`/`inspect_run`，protocol.ts 无对应类型。一个新定义的 client→server 消息 + run-status enum 回包，按 CLAUDE.md「阶梯层 … wire protocol 靠 up-front proposal 或 ADR-lite + cross review 锁定」**就是 wire 协议改动**，与 Phase A "零协议改动" headline 直接矛盾。一个 headline 级的虚假"零不可逆"声明会误导 阶梯/螺旋 分类与 anchor gate（我 Phase 1 F3 自己说 Phase A "touches none of the wire/schema anchors"——这个判断**基于错误前提**，现一并修正：Phase A 的 reattach 消息形状是阶梯层物件，需 ADR-lite 锁定）。
- 反例 b（cross B2，我 Phase 1 的实质漏洞）：我 F1 的修复"server is the run-liveness oracle, the detached run is still in the runs map (index.ts:570)"**只证明了 liveness 数据源存在，没证明资源有上界**。fact-check 确认服务端**零 run TTL**（run-registry.ts 48 行无定时清理；index.ts/cli-runner.ts 无 reaper），8min 在 `BackendClient.swift:599` 是 iOS 端、断线时不跑。我 F4 还把"复用 8min watchdog"当成"author design decision, not user tradeoff"轻轻放过——**这是错的**，那个 8min 根本不在服务端。Phase A 移除 ws.close abort 后服务端**完全无兜底**，这是 distributed-systems 教科书级的孤儿进程泄漏，对单机工具也不可接受。这一项严重性独立达到 BLOCKER。

综合：F1 + cross B1 + cross B2 是**同一个 BLOCKER 的三个面**——(a) reattach 需协议（B1）、(b) reattach 需服务端 liveness oracle（我 F1）、(c) liveness oracle 必须配套服务端有界 orphan-manager（B2，我 F1 漏）。三者不可分割，合并为单一 BLOCKER：**"Phase A 必须包含：1 个 reattach wire 增量（ADR-lite 锁）+ 服务端 run-liveness oracle + 服务端有界 orphan-manager（含 pending-permission run-owned 化）；当前提案把这整块当'零协议 + 复用 8min'是三重低估"**。

**2. F4 部分撤回。** F4 说"§8.1（孤儿 run 宽限窗口）the proposal already self-answers（复用 8min watchdog），是 author design decision 不是 user tradeoff"——撤回"already self-answers"部分：cross B2 证明那个自答**指向一个不存在于服务端的机制**，所以 §8.1 既不是已解决的 author decision，也不是真 user tradeoff，而是**一个未设计的服务端组件**（orphan-manager）被错误包装成"复用现成件"。F4 的另两半（§8.2 A-only-vs-AB、§8.3 Phase C 折叠是真 user call）维持不变，仍准确。

**3. F2 维持 MAJOR，但与 cross M1 合并表述。** F2 的事实（interrupt 与 ws.close 共用同一 abort，iOS WS-down else 分支会变 bug）fact-check 复核仍成立（index.ts:688-694 确认）。不升降级，但 I-8 应作为 cross M1 状态机的转移约束写入，不再作为独立 invariant 孤立存在。

**4. F3 部分修正。** F3 原结论"Phase A genuinely touches none of these wire/schema anchors → 纯螺旋分类正确"**前提错误**（见上 #1 反例 a）。修正为：Phase A = 螺旋（run 生命周期行为）+ **1 条阶梯物件（reattach contract）需 ADR-lite**。F3 的 rollback feature-flag（`VESSEL_RUN_SURVIVES_DISCONNECT` 默认 OFF）+ 旧 iOS 客户端兼容行（旧 build force-clear 但后端留 run → 靠 orphan-manager 兜底）两条建议**仍有效且因 B2 更重要**——旧客户端兼容那条现在直接依赖"服务端真有 orphan-manager"，没有 B2 的修复，F3 的旧客户端 degradation 路径（"wasted compute until reap"）里的 reap 根本不存在 = 永久泄漏。

**5. F5 维持。** Phase A 不是过度借鉴分布式机器——这个判断不变。但加一句限定：F5 成立的前提是"orphan-manager 是最小可行的服务端原语"；cross B2 要求的 backend-owned orphan manager **不违反** F5（它是 tmux/mosh 档的 table-stakes 兜底，不是 enterprise gold-plating），author 不应把 B2 当成"被 review 逼着上分布式"而退回 Phase B。

## 新发现 (new-finding)

**NF1（cross 的 M3 + permission.ts fact-check 联合暴露，两份 verdict 都没完整说）**：当前 `registerPermissionChannel` 的 unregister 闭包（permission.ts:28-38）在连接关闭时不是让 pending **hang**，而是**主动 `r.resolve("deny")` 掉所有 in-flight permission**。cross M3 推断的是"若 unregister 则 run 永远等不到决策"，实际比这更隐蔽——run **会收到一个 deny**，Claude CLI 据此认为用户拒绝了工具、改走别的路径继续生成。后果：即使 Phase A 修好了 run 存活 + reattach + orphan-manager，**断线瞬间卡在 permission 的 run 已经被一个伪造的 "deny" 污染了执行轨迹**，重挂回来看到的是一个"用户从未做过的拒绝"导致的分叉答案。所以 Phase A 的 pending run-owned 化不能只是"把 pending 搬到 run、加保留期"——必须**先移除 close handler 里的同步 deny**（index.ts:692 `h.unregisterPermission()` 触发的 permission.ts:32-35 deny 循环），否则 detach 在断线第一时间就已经语义损坏。这是 M3 fix 的一个**前置必要步骤**，cross 和我 Phase 1 都没点到这层因果。

**NF2（安全 lens 盲区，cross m3 触及但两份都没归到不可逆/审计）**：Phase A 让 CLI 子进程在"用户完全不在线、无连接、无遥测回传"的窗口内继续执行 **tool calls（含写文件、git、bash）**。这不只是 m3 说的"fail-open 自动 allow"风险——即使 permission 全部正确 hold，detached run 在断线窗口内**已经允许过的工具仍在跑**（断线前已 allow 的 bash/write 不会因断线回滚）。对一个会跑 `git`/`rm`/`bash` 的 agent，"用户失去可见性的时间窗口内不可逆操作仍在发生"本身是 CLAUDE.md「不可逆操作」硬触发的一种，提案 §6 invariants（I-1~I-7）**没有一条覆盖"detached 窗口内不可逆副作用的用户知情/审计"**。建议新增 invariant：detached run 期间的所有 tool 执行必须落 telemetry（`run.detached.tool_exec`），reattach 时 iOS 必须能回放"你不在的时候它做了这些不可逆操作"，否则用户对单机上发生的写操作完全失明。这是 cross m3（自动 allow）的上位风险，两份 verdict 都只停在 permission 决策层，没上升到"已授权工具的不可见执行"。

**NF3（M2 characterization test 的一个未覆盖维度）**：cross M2 的 characterization test 对比"直连 vs 后台断连"的 `ChatLine[]` 数量/最后 assistant/sessionId/busy。但漏了一个维度——**断线发生在 tool_use 与 tool_result 之间**时，jsonl 此刻的状态。我 Phase 1 F1 验证过 jsonl 是 CLI 增量写、结尾常是裸 assistant；如果断线瞬间 CLI 刚写完 `tool_use` 还没写 `tool_result`（工具正在跑），transcript 全量回放会渲染出一个"永远 pending 的 tool call"。M2 的 test 设计应增加一个 case：断线点 = tool 执行中途，验证 reattach 后该 tool 的最终 result 能补回（这又回到 NF1/NF2：tool 在 detached 窗口跑完，result 进 jsonl，但 iOS 靠什么知道"这个之前 pending 的 tool 现在有 result 了"——又是 liveness oracle 的职责，不是 transcript 末行能判的）。

## 收敛信号小结

**双边已同意（准 accept，交 author 仲裁时按"收敛"处理）**：
- **B2 [BLOCKER]** — 我 agree 且诚实承认 Phase 1 漏了；服务端零 run TTL 已 fact-check 坐实（run-registry.ts 全文 + index.ts/cli-runner.ts grep）。**最强收敛信号**：异构 reviewer 抓到 Claude 视角的集体盲区，无分歧。
- **B1 [BLOCKER←我 F1 MAJOR]** — 我 refine 后**接受 BLOCKER 严重性**（撤回 Phase 1 "zero protocol change" 句）；唯一 refine 是把 enum 的 `completed` 支标注为零增量（走现有 transcript endpoint），`running`/`waiting_*` 才是真协议增量。定性收敛，粒度有一处 refine，留 author 决定 enum 表述。
- **M1 = 我 F2** — 同根，收敛到统一状态机修复（cross 5 态 + 我 I-8 作为转移约束）。准 accept。
- **M2 = 我 F1 前半** — 同根，收敛：F1 给 root-cause，M2 给可执行验收门，合并采纳。准 accept。
- **M3** — 我 agree + fact-check 全部坐实（permission.ts connection-owned + close 同步 deny）。准 accept，附 NF1 作为其前置步骤。
- **M4** — 我 agree，A1/A2 拆分正确。准 accept。
- **m1 / m3** — 我 agree（措辞严谨 / 安全护栏）。准 accept。

**仍需 author 仲裁的真分歧（非互相背拍，是判断分歧）**：
- **m2 — refine 分歧**：cross 暗含"§1 行业架构篇幅本身是过度设计隐患"；我 disagree-with-evidence（Phase 1 F5 验证 §1 是防过度设计的护栏，证据：提案 §5 Phase A "不做 seq/offset"、§6 I-3 已隔离）。**结论一致**（锁 Phase A 验收在 transcript reconciliation、Phase B 加硬 gate），但**根因定性分歧**：删 §1 篇幅（cross 倾向）vs 不动 §1、改 §5 Phase B 入口 gate（我）。需 author 裁决改哪里。
- **B1 enum 粒度**：`completed` 是否算协议增量——我主张走现有 SessionsAPI.transcript 不算新协议，cross 把 7 态打包成统一 reattach 回包（隐含全是新协议）。影响 ADR-lite 锁定范围大小，需 author 定。

**新增交 author 的 new-finding（两份 verdict 均未覆盖）**：
- **NF1**：close handler 同步 deny pending（permission.ts:32-35）是 M3 fix 的隐藏前置——必须先移除，否则 detach 瞬间语义已损。
- **NF2**：detached 窗口内"已授权工具的不可见执行"是 CLAUDE.md 不可逆硬触发，§6 无 invariant 覆盖——上位于 cross m3 的 fail-open 风险。
- **NF3**：M2 characterization test 缺"断线在 tool_use↔tool_result 之间"的 case。

**Phase 2 信号强度**：强（非全 agree——m2 一条 disagree-with-evidence + B1/m2 两处 refine，符合 SKILL "至少 1 条 disagree/refine" 硬约束；且包含一条对自己 Phase 1 的实质性自我修正 F1 MAJOR→BLOCKER + F4 部分撤回，异构 reviewer 在 B2 上正确穿透了我的盲区）。
