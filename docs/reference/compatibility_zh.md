# 兼容性与实测矩阵

[English](compatibility.md) | 简体中文

> [返回文档索引](../README_zh.md) · [返回 README](../../README_zh.md)

本参考文档记录 orca-dag viewer 与 Orca 运行时的最低版本门槛、启动路径限制以及截至 2026-10-27 的完整真实运行时验证历史。

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

**截至 2026-10-27，有记录的真实运行时验证历史如下：**

| Orca app | Agent 版本 | 已验证内容 |
|---|---|---|
| **1.4.217** | **Codex CLI 0.159.2** | 本机只读原生 Task：提示词执行、`live / agent_status`、精确 transcript 及 Orca 接受 `worker_done`。 |
| **1.4.222** | **OpenCode 2.0.22** | 显式启用的 API 预选模型完整 TUI：逐节点模型/variant、依赖 Task、重启恢复且不重复派工、关闭终端后读取输出、成功完成后的清理及 provider 确认退出的 Stop。Stop 在 fencing 后可能保留终端，不保证自动关窗。 |
| **1.4.229** | **OpenCode 2.0.28** | 已记录的本地 POSIX 显式模型 one-shot 认证：`deepseek/deepseek-flash` 两个依赖任务、阻塞 ask/reply、多审批门、同 Run 恢复且不重复生产任务、接受 `worker_done`、独立重算产物，最终无实验自有终端或清理债务。不代表原生 `opencode2` 模型选择或 API 预选 TUI 已通过，证据范围见操作教程。 |
| **1.4.235** | **OpenCode 2.1.2** | Linux viewer 选择 Mini / 完整 TUI，指定模型与配置默认模型、写文件及获接受的 `worker_done`；Mini 前台等待 400.027 秒并确认后续消息、显式保留及活动 Stop。Mini fleet 仍可能为 `missing_status`；配置的 provider 必须可用（首次免费默认 provider 返回 403）。 |
| **1.4.241** | **OpenCode 2.1.2** | 隔离 Linux headless 运行时，原生 `opencode` + `deepseek/deepseek-flash`：写文件并读回、接受 `worker_done`、effective 模型回显及终端释放；viewer 重启后恢复相同 Dispatch 并完成依赖 Task，无重复 worker、无清理债务。profile 的嵌套深度上限为 1，真实 helper 启动被拒绝；helper 归属/交回由回归套件覆盖，不宣称已通过真实 provider 验证。 |
| **1.4.242** | **Codex 0.164.0** | 隔离 Linux 原生 worker：写文件并读回、显示 provider transcript、跨多个有界页面向前翻页、获接受的 `worker_done`、终端释放及释放后仍可读的 transcript 归档。另一次真实桌面 viewer A/B → C 流程观察到两个根 worker 并行存活，三个 Task 全部完成、结果为 `51`，恰好三个 Dispatch，终端完成复用/保留归属决策且无清理债务。不代表已覆盖远程/Windows，也未在真实 provider 上复现启动后期报错竞态。 |

### 验证边界与限制说明

1. **原生 OpenCode 2 路径**：已使用 **OpenCode 2.0.22** 通过只读 Task 和隔离工作树写文件验证（要求 Orca ≥ 1.4.220）。这与实验性 API 预选模型适配器的验证不同；后者在 macOS、**Node.js 22.23.0** 上实测，**尚未覆盖**长时间编码、Git Stage、新建工作区、lane、远程或 Windows 执行。
2. **Claude Code**：有 Orca **1.4.209** 上的历史端到端验证，但当时未记录精确 CLI 版本。
3. **未经验证的组合**：其他 harness 暂无已记录的 Orca/agent 版本组合验证；为某个 agent 安装 skill **不代表**其 worker 执行已通过验证。
4. **已知淘汰组合**：较早的 Orca **1.4.209** + Codex **0.156.1**（缺少 fleet 状态）及 OpenCode **2.0.15**（原生提示词未送达）属于已知限制，不作为推荐组合。
5. **更多详细运行时诊断与边界**：请查阅[操作教程：运行时发现与启动路径边界](../tutorials/viewer-operations_zh.md#已知局限)。

## 重新验证

真实 Codex 复验命令、provider 用量、观察期限及证据位置统一见[开发指南](../development_zh.md)。`verify:live` 不属于常规检查；状态 unknown 时不会自动重试或取消。
