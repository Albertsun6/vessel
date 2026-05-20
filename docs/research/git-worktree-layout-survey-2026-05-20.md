# Git Worktree 目录布局最佳实践调研

> /survey 报告 · 2026-05-20 · Vessel 项目  
> 调研问题：sibling 同级 vs in-repo `.worktrees/` vs bare repo + worktrees，哪种最适合「个人单机器 + 长期多 worktree + 每个独立 dev port + IDE window」场景

## 研究问题

对个人单机器 + 长期多 worktree + 每 worktree 独立 dev port/dataDir/IDE window 的场景，sibling 目录（repo 同级）/ in-repo `.worktrees/` 子目录 / bare repo + worktrees/ 三种布局的最佳选择是什么？

**Vessel 当前实际**：4 个 worktree 全在 `/Users/yongqian/dev/Vessel-<branch>/`（sibling 同级）。

## 评估维度（权重相等）

| 维度 | 含义 |
|---|---|
| D1 IDE 兼容 | Cursor / VS Code / JetBrains 能否把每个 worktree 当独立 project window，indexer 是否隔离 |
| D2 Cleanup 安全 | `rm -rf <worktree>` 误操作的爆炸半径 |
| D3 工具链污染 | rg / find / lint / npm install 在嵌套 worktree 下是否出错或重复扫 |
| D4 per-worktree 元数据 | port / dataDir / `.env.local` 等本机配置在哪种布局下管理最顺 |
| D5 主流采纳 | git 官方、知名 OSS 博客、worktree CLI、AI IDE 实际选择 |

## 方案对比矩阵

| 方案 | D1 IDE | D2 Cleanup | D3 污染 | D4 元数据 | D5 主流 | 综合 |
|---|---|---|---|---|---|---|
| **A. Sibling 同级** `~/dev/Vessel-<branch>/`（Vessel 当前） | 5 ✓ | 4 | 5 ✓ | 3 | 4 | **4.2** |
| **B. In-repo `.worktrees/`** `~/dev/Vessel/.worktrees/<branch>/` | 3 | 2 | 1 ✗ | 4 | 2 | **2.4** |
| **C. Bare repo + worktrees** `~/dev/Vessel/{.bare,main,feat-x}/` | 5 ✓ | 5 ✓ | 5 ✓ | 3 | 5 ✓ | **4.6** |

> ✓ = 该维度最优 · ✗ = 有已知未修复缺陷

### 评分依据

**D1 IDE 兼容**

- **A**：每 worktree 单独路径，Cursor / VS Code 直接 "Open in New Window"，indexer 完全隔离。VS Code 1.103 (Jul 2025) 起原生支持 `Git: Open Worktree in New Window`。
- **B**：`.worktrees/<branch>/` 是子目录，Cursor 打开时容易把外层 repo 当 workspace root，需手动 `cd` 进子目录或显式 `code .worktrees/foo`。
- **C**：同 A 优势，每个 worktree 在 bare-parent 下平级。

证据：[VS Code worktrees docs](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees) · [JetBrains git-worktrees](https://www.jetbrains.com/help/idea/use-git-worktrees.html)

**D2 Cleanup 安全**

- **A**：`rm -rf ~/dev/Vessel-foo` 不会触及主 repo。
- **B**：`rm -rf .worktrees/` 在主 working dir 内，shell 上下文易出错；`git clean -fdx` 在主 worktree 内若没把 `.worktrees/` 加 ignore 会把所有 sibling worktree 的 untracked 一并清掉。
- **C**：无 "blessed main checkout"，所有 worktree 平级；删任一个不会影响其他。Cursor 干脆内置 `worktreeCleanupIntervalHours` 配置承认这是个真问题。

证据：[Cursor worktrees config](https://cursor.com/docs/configuration/worktrees)

**D3 工具链污染**（最关键的硬证据）

- **A**：0 已知污染。
- **B**：ripgrep [issue #2492](https://github.com/BurntSushi/ripgrep/issues/2492) 明确 **wontfix** — rg 不会自动忽略嵌套 worktree，会重复匹配；`k1LoW/git-wt` 作者在 [issue #83](https://github.com/k1LoW/git-wt/issues/83) 里专门记录 in-repo 布局会让 linters / formatters / 各种 config-loader 在父目录 "parent traversal" 时重复加载两边的配置。
- **C**：`.bare/` 是隐藏目录，rg / fd / find 默认跳过；worktree 都在父目录平级，工具链零污染。

**D4 per-worktree 元数据**

- **A**：每 worktree 一个 `.env.local`，需要外置注册表（Vessel 的 `eva.json` / `WORKTREE_LOCK.md`）追踪 port + dataDir 映射。
- **B**：主 repo 内统一 `.worktrees/<branch>/.env.local` 模板复制更方便。
- **C**：同 A。
- **可借鉴的 setup-hook convention（layout-neutral）**：
  - [Claude Code `.worktreeinclude`](https://code.claude.com/docs/en/worktrees) — 声明式文件清单，复制 gitignored 文件
  - [Cursor `.cursor/worktrees.json`](https://cursor.com/docs/configuration/worktrees) — `setup-worktree` 钩子，示例 `cp $ROOT_WORKTREE_PATH/.env.local .env.local`
  - [Windsurf `post_setup_worktree`](https://docs.windsurf.com/windsurf/cascade/worktrees) — 复制 `.env` / `.env.local`
  - [Zed `create_worktree` task hook](https://zed.dev/docs/git)
  - [OpenAI Codex local environment setup script](https://developers.openai.com/codex/app/worktrees)
- **Git 原生 caveat**：`extensions.worktreeConfig` + `git config --worktree` 可管理 Git 配置级别的 per-worktree 差异（如 `user.email` 切换），但**应用运行时端口、dataDir、env 文件仍需要项目级机制**。证据：[git-worktree(1)](https://git-scm.com/docs/git-worktree)

**D5 主流采纳**

- **A**：[git-worktree(1)](https://git-scm.com/docs/git-worktree) 所有官方示例用 `../hotfix` / `../temp` / `/path/other/test-next` 全是 sibling；GitHub 2015 介绍文也用 `../hotfix`；多个 AI IDE（[Cursor](https://cursor.com/docs/configuration/worktrees) Parallel Agents、[Windsurf](https://docs.windsurf.com/windsurf/cascade/worktrees) `~/.windsurf/worktrees`、[OpenAI Codex](https://developers.openai.com/codex/app/worktrees) `$CODEX_HOME/worktrees`、[Zed](https://zed.dev/docs/git) 默认 `../worktrees`）选择"外置受管目录"=本质是 sibling。
- **B**：只有 [Claude Code](https://code.claude.com/docs/en/worktrees) 一家选 in-repo (`.claude/worktrees/`)；社区主流博客（[gitworktree.org](https://www.gitworktree.org/guides/best-practices)、[Josh Medeski](https://www.joshmedeski.com/posts/how-to-use-git-worktrees/)、Nick Nisi、Morgan Cugerone）**显式劝退** in-repo。
- **C**：2023-2026 maintainer 博客圈共识 — [Morgan Cugerone](https://morgan.cugerone.com/blog/how-to-use-git-worktree-and-in-a-clean-way/)、[Safia Abdalla (GitHub eng)](https://blog.safia.rocks/2025/09/03/git-worktrees/)、[NakaTechLabs](https://nakatechlabs.com/blog/2025/git-worktree/)、Milad、Nick Nisi 全部推荐 `.bare/` + sibling worktrees；[pnpm 官方](https://pnpm.io/next/git-worktrees) 把 bare repo 列为多 worktree 推荐布局。

## 关键发现

1. **三方一致：git 官方文档全用 sibling**，没有任何一个官方示例用 in-repo `.worktrees/`。
2. **三方一致：in-repo 有工具链污染**，rg 维护者 wontfix 是最强信号（社区里没人能修，只能改布局规避）。
3. **bare repo + worktrees 是 2023-2026 maintainer 博客主流共识**，但迁移成本不低（脚本 / launchd / Xcode / IDE bookmark 都要改路径）。
4. **AI IDE 阵营分裂**：
   - **In-repo 派**：Claude Code（`.claude/worktrees/` + `.worktreeinclude`）
   - **外置派**：Cursor、Codex、Windsurf、Zed、pnpm — 全选 sibling 或集中外置目录
   - Cursor 2.0 Parallel Agents (up to 8) + worktree-per-agent，已经把 worktree 当 first-class 并行隔离层
5. **per-port / per-dataDir / per-env 工程化已有多家声明式方案**（Claude Code `.worktreeinclude`、Cursor `setup-worktree`、Windsurf `post_setup_worktree`、Zed `create_worktree` hook、Codex local-env-setup script），都是 layout-neutral 的 setup-hook 模式。**Vessel 的 `eva.json`（port + dataDir + lifecycle hooks）走得更远**，把 port/dataDir 注册表也外置了，是相对独特的延伸。
6. **VS Code 1.103 (Jul 2025) 加了原生 worktree 支持**，命令包括 `Git: Create Worktree` / `Git: Open Worktree in New Window` / `Git: Delete Worktree`，layout-neutral。
7. **`pnpm + enableGlobalVirtualStore` 在多 worktree 场景可节省 ~63% node_modules 磁盘**（3 worktree × 2GB → 2.25GB 共享 CAS），是 Vessel 这种 pnpm monorepo 的明显未开发优化点。

## 推荐

**结论**：**维持 sibling**（不要迁到 in-repo `.worktrees/`）；长期可考虑 bare repo + worktrees 升级，但**不是当前优先级**。

**理由**：

- 当前 sibling 布局综合分 4.2，仅比理论最优 bare (4.6) 低 0.4 — 而 in-repo 是 2.4，绝对劣势
- in-repo 的 rg / linter / formatter 双重加载问题是 wontfix 上游问题，改了布局会持续踩坑
- sibling 跟 git 官方、所有非 Anthropic AI IDE、所有社区主流博客对齐，"借鉴成本"最低
- Vessel 已有 `eva.json` 做 port/dataDir 注册表，外置元数据已经实现 — 这是当前布局的优势，不是劣势

**适用条件**：

- 个人单机器、长期 4-8 个并行 worktree、每个独立 dev server + IDE window — sibling 最稳
- 如果有一天 worktree 数 ≥10 或要让 worktree 自动化创建/销毁，bare + worktrees 的 cleanup 优势会显现，那时再迁
- 团队多人 / 多机器场景超出本调研范围（用户场景明确单机器）

**置信度**：高（基于 ~48 个独立 source、三方异构搜索 + 1 轮辩论收敛）

## 给 Vessel 的可执行建议

按优先级排序（先做收益最高 / 风险最低的）：

1. **统一文档** [小，30 分钟]：把 [docs/branch-naming.md:78](docs/branch-naming.md#L78) 的 `.worktrees/<issueId>` 改为 sibling 例子（`~/dev/Vessel-<issueId>`），消除跟 [docs/STEWARD_USAGE.md:194](docs/STEWARD_USAGE.md#L194) 的冲突。同步更新 [docs/proposals/STEWARD-V0-DESIGN.md:212](docs/proposals/STEWARD-V0-DESIGN.md#L212)。
2. **更新过期路径** [小，10 分钟]：[eva.json](eva.json) 里老条目还写 `~/Desktop/claude-web-mini3`（是 Eva 时代旧路径），但磁盘上实际全是 `/Users/yongqian/dev/Vessel-*`。当前 active worktree 条目应同步。
3. **加 setup-hook 等价机制** [中，2 小时]：参考 Claude Code `.worktreeinclude` + Cursor `setup-worktree` 的声明式 convention，在 [scripts/](scripts/) 加 `worktree-init.sh` 自动复制 `.env.local` 模板 + 写入 port + dataDir，避免每次手动 `echo "PORT=3032" > .env.local`。
4. **试 pnpm `enableGlobalVirtualStore`** [中，1 小时探索]：当前 4 worktree 各自 `node_modules` 占用估算 ~2GB × 4 = 8GB。pnpm 文档明确说在 worktree 场景配 `enableGlobalVirtualStore: true` 可降到 ~3GB。这是 pure 优化，不改布局。
5. **不要迁 bare repo** [建议 defer]：理论最优但迁移要改 launchd plist + tailscale serve + Xcode bookmark + 所有 backend HTTP 自指 URL；当前 sibling 已经"工作良好"，不破不立。

## 待验证风险

- [ ] Cursor 把嵌套 `.worktrees/` 子目录识别成同一 workspace 还是独立项目？（B 方案被否决的最强论据之一，但 Vessel 本来就不打算迁 B，可以不验）
- [ ] pnpm `enableGlobalVirtualStore` 在 worktree 切换分支（涉及 `package.json` 变化）时是否会触发全 lockfile 重算？需要实测；如果会，"3 worktree 省 63%" 数字不一定成立
- [ ] OpenAI Codex / Cursor / Windsurf 各自的"外置目录"是否在多机器同步场景出问题（Vessel 当前单机器，但未来 Mac mini 迁移时要重新评估）
- [ ] Claude Code 2026 后续版本是否会改默认 worktree 位置（当前是 `.claude/worktrees/` in-repo，与社区主流相反，可能被 Anthropic 自己修正）

## 主要来源（按维度归类）

**官方文档（D5 主流）**

- [git-worktree(1)](https://git-scm.com/docs/git-worktree) — git 官方，sibling 示例
- [GitHub Blog 2015 Git 2.5](https://blog.github.com/2015-07-29-git-2-5-including-multiple-worktrees-and-triangular-workflows/) — sibling 示例

**IDE / AI 工具官方（D1 + D4 + D5）**

- [VS Code worktrees](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees) — 1.103 (Jul 2025) 原生
- [JetBrains git-worktrees](https://www.jetbrains.com/help/idea/use-git-worktrees.html)
- [Cursor worktrees](https://cursor.com/docs/configuration/worktrees) · [Cursor Agents Window](https://cursor.com/docs/agent/agents-window) — `.cursor/worktrees.json` setup-worktree hook
- [Zed git](https://zed.dev/docs/git) — 默认 `../worktrees` + `create_worktree` task hook
- [Windsurf cascade worktrees](https://docs.windsurf.com/windsurf/cascade/worktrees) — `~/.windsurf/worktrees` + `post_setup_worktree`
- [OpenAI Codex worktrees](https://developers.openai.com/codex/app/worktrees) — `$CODEX_HOME/worktrees`
- [Claude Code worktrees](https://code.claude.com/docs/en/worktrees) — **唯一** in-repo `.claude/worktrees/` + `.worktreeinclude`
- [pnpm git-worktrees](https://pnpm.io/next/git-worktrees) — bare repo 推荐

**工具链污染证据（D3）**

- [ripgrep #2492](https://github.com/BurntSushi/ripgrep/issues/2492) — wontfix，nested worktree duplicate matches
- [k1LoW/git-wt #83](https://github.com/k1LoW/git-wt/issues/83) — linters/formatters double-load

**Maintainer 博客（D2 + D5）**

- [Morgan Cugerone](https://morgan.cugerone.com/blog/how-to-use-git-worktree-and-in-a-clean-way/) — bare + sibling 经典
- [Safia Abdalla (GitHub eng)](https://blog.safia.rocks/2025/09/03/git-worktrees/)
- [Nick Nisi](https://nicknisi.com/posts/git-worktrees/)
- [NakaTechLabs 2025](https://nakatechlabs.com/blog/2025/git-worktree/)
- [Josh Medeski](https://www.joshmedeski.com/posts/how-to-use-git-worktrees/)
- [gitworktree.org best-practices](https://www.gitworktree.org/guides/best-practices)

**Worktree CLI 工具（D5 split）**

- [satococoa/wtp](https://github.com/satococoa/wtp) — 默认 sibling (`../worktrees`)
- [k1LoW/git-wt](https://github.com/k1LoW/git-wt) — 默认 `.wt` in-repo（作者自述权衡）
- [ahmedelgabri/git-wt](https://ahmedelgabri.github.io/git-wt) — `.bare/` + sibling
- [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) — `~/.agent-orchestrator/` 集中
- [kbwo/ccmanager](https://github.com/kbwo/ccmanager) — AI agent + worktree session manager

**AI agent + worktree 实战（D4）**

- [nrmitchi: AI agents + worktrees](https://www.nrmitchi.com/2025/10/using-git-worktrees-for-multi-feature-development-with-ai-agents/) — 显式 port/env "out of scope"

## 调研 Metadata

<details>
<summary>调研流程与质量门禁</summary>

- **Phase 2 异构搜索**：2 Claude (general-purpose) + 1 cursor-agent X，三方独立并行；共 ~48 个唯一 source。
- **Phase 2.5 Reflection**：7 子问题中 5 全覆盖、2 部分覆盖（kernel maintainer 无公开姿势；gh CLI 无 worktree 子命令本身是 finding）；无追搜。
- **Phase 5.5 Citation Health**：37 unique URLs · ok 33 (89%) · blocked 2 (5% bot detection, 不计失败) · dead 2 (5%, < 10% PASS 阈值)。
  - Dead URLs: `developers.openai.com/codex/app/worktrees` (curl 探测失败但 WebSearch 二次验证内容存在 + 支持 claim) + `pabloariasal.github.io/2023/12/27/git-worktrees/` (404, 次要引用, 已从最终报告移除)
  - Layer B 抽样: OpenAI Codex worktree claim、rg #2492 wontfix、Claude Code in-repo 三个高 stakes claim 已验证 supported
- **Phase 6 异构终审 verdict**: Refine（cursor-agent 提 3 条修订建议）
- **辩论收敛**: Round 1 全 accept → 直通 finalize（无 Round 2/3，无人类裁决）
- **人类介入**: 无
- **Output**: docs/research/git-worktree-layout-survey-2026-05-20.md（mv 自 cwd 原文件名 `git-worktree布局最佳实践-完整报告.md`，按 docs/research/ 现有 convention 重命名）
- **Filename collision**: none
- **HTML**: 本地保留 `git-worktree布局最佳实践-完整报告.html`（.gitignore 已加 `/*-完整报告.html` 不入库）
- **Audio**: 本地保留 `git-worktree布局最佳实践-音频概要.m4a` (45s, 走全局 `*.m4a` ignore)

</details>

<details>
<summary>Phase 6 Round 1 判断矩阵</summary>

| cursor-agent 建议 | 主 agent 立场 | 论据 / 修订动作 |
|---|---|---|
| 1. D4 "Claude Code 唯一工具级 convention" 表述过强 | **accept** | WebFetch 验证 Cursor `.cursor/worktrees.json` 确实含 `cp $ROOT_WORKTREE_PATH/.env.local .env.local` 示例；Windsurf / Zed / Codex 也都有 setup-hook 机制。已将 D4 改为列出 5 个声明式 convention + 把 Vessel 的差异点收窄到 "port/dataDir 注册表"。关键发现 #5 同步修订。 |
| 2. rg #1445 已 closed 不该当当前未修复风险 | **accept** | `gh api repos/BurntSushi/ripgrep/issues/1445` 确认 `state=closed, state_reason=completed, closed_at=2020-02-17`。已从 D3 evidence 列表移除；保留 #2492 + k1LoW #83 作为强证据。 |
| 3. D4 应补 Git 原生 `extensions.worktreeConfig` 边界 | **accept** | git-worktree(1) 官方文档确有此扩展；已在 D4 加 caveat："可管理 Git 配置级别的 per-worktree 差异，但应用运行时端口、dataDir、env 文件仍需要项目级机制"。 |

> 三条全 accept → Round 1 收敛，无需 Round 2/3。

</details>
