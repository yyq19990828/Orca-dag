# Orca DAG — skill + viewer

[English](README.md) | 简体中文

> 本项目 fork 自 [ZinkLu/Orca-Orchestration](https://github.com/ZinkLu/Orca-Orchestration)，独立扩展并以 [`orca-orchestration-launcher`](https://www.npmjs.com/package/orca-orchestration-launcher) npm 包发布。

Orca DAG 将「与 Agent 对话规划」和「可视化调度与执行」拆分为两个清晰协作的模块：

1. **Skill**（`skill/SKILL.md`）：你的 agent 按 PRD → 技术设计 → Orca 任务 DAG 规划工作，命令遵循与运行时匹配的编排指南。规划仍由你的 agent 负责，viewer 不内嵌 Agent SDK。
2. **Viewer**（`server/` + `web/`）：查看实时 DAG、配置逐节点启动选择，由内置 coordinator 按依赖派发就绪任务。

![蜡笔风 viewer：全宽 DAG + 默认 harness/最多并行/Run 工具条 + 带每节点 harness 与模型选择的只读节点详情](docs/screenshot.png)

## 前置要求

下文 CLI 示例中的 `orca` 适用于 Orca 管理的终端；Linux 普通终端应使用 `orca-ide`，避免误调用 `/usr/bin/orca` 读屏器。显式覆盖和开发版本遵循[启动解析规则](docs/tutorials/viewer-operations_zh.md#启动参数)。

- **Orca 版本**：**≥ 1.4.160 可浏览，≥ 1.4.205 可执行**（执行需要 supervised-worker 契约；1.4.160–1.4.204 自动进入只读模式）。
- **Orca 状态**：处于运行中（`orca status --json` 结果为 `"ready"`；否则先运行 `orca open`）且已开启实验特性（Settings → Experimental）。
- **工作区已纳管**：当前项目目录必须已通过 `orca repo add <path>` 或 `orca worktree` 纳入 Orca 纳管。
- **环境依赖**：Node.js ≥ 20，或独立发布二进制；两种方式都需要可用的 Orca CLI。
- **执行 Agent**：所选 worker agent 必须已在 Orca 中安装、配置和授权，能自主执行工具并发送 `worker_done`。

## 安装与启动

在 **Orca 管理的项目根目录**用普通 shell 启动。如果从 Orca 终端启动，请采用[清理继承环境的启动方式](docs/tutorials/viewer-operations_zh.md#启动参数)，避免终端身份冲突。

```bash
cd ~/any/orca-managed/project
npx orca-orchestration-launcher
```

此命令会为检测到的 coding agent 安装 `orca-dag` skill，初始化 `.orca-dag/` 忽略规则，并在 <http://localhost:8787> 启动 viewer。共享目录与自定义 agent 配置位置见 [skill 安装说明](docs/tutorials/viewer-operations_zh.md#skill-安装与-agent-目录)。规划文档与 viewer 历史保存在本地 `.orca-dag/`。

> **无 Node.js 环境？** 可从 [GitHub Releases](https://github.com/yyq19990828/Orca-dag/releases) 下载独立预编译二进制运行。若仅需安装 skill 而无需 viewer：`npx skills add yyq19990828/Orca-dag --skill orca-dag --global`。

## 快速开始

完成安装后：

1. **与 Agent 规划：**
   > 使用 orca-dag skill：将“为报表页添加 CSV 导出功能”拆解为任务 DAG。

   Agent 编写 `.orca-dag/<timestamp>/{PRD.md,TECH_SPEC.md}`，并返回 Run ID。
2. **选择与配置：** 在 viewer 选中该 Run，设置默认 harness、受支持的逐节点覆盖及 **Max parallel**。
3. **运行：** 点击 **「▶ Run with Orca」** 并确认 coordinator 交接；该 Run 的原 coordinator 会被权限隔离。
4. **观察与决策：** 查看 Activity、Chat 和 worker 结果。处理审批门；跨工作区集成门须在核验实际集成后再确认。
5. **调整计划：** 任务定义或依赖有变化时，让 agent 在新 Run 重绘，保留旧 Run 作为历史。

## 核心特性

- **可视化与手绘美学**：SVG `feTurbulence` 蜡笔风格描边、状态动态涂鸦动画、层级与依赖连线分离、dagre/力导向布局自由切换。
- **Agent 启动控制**：逐节点选择 harness，受支持的适配器提供模型/effort 覆盖；OpenCode 可选自动、Mini TUI 或完整 TUI。
- **工作区放置与 Lane**：支持 4 种本地放置及 2 种远程放置；lane 中的任务串行共用隔离工作区，跨工作区汇合需要人工确认集成。
- **监控与审计**：实时 Activity 事件流、按阶段分组的 Chat、check receipt、worker 干预、后台会话恢复及变更请求审计。
- **中英双语原生支持**：顶栏一键无缝切换中英文，语言偏好随浏览器持久化，底层诊断与报错保持英文原文对齐。

## 关键安全边界与原则

- **任务定义不可变**：spec、标题与依赖不能原地修改，状态和结果仍可更新。调整定义须新建 Run；不要用 `reset --tasks` 重绘，它会清空所有 Run。
- **未知不等于死亡**：unknown 或断连的 worker 仍占用并发槽位；不确定性不能授权自动重试、取消或替代启动。
- **本地控制面**：服务监听 `127.0.0.1`，不启用 CORS，变更请求需要 `X-Orca-Dag-Token`。自定义命令须显式启用。

## 文档导航

完整入口见[文档导航](docs/README_zh.md)（[English](docs/README.md)）。

| 分类 | 文档 |
| --- | --- |
| 教程 | [规划任务 DAG](docs/tutorials/orchestration_zh.md) · [操作 viewer](docs/tutorials/viewer-operations_zh.md) · [工作树隔离](docs/tutorials/worktree-isolation_zh.md) |
| 参考 | [兼容性](docs/reference/compatibility_zh.md) · [功能](docs/reference/viewer-features_zh.md) · [架构](docs/reference/architecture_zh.md) · [HTTP API 与安全](docs/reference/http-api_zh.md) |
| 开发 | [构建、验证与发布](docs/development_zh.md) · [UI 布局](docs/ui-layout_zh.md) |

## 卸载

```bash
npx orca-orchestration-launcher uninstall   # 可选加 --dry-run 预览清理清单，或加 --purge 清除状态
```

卸载会移除已安装的 skill、解除符号链接、安全关闭残留的 coordinator 终端并清理 `.gitignore` 规则。规划文档与 Orca 历史记录始终保留。

## 常用开发者命令

```bash
npm install            # 安装依赖
npm run check          # skill 校验、类型检查、测试与 Web 构建
npm run dev            # 联调前后端（:5173 / :8787）
```

打包、OIDC 发版和显式 `verify:live` 验证见[开发指南](docs/development_zh.md)。真实验证会启动 Codex worker 并消耗 provider 用量，不属于 `npm run check`。
