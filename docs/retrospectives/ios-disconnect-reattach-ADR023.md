# iOS 断线 → Run 存活与重挂 (ADR-023) — Spiral Retrospective

**Date**: 2026-05-19
**Phase**: 用户报障驱动的完整一圈（proposal → contract → ADR-lite → patch → dogfood）
**Round risk addressed**: iOS 等待长回合时切后台/锁屏 → iOS 挂起 WS → 后端把"连接断"当"用户中止"杀回合 → 重连丢答案
**Exit**: **ship-pending** — 代码合入安全（`VESSEL_RUN_SURVIVES_DISCONNECT` 默认 OFF = 行为逐字节不变），翻 flag 前还差 2 项真 e2e 门禁
**Branch**: `feat/eva-ios-reattach`（隔离 worktree，7 commit，未 push）
**Related artifacts**:
- `docs/proposals/IOS_BACKGROUND_DISCONNECT_RUN_SURVIVAL.md` (v0.2 收敛)
- `docs/contracts/IOS_DISCONNECT_REATTACH_CONTRACT.md` (v0.2 收敛)
- `docs/adr/vessel/ADR-023-ios-disconnect-reattach-contract.md`
- `docs/reviews/ios-disconnect-*` + `docs/reviews/contract-reattach-*`（phase1/2/3 × 2 轮）
- `packages/backend/src/{run-registry,index,routes/permission}.ts`
- `packages/ios-native/Sources/ClaudeWeb/{Protocol,BackendClient}.swift` + Views/{PermissionSheet,WorkflowChoiceSheet}
- `packages/backend/src/test-adr023-reattach.ts`（dogfood #2/#3/#5）

---

## 一句话本圈风险

"把'连接=回合生命周期'解耦成'连接断只 detach、回合服务端存活可重挂'，且不引入无界 orphan、不在断线期扩大 permission fail-open、旧 iOS 逐字节不变——全程靠 wire 契约 + ADR 锁死，不允许先做一版试试。"

## 时间线

| 阶段 | 产出 | 关键事件 |
|---|---|---|
| 诊断 | telemetry + 代码双证据 | 前台从无 ws abort；100% `app.background` 后 2-6min `Software caused connection abort` |
| proposal | v0.1→v0.2 收敛 | phase1+2+3；**异质 reviewer (GPT-5.5) 抓集体盲区#1**：v0.1 "复用 8min watchdog 当资源上界" 错——那 8min 在 iOS `tickWatchdog`，挂起时不跑，后端零 run TTL |
| contract | v0.1→v0.2 收敛 | **异质 reviewer 抓集体盲区#2**：v0.1 C2 `running` 空心——onMessage 闭包捕获死连接 send，reattach 后续消息到不了新连接。Claude arch reviewer 诚实自升 F1/F3 MAJOR→BLOCKER + 新增 F8 |
| ADR-023 | ledger 登记 | arch 干净纠错 ADR-025 不存在（编号源是 `docs/adr/README.md` 非 `ls vessel/`），改 ADR-023 |
| patch | S1-S8 + 7 commit | run-registry 重写为 run-owned 可重绑 sink + 状态机 + reaper；permission 生命周期单一 owner；iOS reattach + 选择 UI 补全 |
| dogfood | #1/#2/#3/#5/#6 + iOS build | shared 154 测试、in-process 安全/sink/状态机/reaper-TTL ~28 断言、静态 I-12/13/14、iOS xcodebuild SUCCEEDED |

## 学到什么（可复用）

1. **异质评审是独立性的 floor，两轮都兑现。** 双 Claude reviewer 两次都会一起漏掉"8min 在哪端跑""闭包捕获哪个 send"这类事实——cursor-agent GPT-5.5 各一秒命中。证据再次支持 ADR-017。
2. **"零协议改动"是危险的自我安慰。** proposal v0.1 声称 Phase A 零 wire 改动，contract 阶段被证伪：只要客户端要问"run 还活着吗/什么状态"，就必然有新 client→server 契约。歧义降级（proposal 起步、contract 升级）这条 skill 规则救了场。
3. **并行多 agent 会污染当前 checkout 分支。** Steward worker 把 `feat(steward)` commit 进了主 checkout 的 docs 分支。教训已沉淀到记忆 [[feedback_parallel_worker_branch_hygiene]]：长文档/实施工作用隔离 `git worktree`，commit 前必查 `git log main..HEAD`，别 rebase 别人的真实工作。
4. **把时间相关的承重逻辑抽成纯函数。** reaper TTL（B2 BLOCKER 的资源安全核心）原是 setInterval 内联，不可单元测；抽成 `reapDecision(run, now)` 后注入 `now` 即可确定性覆盖全部 TTL 边界，无需 600s 真等待，也不在生产加 time-seam。
5. **contract mode 的 dogfood 分两层是对的。** 形状/逻辑层（round-trip、in-process 安全、sink rebind、状态机、reaper-TTL）能在单元关掉；characterization（真 CLI transcript 三场景）+ ios-sim-e2e 是真 e2e，诚实标注留作 patch/flag-flip 门禁，不假装收敛。
6. **cursor-agent 调用语法漂移。** skill 文档的 `-p file` 已过时（现 `-p`=`--print` 布尔），prompt 是位置参数，以 `---` 开头要 `--` 终止符 + `--trust`。已沉淀 [[reference_cursor_agent_invocation]]，两个 review skill 文档待修（未擅自改）。

## 仍未关闭（诚实）

- **#4 characterization** — 真起 backend + 真跑一次 `claude`，断线中途 → 重连 → 对比 transcript `ChatLine[]`/末 assistant/sessionId/busy 三场景一致。需活环境 + 耗订阅额度，contract §11/§12 本就定为 patch/e2e 门禁。
- **ios-sim-e2e** — 翻 `VESSEL_RUN_SURVIVES_DISCONNECT=1` 灰度前的行为门禁，专用 skill，需模拟器。
- **push / 开 PR-A/PR-B** — CLAUDE.md `feat/*`→PR 到 `dev` + branch protection，需用户明确授权。

## ship / drop / defer

- **ship**（合入，flag OFF）：S1-S8 + dogfood 全部单元可达门禁通过，零行为变更零风险——可随时合。
- **defer**（翻 flag 前）：#4 characterization + ios-sim-e2e 必须先过。
- **drop**：无。Phase B（seq-buffer mid-stream）按 proposal 仍是按需，未做也不欠。
