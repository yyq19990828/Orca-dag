# 兼容性与实测矩阵

[English](compatibility.md) | 简体中文

> [返回文档索引](../README_zh.md) · [返回 README](../../README_zh.md)

本参考文档记录 orca-dag viewer 与 Orca 运行时的最低版本门槛、启动路径限制以及截至 2026-10-29 的完整真实运行时验证历史。

## 最低运行要求

- **Orca ≥ 1.4.160 可浏览，≥ 1.4.205 可执行**（通过 `orca status --json` 查看 `result.runtime.appVersion`）：
  - Run/Dispatch 契约由 Orca 1.4.160 引入；
  - 任务执行需要 1.4.205 的 supervised-worker 契约；
  - 1.4.160–1.4.204 进入只读模式（DAG、gate、状态照常渲染，执行类控件禁用并给出升级提示；直接调用修改接口将返回 `503 execution_disabled`）；
  - 更早版本（2026-07-29 的 PR #9925 之前）不支持。
- **编排实验特性已开启**：Orca 内 Settings → Experimental。
- **Orca 处于运行中**：`orca status --json` 的 `result.runtime.state` 必须为 `"ready"`；未启动时请先运行 `orca open`。
- **项目已纳入 Orca 管理**：当前目录必须是 Orca 注册的 repo 或 worktree（否则 `orca terminal create` 报 `selector_not_found`）。可通过 `orca repo add <path>` 或 `orca worktree …` 预先纳管。
- **建图端拥有可运行 skill 的 Agent**：Claude Code、Codex、Cursor、OpenCode 或任何能够阅读 `SKILL.md` 并执行 Bash 的 agent。
- **viewer 端环境**：仅依赖 `orca` CLI —— 不需要 `claude` CLI，亦不需要 `ANTHROPIC_API_KEY`。
- **Node.js ≥ 20**（用于运行 `npx orca-orchestration-launcher`）或直接下载预编译独立二进制。打包独立二进制时需要 **Bun**。

## 支持范围与最低门槛

**最低兼容版本不等于完整的实测版本矩阵。** 原生 agent 和实验性 TUI 路径依据的是**运行中的 Orca app 版本**（`orca status --json` 里的 `result.runtime.appVersion`），不能仅凭已安装的 CLI 版本判断。

| 能力 / 启动路径 | 最低 Orca 版本 | 条件 |
|---|---|---|
| 浏览 Run、Task 和 gate | **1.4.160** | 1.4.160–1.4.204 仅支持浏览。 |
| 通过 supervised worker 执行 DAG | **1.4.205** | 通用执行基线；具体 agent 路径可能要求更新版本。 |
| 原生 Codex 启动 | **1.4.217** | 本机 POSIX 当前/已有工作区；旧版、版本未知的运行时及新建本机工作区仍走兼容适配器。 |
| 原生 OpenCode 2 TUI | **1.4.220** | 未设置逐节点模型；viewer 的 `opencode` 选择映射为 Orca 的 `opencode2` agent。 |
| 显式选择 Mini / 完整 TUI | **1.4.222** | OpenCode ≥ **2.1.2**；本机 Linux 当前/已有、非 lane 工作区。默认仍为自动。 |
| API 预选模型的 OpenCode 2 完整 TUI | **1.4.222** | 显式指定模型并设置 `ORCA_DAG_OPENCODE_TUI=1`；仅本机 POSIX 当前/已有、非 lane 工作区。实验性功能，默认关闭。 |
| 自动模式下的 OpenCode 原生模型选择 | **1.4.241** | 声明启动偏好能力；本机 POSIX 当前/已有、非 lane 工作区；无 variant 或 effort。使用独立的 `opencode` agent，由执行主机验证模型及 CLI。 |

## 有记录的真实运行时验证

**截至 2026-11-02，有记录的真实运行时验证历史如下：**

| Orca app | Agent 版本 | 已验证内容 |
|---|---|---|
| **1.4.217** | **Codex CLI 0.159.2** | 本机只读原生 Task：提示词执行、`live / agent_status`、精确 transcript 及 Orca 接受 `worker_done`。 |
| **1.4.222** | **OpenCode 2.0.22** | 显式启用的 API 预选模型完整 TUI：逐节点模型/variant、依赖 Task、重启恢复且不重复派工、关闭终端后读取输出、成功完成后的清理及 provider 确认退出的 Stop。Stop 在 fencing 后可能保留终端，不保证自动关窗。 |
| **1.4.229** | **OpenCode 2.0.28** | 已记录的本地 POSIX 显式模型 one-shot 认证：`deepseek/deepseek-flash` 两个依赖任务、阻塞 ask/reply、多审批门、同 Run 恢复且不重复生产任务、接受 `worker_done`、独立重算产物，最终无实验自有终端或清理债务。不代表原生 `opencode2` 模型选择或 API 预选 TUI 已通过，证据范围见操作教程。 |
| **1.4.235** | **OpenCode 2.1.2** | Linux viewer 选择 Mini / 完整 TUI，指定模型与配置默认模型、写文件及获接受的 `worker_done`；Mini 前台等待 400.027 秒并确认后续消息、显式保留及活动 Stop。Mini fleet 仍可能为 `missing_status`；配置的 provider 必须可用（首次免费默认 provider 返回 403）。 |
| **1.4.241** | **OpenCode 2.1.2** | 隔离 Linux headless 运行时，原生 `opencode` + `deepseek/deepseek-flash`：写文件并读回、接受 `worker_done`、effective 模型回显及终端释放；viewer 重启后恢复相同 Dispatch 并完成依赖 Task，无重复 worker、无清理债务。profile 的嵌套深度上限为 1，真实 helper 启动被拒绝；helper 归属/交回由回归套件覆盖，不宣称已通过真实 provider 验证。 |
| **1.4.242** | **Codex 0.164.0** | 隔离 Linux 原生 worker：写文件并读回、显示 provider transcript、跨多个有界页面向前翻页、获接受的 `worker_done`、终端释放及释放后仍可读的 transcript 归档。另一次真实桌面 viewer A/B → C 流程观察到两个根 worker 并行存活，三个 Task 全部完成、结果为 `51`，恰好三个 Dispatch，终端完成复用/保留归属决策且无清理债务。不代表已覆盖远程/Windows，也未在真实 provider 上复现启动后期报错竞态。 |
| **1.4.243** | **OpenCode 2.2.0** | 隔离 Linux 原生 worker（`opencode` + `deepseek/deepseek-flash`）：写文件并读回 `{"verified":243,"frontend":"native"}`、获接受的 `worker_done`、恰好 1 个 Dispatch、终端释放且无清理债务。在本地 viewer 模型发现失败（`opencode models` 退出码 23）下原生执行依然成功，证明发现仅为建议性质而非执行宿主失败。心跳 preamble 预览按 5分/关闭/15分 正确生成（关闭时不含心跳命令）。显式 Mini 与 Full TUI 实测均未通过启动身份就绪门（终端标题在 60 秒内未更新为 `OC | odag:<request>`，在 Task 输入/Dispatch 前安全拒绝并按 `start_failed` 结算，无清理债务，无 provider 任务执行覆盖）。不代表已覆盖远程/Windows、新工作树模型覆盖、variant、effort 或真实多账户认证。 |
| **1.4.245** | **OpenCode 2.2.0** | Linux viewer 选择 Mini，固定 `openai/gpt-6.1-sol#xhigh`：当前工作区排他创建文件及独立复算、获接受的 `worker_done`、成功关闭自建 pane、关闭后读取 API 工具输出并向前翻页。已有工作区的活动执行经 viewer 崩溃/重启后恢复同一 session 与 Dispatch；Stop 经 provider 确认退出，前台工具子进程结束且未写入完成文件，再执行 Orca `worker-abandon` 记账。Fencing 后 pane 因 `identity_unproven` 保留供检查，不自动关闭。不代表 Full TUI、远程/Windows、lane、新建工作区放置或托管多账户已验证。 |

### 验证边界与限制说明

1. **原生 OpenCode 2 路径**：已使用 **OpenCode 2.0.22** 通过只读 Task 和隔离工作树写文件验证（要求 Orca ≥ 1.4.220）。这与实验性 API 预选模型适配器的验证不同；后者在 macOS、**Node.js 22.23.0** 上实测，**尚未覆盖**长时间编码、Git Stage、新建工作区、lane、远程或 Windows 执行。
- **Orca 1.4.243 与 OpenCode 2.2.0 边界**：
  - **建议性模型发现与手动选择**：本地工作区子进程发现（`GET /api/models/:harness`，`scope: "local-workspace"`）仅为建议性质，与执行宿主模型校验隔离。发现失败（如退出码 23）或目录为空不影响手动输入合法的 `provider/model[#variant]`，且已保存但未在列表中的模型予以保留。本地发现失败不改变原生路由门槛，原生拒绝绝不回退到二次派工。
  - **心跳权威规则**：心跳消息（`type: "heartbeat"`）严格作为**存活证据**，绝不能作为完成或结算依据。Orca 在群发消息（`@all`、`@worktree`）中拒绝心跳与 `worker_done`；隔离 profile 的 preamble 预览按 5分/关闭/15分 正确生成，关闭时不输出心跳命令，不修改全局设置，未运行未验证的心跳 worker 或测试旧 worker 热变更。
  - **移除工作记录（removedWork）**：`run-show` 提供可选摘要，并通过 `/api/runs/:runId/removed-work?cursor=` 按需游标分页；旧宿主未提供时保持 unavailable 而不补 0。`activeWorkersAtRemoval` 仅表示移除跟踪时可能仍在运行的数量，不是历史或当前进程存活证明；不提供 reset 按钮。
  - **显式 Mini / Full TUI 与后端可见性丢失边界**：本次 OpenCode 2.2.0 实测中，API 预建会话的模型与位置正确，但两个前端均未在 60 秒内通过精确 session 派生标题检查。适配器在 Task 输入或 Dispatch 前拒绝，记录 `settledVia=start_failed`，最终安全关闭 preparation，清理债务为空。这不代表所有 2.2.0 环境绝对不支持，根因未证实，也未放宽就绪检查。当前无 Orca 托管 OpenCode 账户，不能宣称真实多账户通过；仅有独立回归 fixture 验证 API 可见性丢失时保留 `prepared` 记录与原 pane，不发送 Task 输入、不关闭 pane、不启动替代。
  - **非 worker 支持扩展**：不要把上游 PR 32006（nativeChat 模型）或新顶层工作树修复视为 `opencode2`、新工作树或远程/Windows 的 worker 支持扩展。保留既有兼容矩阵与旧版本记录。
  - **CLI-run 只读观测：**已从既有精确绑定的 `openai/gpt-6.1-sol#xhigh` session 读回 provider `active` 与 `exited`、助手消息中的模型证据及 `opencode-api` 输出；原生 fleet 仍保留 `unverifiable`。这只证明观测路径，不是新增 Task 成功、Mini/TUI 或 worker harness 认证。Provider 证据不扩大重试、Stop、释放权限；历史达到上限或不可读时明确保留限制。
- **Task 就绪前置条件：**普通审批 gate 仅接受精确的已解决决定 `approve` 或 `approved`；`integrated` 仍是独立且精确的集成决定。Task 必须满足所有 gate 及同一 Run 内的全部依赖后才可运行，即使 Orca 的 Task 行已标记为 `ready`。
2. **已验证的内置 Worker Harness 与 Claude Code**：viewer 内置支持的受监督调度 harness 仅限已完成真实运行时验证的 `claude`、`codex`、`opencode`，并遵守各版本与放置约束。Claude Code 有 Orca **1.4.209** 上的历史端到端验证，但当时未记录精确 CLI 版本。
3. **未经验证的 Harness 明确拒绝**：`gemini`、`grok`、`cursor`、`droid`、`kimi` 尚未获得具体的 supervised worker 运行时验证，viewer 不再提供内置预设，亦不可用于调度启动。若节点配置或已保存设置尝试使用这些 harness，启动与重试均被前置拦截并明确返回 `unverified_harness` 拒绝，绝不进行静默替换或自动迁移；历史已落定的运行记录与账本在 viewer 中保持只读可查。
4. **实验性自定义命令与 Bare ID 限制**：用户自定义命令需显式开启 `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`，仅走本地兼容路径、不支持隔离放置，且**不构成**已验证支持承诺。即使开启自定义命令开关，上述 5 个未验证 bare ID（`gemini`、`grok`、`cursor`、`droid`、`kimi`）依然被直接拒绝并返回 `unverified_harness`，严禁将其作为 bare ID 绕过验证机制。
5. **技能安装与规划能力独立保留**：Agent 的 skill 安装（如 Claude Code、Cursor、Gemini CLI、Droid、Grok、Kiro、Qoder、CodeBuddy、Codex、OpenCode、Pi、OMP、Kimi）和阅读 `SKILL.md` 的建图规划支持依然完整保留，因为建图端与 skill 生态能力与 worker 执行验证相互独立。为某个 agent 安装 skill **不代表**其 worker 执行已通过验证。
6. **已知淘汰组合**：较早的 Orca **1.4.209** + Codex **0.156.1**（缺少 fleet 状态）及 OpenCode **2.0.15**（原生提示词未送达）属于已知限制，不作为推荐组合。
7. **更多详细运行时诊断与边界**：请查阅[操作教程：运行时发现与启动路径边界](../tutorials/viewer-operations_zh.md#已知局限)。

## 重新验证

真实 Codex 复验命令、provider 用量、观察期限及证据位置统一见[开发指南](../development_zh.md)。`verify:live` 不属于常规检查；状态 unknown 时不会自动重试或取消。
