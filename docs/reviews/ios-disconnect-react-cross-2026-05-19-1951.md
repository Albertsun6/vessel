Backlog: 0 in_progress · 0 planned · 4 blocked

# Phase 2 React — cross-correctness lens
> Reviewer: vessel-cross-reviewer · Date: 2026-05-19 · Phase 2 (cross-pollinate)

## 对 arch verdict 的逐条表态

### F1 — refine
**对方原文**: “server is the run-liveness oracle, transcript is content-only.”  
**我的表态**: refine  
**理由**: 同意 transcript 没有 terminal marker，arch 的 fact-check 强化了我的 M2，也解释了为什么单靠 jsonl 不能清 busy。但这没有完全消解我的 B1。arch 说“needs zero protocol change — it's a reconnect handshake on the existing WS”，这里仍缺一个明确 client→server 查询/重挂契约。只要 iOS 需要问“runId 还活着吗 / 已完成原因是什么 / 是否 waiting permission”，就必须定义消息或 HTTP endpoint，以及返回状态。  
**新建议**: 保留 Phase A 为“最小协议增量”，不升级到 Phase B 的 seq-buffer，但必须写清：
- `run_liveness/reattach` 请求入口
- 返回 `running | completed | failed | aborted | expired | waiting_permission | waiting_workflow_choice`
- backend 在 process exit 后短暂保留 terminal record，否则 `runs` map gone 后仍无法区分 completed / expired / crash

### F2 — refine
**对方原文**: “用户 Stop 必须真停.”  
**我的表态**: refine  
**理由**: 同意，而且 arch 补到了我 Phase 1 没点透的 iOS 侧具体风险：`BackendClient.interrupt()` 在 WS down 时现在只本地 `forceClearRun`，因为它假设 backend 已随 close abort。Phase A 改掉 close-abort 后，这个分支会变成真实 bug。  
**新建议**: 不只写“pending-interrupt 重连后下发”，还应定义失败边界：如果 app 被杀无法重连，server orphan reaper 是最后上界；如果用户主动 Stop 时 WS 已断，下一次 reconnect/reattach 请求必须携带 `pendingInterruptRunIds` 或提供独立 HTTP interrupt endpoint，避免只是 iOS 内存里排队。

### F3 — refine
**对方原文**: “Phase A genuinely touches none of these wire/schema/migration anchors.”  
**我的表态**: refine  
**理由**: 同意 Phase A 不应被强行升成 Phase B/contract，也同意需要 anchor-gate sanity pass。但 arch 对 old-client compat 的风险说得偏轻。旧 iOS 仍会 `clearStuckRunsAfterReconnect`，backend 却继续跑 detached run，这不只是“wasted compute until reap”：如果 run 最终写入 transcript，用户可能之后在历史里看到一个自己 UI 已标记中断的完成结果，形成状态语义不一致。  
**新建议**: Phase A 增加 compat 策略：feature flag 默认 OFF，只有新 iOS 通过 handshake/版本能力声明后，backend 才对该连接启用 survive-disconnect；旧客户端继续 close-abort 或至少进入短 TTL detached。

### F4 — agree
**对方原文**: “2 of 3 user decisions are author-resolvable.”  
**我的表态**: agree  
**理由**: 与我的 B2/F1 方向收敛。§8.1 不是用户拍板项，因为“8min watchdog”必须先被改写成 backend-owned orphan manager 和 terminal-state record；用户不该决定一个还没定义清楚的资源边界。真正给用户的只应是 A vs A+B、Phase C 是否并入本工作。

### F5 — refine
**对方原文**: “Author must NOT let Phase 2/3 talk them into starting from Phase B.”  
**我的表态**: refine  
**理由**: 同意不要从 Phase B 开始，这也强化了我的 m2：seq-buffer 是按需能力，不是止血必需品。但 F5 说 “C as a gate for A/B value” 仍需要拆细。Phase C 对 paused-on-choice 场景是 gate；对普通长回合完成态恢复不是 gate。  
**新建议**: 文档改成 Phase A1 “普通长回合完成态恢复”可单独 ship；Phase A2/C “pending permission / workflow choice re-surface + UI”覆盖暂停类 run。不要让 Phase C 把 Phase A1 的止血拖大。

## 我自己 Phase 1 verdict 的自我修正

- **B1 保持 BLOCKER，但收窄表述**：不应说 Phase A 必然需要大 wire 协议改造；它需要“最小 reattach/inspect 契约”。这可以是 WS message 或 HTTP endpoint，不等于 Phase B 的 seq/offset buffer。
- **B2 保持 BLOCKER，并被 arch F1/F3 间接加强**：arch 也承认 §8.1 不能靠现有 8min watchdog；但它没有明确指出现有 8min 是 iOS-side `tickWatchdog`，不是 backend bound。这个点仍需 author 修。
- **M1 保持，合并 arch F2 的 iOS interrupt 分支**：OQ1 应从 open question 升为 Phase A 必改项，尤其是 WS-down Stop 语义。
- **M2 升强**：arch 的 cli-runner/jsonl fact-check 证明 transcript 是 content-only，且没有 terminal marker。我的 M2 不撤回，反而应并入 B1 的设计依据。
- **M3 保持**：pending permission/workflow 必须 run-owned，不能 connection-owned；arch F2/F5 没覆盖这个存储细节。
- **M4 保持但改写**：Phase C 不是整个 Phase A 的前置 gate，而是 paused-on-choice 恢复的前置 gate。
- **m2 保持并加强**：arch F5 与我一致，Phase B 不能前置。
- **m1、m3 保持**：没有新证据要求撤回。

## 新发现 (new-finding)

### NF1 [MAJOR] terminal-state record 不能只靠 `runs` map 当前存在
arch F1 提出 backend 是 liveness oracle，但如果 process 已退出并从 `runs` map 清理，backend 还需要短期保留 terminal record：`completed | interrupted | error | expired`、`endedAt`、`sessionId`、`cwd`。否则 iOS 重连时看到“run 不在 map”仍只能猜是正常完成、被 reaper abort、backend 重启丢状态，还是 crash。

### NF2 [MAJOR] feature flag 需要能力协商，不只是全局开关
arch F3 提到 rollback flag；结合旧 iOS 兼容，建议 flag + client capability 双门控。只有新 iOS 宣告支持 reattach/inspect 时，backend 才启用 survive-disconnect。否则旧客户端会本地 force-clear，而 backend 继续跑，造成 UI 与 transcript 语义分裂。

## 收敛信号小结

准 accept：
- transcript 是内容源，不是 terminal-state/liveness oracle。
- Phase A 必须有 backend-owned orphan manager，不能复用 iOS 8min watchdog。
- 用户 Stop 与 ws.close 必须语义分离。
- §8.1 应从用户决策移回作者设计。
- Phase B 不应前置，seq-buffer 只按需做。

需要 author 仲裁：
- Phase A 是否仍可称“零协议改动”。我的判断：不能；应改成“最小 reattach/inspect 契约，无 seq-buffer”。
- Phase C 是否并入本工作。我的建议：A1 先止血可单独 ship；A2/C 覆盖 paused-on-choice，作为独立但紧邻的切片。
