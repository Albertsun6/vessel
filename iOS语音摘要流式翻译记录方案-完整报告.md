# iOS 语音摘要流式翻译记录方案

> 调研日期：2026-05-19
> 研究问题：在 Vessel iOS app（Swift/AVFoundation + Node.js Hono + Whisper ASR）的摘要模式中，如何加入「边转写边翻译 + 会话级持久化记录」？

---

## 研究问题

在现有 30s 切段摘要模式架构上，以最小改动实现：
1. 每段转写完立即触发翻译（非等全程结束后）
2. 翻译结果实时展示到 iOS 端
3. 会话级完整记录（原文段 + 译文段 + 最终总结）

> ⚠️ **MVP 边界说明**：本方案是 **chunk-level MVP**，翻译延迟 = 30s 切段间隔 + 后端翻译时间（通常 1-3s/段）。这不是 <1s 的真正实时流式翻译。如需 <5s 首字延迟的真正 streaming，需改用 AVAudioEngine 连续音频流 + 后端 streaming ASR（更大改动，超出本次调研范围）。

---

## 评估维度

- **D1** 流式翻译传输层（延迟、后端改动量、iOS 复杂度）
- **D2** 转写-翻译对齐（乱序稳定性、实现复杂度、与现有 chunk 兼容）
- **D3** 持久化记录（原子写、崩溃安全、检索能力、改动量）
- **D4** iOS 流式消费（框架原生支持程度）
- **D5** 同类产品参考（SimulStreaming / Zoom / Otter / WhisperLiveKit）

---

## 方案对比

### D1 流式翻译传输层

| 方案 | 延迟 | 后端改动 | iOS 客户端 | 双向控制 | 综合 |
|---|---|---|---|---|---|
| **WebSocket（复用现有 WS）** | 低 ✓ | 极低（扩展已有通道）✓ | 低（BackendClient 已有）✓ | 有 ✓ | **4.5 ✓** |
| SSE（Hono streamSSE）| 中 | 极低（Hono 内置）| 低（URLSession AsyncBytes）| 无 | 3.5 |
| chunked JSON（HTTP）| 高 | 低 | 中（需手动分包）| 无 | 2.0 |

推荐：**复用现有 WS 通道**——Vessel 已有完整 BackendClient + runIdToConversation 路由；新增 `translationDelta` message type，改动量极低，同时保留双向控制（可取消翻译）。

### D2 转写-翻译对齐

| 方案 | 乱序稳定性 | 复杂度 | 与现有 chunk 兼容 | 综合 |
|---|---|---|---|---|
| **segmentId + startMs/endMs 双锚点** | 高 ✓ | 中 | 高 ✓（复用 nextChunkIndex）| **4.5 ✓** |
| LocalAgreement（连续 2 次前缀一致才 commit）| 高 | 高（需改 ASR 推理层）| 低 | 3.0 |
| 整块 commit 后翻译（现有方案）| 高 | 低 ✓ | 完全兼容 ✓ | 2.5（延迟高）|

推荐：**segmentId + 时间戳双锚点**。现有 `nextChunkIndex` 直接作为 segmentId；每个 chunk 转写完立即异步触发翻译，携带 `{segmentId, text, startMs, endMs}`；iOS 维护 `translationBySegmentId` sparse dict，按 segmentId 插入，乱序到达时已确认段保持稳定。

### D3 持久化记录

| 方案 | 原子写 | 崩溃安全 | 检索 | 改动量 | 综合 |
|---|---|---|---|---|---|
| **JSONL per-session 扩展** | append | 高 ✓（与现有 .jsonl 一致）| 无 | 极低 ✓ | **4.0 ✓** |
| SQLite WAL + GRDB.swift | 高 ✓ | 高 ✓ | 高 ✓ | 中 | 4.0 |
| Core Data | 高 | 中 | 高 | 高 | 2.0 |

推荐：**阶段一用 JSONL 扩展**（零新依赖，与现有 Cache.swift 存储模式完全一致）；若后续需跨会话全文检索，再迁 SQLite GRDB。每行格式：`{type: "segment"|"translation"|"summary", segmentId, startMs, endMs, text, lang, timestamp}`。

### D4 iOS 流式消费

由于方案 D1 推荐复用 WS，iOS 侧是在现有 WS message handler 中新增 `translationDelta` case 处理，直接驱动 SwiftUI `@Published translationBySegmentId` 更新——比引入 URLSession SSE 更直接。

若未来改 SSE 路径：`URLSession.shared.bytes(from: url)` 的 `AsyncBytes.lines`（iOS 15+，注意方法签名是 `bytes(from:delegate:)` 而非 `bytes(for:)`），配合 `@MainActor` 驱动 SwiftUI 更新。

### D5 同类产品参考

| 产品 | 架构要点 | 对本项目启发 |
|---|---|---|
| **SimulStreaming（UFAL 2025）** | Whisper STT + LLM 翻译，JSONL 输出 `text`（已确认段）+ `unconfirmed_text`（预测段）| confirmed/unconfirmed 双态 UI 设计（稳定文字 + 预览文字）可借鉴；⚠️ 仅非商业使用 |
| **WhisperLiveKit（2025）** | AlignAtt + NLLW（NLLB 蒸馏）同步翻译，WebSocket | 生产可用参考；⚠️ translation API 仍 in development，近期多处 bugfix |
| **Zoom Video SDK** | `caption-message` 实时下发转写/译文事件 | 产品层面保存「原文+译文+时间轴」是行业标准 |
| **Otter.ai** | 实时转写 + 摘要 + 搜索 + 导出 | 会话级完整记录（含可搜索原文）是核心差异化 |

---

## 推荐

**结论**：在现有 30s 切段架构上做最小改动，加入「每段转写完即异步触发文本翻译 + segmentId 对齐 + JSONL 扩展记录」，通过现有 WS 通道下发翻译结果。

**理由**：
1. WS 通道已存在（BackendClient、runIdToConversation routing 全部可复用），无需引入 SSE 端点
2. 30s chunk 提供天然 segment 边界，segmentId 直接复用 `nextChunkIndex`，对齐逻辑简单可靠
3. JSONL 扩展与现有 Cache.swift 完全兼容，零新依赖
4. 翻译 API：推荐接**文本翻译模型**（如 OpenAI gpt-4o mini translate endpoint 或本地 NLLB-200 蒸馏版）；注意区分：OpenAI Realtime Translation（`gpt-realtime-translate`，$0.034/min）是音频进/音频+译文出，会绕过现有 Whisper ASR 链路，不适合本方案

**适用条件**：
- 适用：用户可接受"每 30s 看到一段新翻译"的体验
- 不适用：要求 <5s 流式翻译首字延迟 → 需改 AVAudioEngine + 后端 streaming ASR（更大改动）

**置信度**：高（≥14 个独立 source，含 2025/2026 primary source）

---

## 待验证风险

- [ ] **翻译 API 成本实测**：OpenAI Realtime Translation $0.034/min 已公开，但若走文本翻译（gpt-4o-mini）则需估算 30s 中文 chunk 的 token 数 × 单价；NLLB 本地部署在 iPhone 上的内存/速度未实测
- [ ] **翻译延迟实测**：AssemblyAI/Deepgram 厂商自述 150-250ms 为低置信数据；实测 gpt-4o-mini 对 200-400 字中文 chunk 的翻译 RTT
- [ ] **SimulStreaming license**：Noncommercial Oct 2025 release — 只借鉴架构思路，不直接复制代码；若复制代码需锁定具体 tag + 遵守 noncommercial 限制
- [ ] **WhisperLiveKit translation 稳定性**：translation backend (NLLW) API 仍 in development，近期有多处翻译/VRAM bugfix，不建议直接依赖其 API 接口
- [ ] **AVAudioEngine 升级路径**：当前 AVAudioRecorder 切段方案有 ~50ms gap；若未来需要真正流式则需迁到 AVAudioEngine，评估改动量
- [ ] **URLSession bytes 方法签名**：实测确认使用 `bytes(from:delegate:)` 而非 `bytes(for:)` 以避免编译错误

---

## 主要来源

| 来源 | 置信度 | 支持点 |
|---|---|---|
| [SimulStreaming（UFAL 2025）](https://github.com/ufal/SimulStreaming) | 高 | confirmed/unconfirmed JSONL 字段设计；chunk 对齐策略 |
| [WhisperLiveKit（2025）](https://github.com/QuentinFuxa/WhisperLiveKit) | 高 | 生产级 streaming 翻译参考实现 |
| [arxiv 2508.13358（2025）](https://arxiv.org/html/2508.13358v1) | 高 | PARTIAL/FINAL 双假设；延迟数据（AL 2.74s vs 4.39s） |
| [Hono streaming 文档](https://hono.dev/docs/helpers/streaming) | 高 | `streamSSE()` / `stream()` 后端实现 |
| [Apple URLSession AsyncBytes](https://developer.apple.com/documentation/foundation/urlsession) | 高 | iOS 流式消费原生支持（`bytes(from:delegate:)`） |
| [SQLite WAL 官方文档](https://www.sqlite.org/wal.html) | 高 | 原子提交 + 读写并发 |
| [GRDB.swift](https://github.com/groue/GRDB.swift) | 高 | iOS SQLite Codable/Record/迁移/观察（备选方案） |
| [Zoom Video SDK transcription](https://developers.zoom.us/docs/video-sdk/web/transcription-translation.md) | 高 | 产品级「原文+译文+时间轴」参考 |
| [OpenAI Realtime Translation docs](https://developers.openai.com/api/docs/guides/realtime-translation) | 高 | 架构区分：Realtime Translation ≠ 文本翻译；$0.034/min |
| [Deepgram Nova-3（2025）](https://developers.deepgram.com/changelog/2025/2/12.md) | 中（vendor）| word-level timestamp 对齐参考；延迟数据低置信 |
| [arxiv 2506.17077](https://arxiv.org/html/2506.17077) | 高 | 真正 streaming 的延迟 regime（2-5s vs 30s chunk）|

---

## 调研 Metadata

- **Phase 6 异构终审 verdict**: Refine（3 条全部 accept，Round 1 收敛）
- **辩论收敛**: Round 1 全 accept → 直接 finalize
- **人类介入**: 无
- **Output**: /Users/yongqian/Desktop/Vessel/iOS语音摘要流式翻译记录方案-完整报告.md
- **HTML**: /Users/yongqian/Desktop/Vessel/iOS语音摘要流式翻译记录方案-完整报告.html
- **Audio**: /Users/yongqian/Desktop/Vessel/iOS语音摘要流式翻译记录方案-音频概要.m4a

#### Phase 2.5 Reflection
- 子问题覆盖率：Q1-Q5 全部覆盖 ✓
- 独立来源数：每个关键 claim ≥2 独立 domain ✓
- Vendor-claim 依赖：AssemblyAI/Deepgram 延迟数据已标记低置信
- Source 质量分布：High ~65%，Low ~0% ✓
- 追搜决策：No

#### Phase 5.5 Citation Health
**Layer A**: 25 URLs | 22 ok (88%) | 0 wayback | 1 blocked | 2 dead (8%) → PASS
（dead 1: Apple URL 脚本截断误判；dead 2: openai.com bot 保护 / content 已由 Agent X 验证）
**Layer B**: 5 sampled | 2 supported | 2 partial | 1 not-supported (20%) → PASS（边界）
**已修正**: SimulStreaming 字段 `confirmed_text` → `text`；URLSession 方法签名 `bytes(for:)` → `bytes(from:delegate:)`
**Verdict**: PASS

#### Phase 6 辩论历史

##### Round 1：主 agent 判断矩阵
| 建议 | 立场 | 论据 |
|---|---|---|
| "实时流式转写"降格为 chunk-level MVP，区分 30s chunk 路径 vs 真正 <5s streaming 路径 | accept | arxiv 2506.17077 确认 2-5s 级才是 streaming regime；已在报告中加 MVP 边界说明 |
| OpenAI Realtime Translation 价格已公开 ($0.034/min)，架构上是音频进/译文出，会绕过现有 Whisper 链路 | accept | openai.com 官方文档确认架构区分；已在推荐和风险中明确 "Realtime Translation ≠ 文本翻译" |
| SimulStreaming Noncommercial license + WhisperLiveKit translation API 仍 in development | accept | github.com/ufal/SimulStreaming/releases 确认；已加 ⚠️ 标注和待验证风险 |
