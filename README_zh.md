# Orchestration Panel (`orca-dag`) — 技能 + 查看器 + 原生 Orca 插件

[English](README.md) | 简体中文

> 本项目 fork 自 [ZinkLu/Orca-Orchestration](https://github.com/ZinkLu/Orca-Orchestration)，独立扩展并以 [`orca-orchestration-launcher`](https://www.npmjs.com/package/orca-orchestration-launcher) npm 包及原生 Orca 伴生插件（`orchestration-panel`）发布。

**Orchestration Panel**（`orca-dag`）将「Agent 对话规划」与「可视化编排执行」解耦为三个清晰协作的模块：

1. **Skill**（[`skill/SKILL.md`](skill/SKILL.md) · [中文审阅版](docs/SKILL_zh.md)）：你的 Agent 按 PRD → 技术设计 → Orca 任务 DAG 规划工作，命令遵循与运行时匹配的编排指南（`orca skills get orchestration`）。规划留在你的 Agent 内，查看器不内嵌 Agent SDK。
2. **Viewer 与协调器**（`server/` + `web/`）：深浅双主题、高克制黑白灰四区 IDE 编排工作台，包含实时 DAG 画布、逐节点启动配置、服务端统一 `OutputTail` SSE + 结构化**会话（Session）**工具卡片、L1 原生会话恢复以及内置协调器循环。
3. **原生 Orca 插件**（`plugin/` → `dist-plugin/`）：自包含原生伴生插件（`orchestration-panel`，Host API 1.10 `trusted-worker`），内置自托管后端服务（**无需手动常驻终端**），提供精简右侧边栏面板（`SidebarApp`）与一键打开/复用完整标签页（`↗ 标签页`），由 Agent 事件唤醒指定 Worker 的会话记录读取，为符合条件的会话提供 L1 原生 `agent.resume`，并在 Orca 状态栏展示实时 Run 进度。

## 前置要求

下文 CLI 示例中的 `orca` 适用于 Orca 管理的终端；Linux 普通终端应使用 `orca-ide`，避免误调用 `/usr/bin/orca` 读屏器。显式覆盖和开发版本遵循[启动解析规则](docs/tutorials/viewer-operations_zh.md#启动参数)。

- **Orca 版本**：**≥ 1.4.160 可浏览，≥ 1.4.205 可执行**（1.4.160–1.4.204 自动进入只读模式）；原生 `orchestration-panel` 插件、OMP `--effort`、级联停止 helper 及单次 Worker 权限审批需要 **≥ 1.4.263**。
- **Orca 状态**：处于运行中（`orca status --json` 结果为 `"ready"`；否则先运行 `orca open`）且已开启实验特性（Settings → Experimental）。
- **工作区已纳管**：当前项目目录必须已通过 `orca repo add <path>` 或 `orca worktree` 纳入 Orca 纳管。
- **环境依赖**：Node.js ≥ 20，或独立发布二进制；两种方式都需要可用的 Orca CLI。
- **执行 Agent**：所选 worker agent 必须已在 Orca 中安装、配置和授权，能自主执行工具并发送 `worker_done`。
- **内置预设**：`claude`、`codex`、`opencode`、`omp`、`antigravity`，须遵守各自的[版本与放置限制](docs/reference/compatibility_zh.md)。其他 5 个未验证 agent ID 仍不可用，即使开启自定义命令也不能启动。

## 安装与启动

### 方式一：CLI / Web 查看器（`npx orca-orchestration-launcher`）

在 **Orca 管理的项目根目录**用普通 shell 启动。如果从 Orca 终端启动，请采用[清理继承环境的启动方式](docs/tutorials/viewer-operations_zh.md#启动参数)，避免终端身份冲突。

```bash
cd ~/any/orca-managed/project
npx orca-orchestration-launcher
```

此命令会为检测到的 coding agent 安装 `orca-dag` skill，初始化 `.orca-dag/` 忽略规则，并打开 **Orchestration Panel**。请使用启动时输出的本机 URL（默认 <http://localhost:8787>）。共享目录与自定义 agent 配置位置见 [skill 安装说明](docs/tutorials/viewer-operations_zh.md#skill-安装与-agent-目录)。规划文档与 viewer 历史保存在本地 `.orca-dag/`；viewer 的发现信息不属于工作区数据。

> **无 Node.js 环境？** 可从 [GitHub Releases](https://github.com/yyq19990828/orca-orchestration-launcher/releases) 下载独立预编译二进制运行。若仅需安装 skill 而无需 viewer：`npx skills add yyq19990828/orca-orchestration-launcher --skill orca-dag --global`。

### 方式二：自包含原生 Orca 插件（`orchestration-panel`）

在 Orca ≥ **1.4.263** 上可直接构建并加载原生伴生插件——**无需用户手动起前后端终端**：

```bash
npm install
npm run build:plugin-panel
orca-ide plugin dev load ./plugin --json
```

批准启用后，插件会在未检测到外部 viewer 终端时自动为当前本地工作区拉起隔离的内置回环后端服务（工作区关闭或插件停用时自动回收；若外部 viewer 启动或关闭则无缝发现与故障切换）。点击 Orca 右侧栏的 **Orchestration Panel** 图标即可查看精简侧边栏，点击侧栏顶部 `↗ 标签页` 或状态栏进度即可直达完整工作台标签页。打包独立插件目录见 [`plugin/README.md`](plugin/README.md)。

如果 Git 项目尚未忽略 `.orca-dag/`，请在使用插件前将 `.orca-dag/` 加入项目的 `.gitignore`。插件不会自动修改 `.gitignore`。

## 快速开始

完成安装后：

1. **与 Agent 规划：**
   > 使用 orca-dag skill：将“为报表页添加 CSV 导出功能”拆解为任务 DAG。

   Agent 编写 `.orca-dag/<timestamp>/{PRD.md,TECH_SPEC.md}`，并返回 Run ID。
2. **选择与配置：** 在完整 **Orchestration Panel** 标签页（或侧边栏）选中该 Run，设置默认 harness、受支持的逐节点覆盖（模型、effort、worktree 放置/lane）及 **Max parallel**。
3. **运行：** 点击 **「▶ Run with Orca」**（核对启动预检与账号配额提示）并确认 coordinator 交接；该 Run 的原 coordinator 会被权限隔离。
4. **观察与决策：** 在**会话（Session）**页签查看会话记录中的工具调用，在**消息（Messages）**气泡中与 Worker 交互，在**待处理 / 决策**中处理审批门禁与权限请求，并可用**恢复会话（L1 Native Resume）**在原工作区重新打开符合条件的本机会话。
5. **调整计划：** 任务定义或依赖有变化时，让 Agent 在新 Run 重绘，保留旧 Run 作为历史。

## 核心特性

- **双形态体验（完整标签页工作台 + Orca 精简右侧栏）**：
  - **完整标签页（`App.tsx`）**：支持深浅双主题（自动跟随 Orca 宿主主题）的四区黑白灰 IDE 编排工作台——左侧舰队与门禁导航、中央常驻 React Flow DAG 画布 / 状态泳道 / Run 历史 / 工作区与清理 / 执行与运行时能力、底部可调高坞（`实时事件流`、`Worker 输出`、`变更请求账本`）以及右侧上下文检视面板（`消息`、`会话`、`任务`、`启动配置`）。
  - **精简右侧栏（`SidebarApp.tsx`）**：专为窄侧栏（`320–450px`）设计的单栏伴生界面——Run 进度条与筛选、3 个核心页签（**任务** / **待处理** / **活动**）、下钻任务详情复用与完整 Web 完全一致的 `ChatPanel` **消息**聊天气泡、**会话**工具卡片与**输出**流，顶部仅保留一个 `↗ 标签页` 入口打开或原地复活完整标签页。
- **实时会话流与插件 Hook 加速**：统一的 `OutputTail` SSE（`/api/workers/:dispatchId/output/stream`）从精确对应 Worker 的原生 `worker-read` 会话记录生成可折叠的**会话**卡片。Agent 状态、工具和提示词事件只通过终端 ID 提前唤醒读取；工具输入输出预览和提示词内容不会经过插件桥接。
- **L1 原生会话恢复**：通过需认证的只读 `POST /api/workers/:dispatchId/resume-preview` 预检已退出 Worker 的会话是否精确匹配同一本地工作区、同一 Provider 的历史记录。`POST /api/workers/:dispatchId/resume` 拒绝活跃会话与已有面板，只将 `agent.resume` 打开的新面板绑定到新 Dispatch（`worker-start --terminal --retry-of`），并记入 `sessions.json` 的 `resumeAttempts`。OMP 和 Antigravity 不支持此路径。
- **Agent 启动控制与预检**：逐节点选择已验证 harness（`claude`、`codex`、`opencode`、`omp`、`antigravity`），支持模型/effort 覆盖（含 Orca ≥ 1.4.263 上的 OMP `--effort`）、OpenCode 自动 / Mini TUI / 完整 TUI 模式以及账号配额预检（`GET /api/accounts`）。
- **工作区放置与 Lane**：支持 4 种本地放置及 2 种远程放置；lane 中的任务串行共用隔离工作区，跨工作区汇合保留人工集成检查点。
- **运维、权限与审计**：单次 Worker 权限弹窗审批（`POST /api/workers/:dispatchId/permission`）、未派发任务的规范审批门创建、按需工作区清理与已合并分支安全删除，以及变更前记录的请求审计账本（`.orca-dag/requests.jsonl`）。
- **中英双语原生支持**：一键无缝切换中英文，语言偏好持久化，底层诊断与报错保留英文原文对齐。

## 关键安全边界与原则

- **任务定义不可变**：spec、标题与依赖不能原地修改，状态和结果仍可更新。调整定义须新建 Run；不要用 `reset --tasks` 重绘，它会清空所有 Run。
- **未知不等于死亡**：unknown 或断连的 worker 仍占用并发槽位；不确定性不能授权自动重试、取消或替代启动。
- **消息、coordinator 权限与恢复**：不同运行时的收件箱与 coordinator 语义不同；遵循已安装的指南。官方公共编排契约为 contract 1（`orchestration.contract.v1`），运行时协议为 3，联邦生命周期结算协议为 3，控制邮件协议为 2；`[orca-dag:merge-inputs-v3]` 是本地 viewer 契约标记。一次性 coordinator 变更拒绝隐式接管（必须携带显式控制确认，否则报 409 `coordinator_control_required`）。StopReason 升级是事件，非可回复提问。`sessions.json` 中的关键恢复账本（`mailboxChecks`、`guidanceSends`、`operatorMessages`、`resumeAttempts`）具有权威恢复效力，不能在不支持的旧版读取器间安全热降级。Worker 输出、释放和保留严格限制在选定 Run 范围内。未完成的远程观测（`partialHostErrors`）跨 worker 列表各页汇总保留，绝不因主机错误清除债务。详见[编排教程](docs/tutorials/orchestration_zh.md#会遇到的-worker-与收件箱参数)与 [HTTP API](docs/reference/http-api_zh.md#指导消息投递恢复与后续任务生命周期)。
- **本地控制面**：服务只监听 `127.0.0.1`，不启用 CORS，前端变更需要 `X-Orca-Dag-Token`。原生插件通过独立的用户私有注册表发现并验证 viewer，绝不使用工作区数据。如何连接受信任的 viewer，见 [HTTP API 与安全](docs/reference/http-api_zh.md)。自定义命令须显式启用。
- **OMP / Antigravity**：本地 Linux 的 Current 或精确 Existing 要求运行中的 Orca 与解析后的 CLI 均 ≥ **1.4.245**；新建 Git 工作树（`new-child`、`new-top-level`）和工作区 lane 要求两者均 ≥ **1.4.246**。OMP `--effort` 要求运行中 Orca ≥ **1.4.263**；Antigravity 拒绝非空 effort。详见[放置、输出、Stop 与验证边界](docs/reference/compatibility_zh.md#验证边界与限制说明)。

## 文档导航

完整入口见[文档导航](docs/README_zh.md)（[English](docs/README.md)）。

| 分类 | 文档 |
| --- | --- |
| 教程 | [规划任务 DAG](docs/tutorials/orchestration_zh.md) · [操作 viewer](docs/tutorials/viewer-operations_zh.md) · [工作树隔离](docs/tutorials/worktree-isolation_zh.md) · [Orca 插件指南](plugin/README.md) |
| 参考 | [兼容性](docs/reference/compatibility_zh.md) · [功能](docs/reference/viewer-features_zh.md) · [架构](docs/reference/architecture_zh.md) · [HTTP API 与安全](docs/reference/http-api_zh.md) · [技能中文审阅版](docs/SKILL_zh.md) |
| 开发 | [构建、验证与发布](docs/development_zh.md) · [UI 布局](docs/ui-layout_zh.md) |

## 卸载

```bash
npx orca-orchestration-launcher uninstall   # 可选加 --dry-run 预览清理清单，或加 --purge 清除状态
```

卸载会移除已安装的 skill、解除符号链接、安全关闭残留的 coordinator 终端、清理当前工作区的私有 viewer 注册记录和旧版 `.orca-dag/endpoint.json`，并移除受管 `.gitignore` 规则。规划文档与 Orca 历史记录始终保留。

## 常用开发者命令

```bash
npm install                # 安装依赖
npm run check              # skill 校验、类型检查、测试与 Web 构建
npm run dev                # 联调前后端（:5173 / :8787）
npm run build:plugin-panel # 构建插件侧边栏 SPA 与内置后端到 plugin/ 供 Orca 开发加载
npm run build:plugin       # 构建零依赖原生插件产物到 dist-plugin/
```

打包、OIDC 发版和显式 `verify:live` 验证见[开发指南](docs/development_zh.md)。真实验证会启动真实 worker 并消耗 provider 用量，不属于 `npm run check`。
