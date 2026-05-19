# Phase 3 Arbitration — IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL

> Author: claude (opus-4-7) · Date: 2026-05-19 · Inputs: phase1 arch + phase1 cross + phase2 react-arch + phase2 react-cross
> Mechanism: `.claude/skills/debate-review`. Matrix per finding: ✅ 接受 / ⚠️ 部分接受 / 🚫 反驳 / 🟡 用户决定.

## Convergence summary

Phase 2 produced **unusually strong bilateral convergence**. The heterogeneous (GPT-5.5) reviewer caught one genuine Claude collective blindspot (**B2** — the only 8-min bound is iOS-side `tickWatchdog()`; the backend has zero run TTL: confirmed by react-arch fact-check of `run-registry.ts` 48 lines / `index.ts` / `cli-runner.ts`). The arch reviewer honestly upgraded its own F1 MAJOR→BLOCKER and partially withdrew F4. No finding is bilaterally rejected. Genuine divergence = 2, both author-resolvable (identical conclusions, only edit-location differs).

## Judgment matrix

| # | Finding (source) | Bilateral state | Verdict | Action in v0.2 |
|---|---|---|---|---|
| B1 | Phase A "零协议改动" 不成立，需 reattach/inspect 契约 (cross BLOCKER ← arch F1 refine→升级) | agree | ✅ 接受 | Phase A 改"最小协议增量"：1 个入站 `reattach_run` + 1 个 run-status 回包 enum。`completed` 支复用现有 `SessionsAPI.transcript`（D2 裁决）。归类升 螺旋 + 1 条 ADR-lite 锁 reattach 契约。 |
| B2 | "复用 8min watchdog" 非服务端上界（那是 iOS `tickWatchdog`，backend 零 run TTL） (cross BLOCKER) | agree（异质抓盲区，arch 诚实承认） | ✅ 接受 | 删除"复用 8min"叙事。Phase A 必加 **backend-owned orphan manager**：detachedAt/lastActivityAt/sessionId/cwd/pending 状态 + hard TTL + telemetry(`run.detached`/`reattached`/`orphan_aborted`/`completed_detached`)；cleanup 复用 abort + `unregisterRun` + `unregisterPermission` + map 清理。 |
| M1=arch F2 | interrupt 与 ws.close 共用同一 abort，需状态机 + iOS interrupt() WS-down 分支变 bug | agree | ✅ 接受 | 加显式 run 状态机（`attached_running`/`detached_running`/`interrupting`/`completed_detached`/`expired`）+ 事件（`client_interrupt`/`ws_close`/`reattach`/`ttl_expired`/`process_exit`）；**仅 `client_interrupt` → abort**；`ws_close` 只 detach。新不变量 I-8。iOS interrupt() WS-down 分支：reconnect/reattach 必须带 `pendingInterruptRunIds` 或提供独立 HTTP interrupt endpoint（非仅内存排队）。 |
| M2=arch F1 前半 | jsonl 无 terminal marker，session_ended 仅活在 WS 流，transcript 是 content-only | agree | ✅ 接受 | 明确 transcript=内容源、**非** liveness/terminal oracle；server(runs map + 新增 terminal record) 是 liveness oracle。加 characterization test 作 Phase A1 验收 gate（直连 vs 后台断连对比 ChatLine[]/末 assistant/sessionId/busy；含"断线落在 tool_use↔tool_result 之间"case — arch NF3）。 |
| M3 | pending permission registry 是 connection-owned，close 时同步 resolve("deny") 并 delete | agree | ✅ 接受 | pending registry 改 **run-owned**；reattach 重投 pending request 给新连接；定义 close 时保留 permission/timeout 策略。**前置**：移除 close 时同步 deny（arch NF1，否则 detach 瞬间伪造 deny 污染执行轨迹）。 |
| M4 | Phase C "前置 gate" vs "可并行" 矛盾 | agree | ✅ 接受 | 拆分：**Phase A1**=普通长回合完成态恢复（可单独 ship，不覆盖 paused-on-choice）；**Phase A2+C**=pending permission/workflow re-surface + 选择 UI。Phase C 仅对 paused-on-choice 是 gate，非 A1 前置。 |
| m1 | "100% 排除网络/Tailscale" 措辞过强 | agree | ✅ 接受 | §0 改"该样本中前台无网络失败，主因高度确定为 iOS 后台挂起；网络抖动非本样本解释"。 |
| m3 + arch NF2-sec | detached + permission fail-open = 无人值守自动放行风险 | agree | ✅ 接受 | 新安全不变量 I-9：detached 态遇新 permission request 默认**暂停等 reattach，不 fail-open allow**；保留 fail-open 必须显式记风险 + telemetry。 |
| NF1 (both) | runs map 清理后需短期 backend terminal-state record | agree | ✅ 接受 | orphan manager 含 process exit 后短期 terminal record（`completed|interrupted|error|expired`+endedAt+sessionId+cwd），否则 iOS 无法区分 completed/reaped/crash/重启丢状态。 |
| NF2 (both) | feature flag 需 + client capability 协商（非全局开关） | agree | ✅ 接受 | `VESSEL_RUN_SURVIVES_DISCONNECT` 默认 OFF + **client capability 双门控**：仅声明支持 reattach 的新 iOS 启用 survive-disconnect；旧客户端走 close-abort 或短 TTL detached（防 UI↔transcript 语义分裂）。rollback=env flip 无需 redeploy。 |
| arch NF2 (tool) | detached 窗口已授权工具不可见执行 = CLAUDE.md 不可逆硬触发 | agree | ✅ 接受 | 新不变量 I-10：detached 期间已 allow 工具继续执行须 `run.detached.tool_exec` telemetry + reattach 回放；与 I-9 共同覆盖断线工具风险。 |
| D1: m2 改哪里 | 删 §1 篇幅(cross 暗含) vs 不动 §1 + §5 Phase B 入口加硬 gate(arch F5 有证据) | 结论一致，位置分歧 | ⚠️ 部分接受（采 arch） | **保留 §1**（arch F5 实证：§1 是防过度设计护栏，§5 已显式隔离 buffer 进 Phase B）；改 §5 Phase B 开头加硬 gate"仅 A1 characterization test 通过且用户明确要无缝 token 流才启动"。理由：删 §1 丢失"从轻到重"对比上下文，且 reviewer 评审需要它；实质结论(Phase B 非前置/按需)不变。 |
| D2: B1 enum 粒度 | `completed` 走现有 SessionsAPI 是否算新协议 | 影响 ADR-lite 范围 | ⚠️ 部分接受（裁决） | 最小契约 = 1 个新入站 `reattach_run` + 1 个 status 回包；`completed` 支随后复用**现有** transcript endpoint（无新 server→client 消息）。ADR-lite 锁定范围 = 仅 `reattach_run` 消息 + status enum。 |

🚫 反驳：无。
🟡 用户决定：见下（评审本身不产生新的用户决策；保留 v0.1 的原始 scope 问题，按收敛后重述，≤3）。

## 🟡 待用户决定（≤3，scope/milestone/risk 偏好，非作者可自决）

1. **范围**（milestone 取舍）：A1(止血，独立可 ship) 单做 → A2(pending 重投) → 还是要不要 B(mid-stream 无缝 token 流，需升 contract+ADR)？两位 reviewer 都建议 B 仅按需、非止血必需。
2. **Phase C 折叠**（scope）：A2+C(选择 UI 补全) 并入本工作，还是作为紧邻的独立切片单独跟踪（A1 明确标注"paused-on-choice 暂不覆盖"）？
3. **orphan TTL 取值**（risk 偏好）：无客户端的 detached run 最长占用多少 Mac compute 才回收（长回合本身合法跑 5-10min；waiting_permission 应更短 TTL）？

## 收敛判断

v0.2 应用全部 ✅ + ⚠️ 后：2 个 BLOCKER(B1/B2) 经重设计消解（reattach 契约 + backend orphan manager），未引入新 BLOCKER。剩余仅 3 条真·用户偏好决策（≤3，属 escalation 合法类别）。→ **收敛**。

**Status 升级提示**：v0.2 加入 `reattach_run` wire 协议增量 → Phase A1 实施必须走 **contract mode + ADR-lite** 锁定该契约（CLAUDE.md 阶梯层：wire protocol 靠 ADR-lite + cross review 锁定）。本 proposal 收敛即触发该升级，非绕过。
