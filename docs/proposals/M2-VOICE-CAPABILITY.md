# M2-Voice Capability — 统一 ASR Provider 链选型与云端部署策略

**Status**: ACCEPTED & IMPLEMENTED（PR #91 已合入 main `134bf9c`，2026-05-19）
**Author**: Claude Opus 4.7 (1M context)
**Date**: 2026-05-19
**Trigger**: backlog `m2-voice-proposal` (P2)。用户提出"以后服务端要部署到云端 Linux 服务器"+ 质疑现有本地 whisper 单点方案，引出 ASR provider 横向调研。调研推翻了"讯飞中文最准所以应默认讯飞"的初始假设。
**Supersedes**: 无（ADR-012 §2 "ASR 沿用 Eva voice routes spawn whisper-cli" 仍成立，本文档在其骨架内做螺旋层 provider 抽象）

---

## 1. Context

ADR-012 §2 锁定 ASR 走 subprocess 边界（whisper-cli spawn），生产已验证（真机 round-trip ≤ 8s 达标，backlog `voice-roundtrip-measure` done）。但当前实现有两个螺旋层痛点：

1. **单点 + 冷启动**：每次转录 `spawn whisper-cli`，冷加载 ~500MB 模型，每次 2-4s 纯模型加载浪费
2. **云端不可行**：用户计划把 backend 部署到云端 Linux。无 Apple Silicon Metal 加速时，CPU 跑 whisper-large 实测 25-40s/次，完全不可用；带 NVIDIA GPU 的云实例成本高

本文档沉淀 provider 选型的**完整实测数据**，防止后人重复踩"讯飞中文最准 → 默认讯飞"这个坑。

## 2. Decision

引入**统一 ASR Provider 抽象 + 自动降级链**，优先级 `groq → iflytek → whisper-cpp`：

| 顺序 | Provider | 模型 | 稳态延迟 | 角色 |
|---|---|---|---|---|
| 1 | **Groq** | `whisper-large-v3` | **~0.8s** | 主力（最快 + 最准）|
| 2 | 讯飞 IAT 语音听写 | 流式大模型 | ~8s | Groq 不可达时的中国区兜底 |
| 3 | whisper-cpp 本地 | ggml-large-v3-turbo | ~5s 冷启动 | 完全离线最后兜底 |

任一 provider 抛错自动落下一个；`/api/voice/transcribe` 响应新增 `provider` 字段标明本次实际使用者。配置全走 `.env`（`GROQ_API_KEY` / `IFLYTEK_*` / `ASR_PROVIDER` / `GROQ_MODEL`），无 key 时静默跳过该 provider。

接口契约不变（iOS app 无需改动），只增量加 `provider` 响应字段。

## 3. 实测对比（同一段中文音频，本机 2026-05-19）

| Provider | 延迟（稳态）| 冷启动 | 中文准确率 | 中英混排 | 架构 |
|---|---|---|---|---|---|
| **Groq whisper-large-v3** | **~0.8s** | ~4.9s（仅 backend 重启后首次）| ✅ 优秀 | ✅ `TypeScript` 正确大写 | 整文件一次批量处理 |
| 讯飞 IAT 语音听写 | **~8s** | — | ✅ 正确 | ⚠️ `typescript` 小写 | 实时流式（必须按真实语速发）|
| whisper-cpp 本地 | ~5s | 每次都冷启动 | ✅ 优秀 | ✅ 正确 | 每请求 spawn + 加载模型 |

关键发现：**讯飞并不比 Groq 准**（两家中文都对，Groq 中英混排反而更好），且**慢约 10 倍**。最初"默认讯飞"的前提（讯飞中文最准）实测不成立。

## 4. 讯飞产品线为何全部不适配"短语音命令低延迟"

逐一验证（实测 + 官方文档），讯飞**没有**适合交互式短语音的接口：

| 讯飞产品 | 架构 | 短语音延迟 | 排除原因 |
|---|---|---|---|
| 语音听写 IAT（`/v2/iat`）| 实时流式 WebSocket | ~8s | 延迟 ≈ 音频时长 + 3-4s。必须按真实语速流式发（4.4s 音频就得发 4.4s），发快了触发**服务端流控**反而更慢（实测 10ms→10s+、20ms→4s、40ms→8s，方差极大）|
| 极速录音转写大模型 | 异步批处理 + 轮询 | **~20s** | [官方文档](https://www.xfyun.cn/doc/asr/speedTranscription/API.html)原文："如果很短的音频，考虑到系统调度等因素，也要 20 秒左右"。"极速"指**长音频吞吐**（1h 音频 1min 转完），非交互延迟。上传→创建任务→轮询（建议 30s/次）→取结果 |
| 实时语音转写 RTASR（`/v2/rtasr`）| 实时流式 | 同 IAT | 一样的流式开销 |
| 离线语音听写 | 本地 SDK | — | 要下 SDK 本地跑，不是云 API；和 whisper-cpp 同类（本地方案 whisper 已更优）|

**根因**：讯飞产品线定位是「实时听写」（边说边出字，流式开销 = 至少音频时长）或「批量转写」（长录音吞吐，调度开销 ~20s）。两端都不为"短语音命令的端到端低延迟"优化。这是产品定位决定的，不是配置/调参能解决的。

讯飞 IAT 仍保留作兜底的理由：Groq 不可达时（如未来中国区云部署 Groq 被墙），~8s 仍优于本地 whisper 5s 冷启动 + 云端无 GPU 的不可用。

## 5. 云端 Linux 部署策略（用户原始动机）

| 部署形态 | 推荐主力 | 理由 |
|---|---|---|
| **Mac 本地开发**（现状）| Groq | ~0.8s 远优于本地 whisper 5s 冷启动；零基础设施 |
| **云端 Linux + 无 GPU**（最低成本 VPS）| Groq | 唯一可行——本地 whisper CPU 25-40s 不可用；讯飞兜底 |
| **云端 Linux + GPU**（如 A10G ~$0.6/h）| 未来可加 `faster-whisper` HTTP server client | CTranslate2 int8 + CUDA ~1.5s，0 API 成本，自托管 |
| **中国区云部署**（Groq 可能被墙）| 讯飞 IAT 升主力 | `ASR_PROVIDER=iflytek` 一行切换；接受 ~8s |

当前抽象已为以上所有形态预留：换 provider = 改 `.env` 一行，无需改代码。未来 GPU 自托管只需新增一个实现 `AsrClient` 接口的 `FasterWhisperClient`。

## 6. 实现（已 ship）

`packages/backend/src/asr/`：

| 文件 | 职责 |
|---|---|
| `types.ts` | `AsrClient` 接口（`transcribe(wavBuffer, opts) → Promise<string>`）|
| `whisper-cpp.ts` | 本地 whisper-cli（原 voice.ts 逻辑提取，保留模型解析优先级）|
| `groq.ts` | Groq OpenAI 兼容 `/audio/transcriptions`，默认 `whisper-large-v3`，`GROQ_MODEL` 可覆盖 |
| `iflytek.ts` | 讯飞 IAT WebSocket，HMAC-SHA256 签名 + PCM 分块流式（40ms 实时速率避免流控；去 `wpgs` 防中间结果叠加；`ptt:1` 带标点）|
| `index.ts` | 工厂（按 env 构链）+ `transcribeWithFallback`（顺序 try，记录失败原因）|

`voice.ts /transcribe` ffmpeg 预处理不变（16kHz mono WAV），改为把 WAV buffer 喂给链；whisper 幻听尾巴剥离仅对 `whisper-cpp` provider 生效（Groq/讯飞不产生 YouTube 水印）。

## 7. Alternatives Considered

- **A. 保持本地 whisper 单点**——❌ 云端无 GPU 不可用（25-40s），冷启动每次 2-4s 浪费
- **B. 升级本地 whisper 为 persistent worker（模型常驻）**——✅ 可降到 <2s，但仅解决 Mac 本地；云端无 GPU 仍不可用。作为未来 Mac mini 专用机的可选优化保留（见 [docs/IDEAS.md] 候选），非本期
- **C. 默认讯飞**（用户初始要求）——❌ 实测推翻：不更准 + 慢 10 倍 + 中英混排更差
- **D. 讯飞极速录音转写**（用户中途选项）——❌ 官方文档明示短音频 ~20s，比 IAT 更差
- **E. OpenAI Whisper API / Deepgram / Azure**——延迟/成本/中文质量均不如 Groq 免费额度方案（Groq LPU 推理延迟异常低，免费额度个人用足够）
- **F. faster-whisper 自托管**——✅ 有 GPU 时最优，但当前无 GPU 云实例，YAGNI，接口已预留

## 8. Consequences

正面：
- 主力延迟从 ~5s（本地冷启动）降到 ~0.8s（Groq），约 6 倍提速
- 云端 Linux 部署解锁（之前本地 whisper 是 blocker）
- provider 抽象使未来 GPU 自托管/中国区切换 = 改一行 env
- 自动降级链：任一家挂不影响可用性

负面：
- 主力依赖外部 API（Groq）——语音上云，非完全本地（隐私权衡：个人自用可接受；完全离线场景走 `ASR_PROVIDER=whisper-cpp`）
- 多 provider = 多一份维护面（缓解：统一接口 + 失败日志）

中性：
- `.env` 含真实 key，已 gitignore 保护，不入 git
- 讯飞 IAT ~8s 兜底链路仅在 Groq 全挂时触发，正常不影响体验

## 9. References

- [讯飞极速录音转写大模型 API 文档](https://www.xfyun.cn/doc/asr/speedTranscription/API.html)（短音频 ~20s 的官方依据）
- [讯飞语音听写（流式版）WebAPI](https://www.xfyun.cn/doc/asr/voicedictation/API.html)（IAT `/v2/iat` 实现依据）
- [ADR-012 Language=TS + ML Worker 边界](../adr/vessel/ADR-012-language-typescript-with-ml-worker.md)（ASR subprocess 骨架，本文档在其内做螺旋）
- PR #91（统一 ASR 链实现）/ commit `134bf9c`
- 实测环境：本机 macOS，Groq `whisper-large-v3`，讯飞 APPID `e2f021cb`（语音听写应用），2026-05-19
