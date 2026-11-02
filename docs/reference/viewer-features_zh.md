# Viewer 功能特性参考

[English](viewer-features.md) | 简体中文

> [返回文档索引](../README_zh.md) · [返回 README](../../README_zh.md)

本参考文档对 orca-dag viewer 的核心特性进行分类梳理，涵盖界面呈现、执行调度、多 agent 与模型支持、工作树隔离、监控审计及双语本地化规范。关于逐步操作流程请参考[操作教程](../tutorials/viewer-operations_zh.md)，底层版本门槛请参考[兼容性矩阵](compatibility_zh.md)。

## DAG 可视化与布局算法

- **手绘蜡笔设计风格**：采用 SVG `feTurbulence` 滤镜生成波动手绘描边，搭配米色速写本底色画布。
- **状态感知配色与 Harness 徽章**：节点按 `pending / ready / dispatched / completed / failed / blocked` 映射专属颜色，并在节点右上角明确标注其绑定的执行 harness。
- **布局算法即时切换**：顶栏提供横向分层（LR）、纵向分层（TB，基于 dagre / Sugiyama）以及力导向布局（Fruchterman–Reingold）；提供 **↻ Re-layout** 一键重置自动排版，用户的布局选择自动保存至工作区配置。
- **自由拖拽与持久化**：用户可手动拖拽节点微调排版，拖拽后的坐标在后台实时轮询刷新中保持固定；未手动调整的节点继续跟随自动布局算法。
- **层级关系与执行依赖分离**：Task 的 `parent_id` 以淡色点线括弧（子节点端带小圆环）呈现，与带有箭头的铅笔质感依赖连线明确区分。父子关系不影响任务就绪判定与拓扑调度，可在顶栏通过 **Hide/Show parent links** 控制显隐。
- **生动的执行期动画**：
  - `dispatched`（执行中）节点表面呈现连续循环的蜡笔斜纹涂鸦动画；
  - 执行中节点向外流出的依赖连线先以游动虚线草稿呈现，随后以铅笔笔触沿有向箭头向下游逐步加粗描绘为实线。
- **显式主代理阶段（Lead Stage）**：支持将 Run 中的某个关键阶段标记为语义上的主导 Agent。被标记节点叠加专属的靛蓝双层外框与金色 `★ Lead` 徽章，同时保留底层状态颜色。此功能仅为 viewer 本地展示元数据，不改变底层协调者权限。

## 执行调度与协调者生命周期

- **▶ Run with Orca / ⏹ Stop 控制**：
  - 点击 Run 启动 viewer 内置的自驱动协调者，接管该 Run 的调度循环；
  - 调度根据 **Max parallel** 设置及可见活动 fleet 容量限制直接派工；这不是覆盖所有 helper 的运行时硬上限；
  - Stop 请求停止本 viewer 负责的 worker，并逐项汇报结果；委派归属或未知状态不会被当成可以一并强杀的依据。
- **落定 Worker 终端的生命周期管理**：
  - `worker_done` 获 Orca 接受后，viewer 归档输出并默认请求释放；运行时归属判定仍可能保留窗格，不保证自动关窗；
  - 若存在可兼容的后续即刻就绪任务（相同 harness、相同工作区且模型一致），且具备新鲜精确的已连接 PTY 证据，支持通过 `worker-start --terminal` 实现**终端复用**；OpenCode、OMP、Antigravity 均不参与，以保留新会话与模型身份；
  - 若勾选 **Retain for debugging**，则显式保留 worker 终端供开发者事后排查，绝不强行关闭。
- **启动参数不可变锁**：任务一旦产生首次 Dispatch，其 harness、模型、effort、运行环境和放置模式即永久锁定。锁状态在 viewer 重启后依然生效，后续重试强制沿用原启动配置。协调者运行期间，尚未启动的任务也会暂时冻结，停止执行后未启动任务重新开放编辑。
- **调度器与就绪队列面板（Scheduler）**：提供紧凑卡片实时展示当前就绪波次、协调者可用容量以及各等待阶段的阻断证据（明确指明依赖的上游任务及状态、阻塞的决策门、槽位耗尽或状态未知）。
- **节点详情只读卡片**：点击任务节点可查看只读 spec 预览（支持一键展开完整内容）。结构化执行结果会自动解析出简报、修改文件列表及产物路径，复杂 payload 折叠收纳于技术详情中。

## Harness 适配、模型与推理力度

- **已验证 Harness 矩阵**：`claude`、`codex`、`opencode`、`omp`、`antigravity` 在各自[有记录的版本与放置范围](compatibility_zh.md)内可选。未单独配置的节点继承顶栏默认 harness（`claude`）。原生基线不代表尚未运行的 viewer/重启检查已通过。
- **未验证 Harness 明确拒绝**：`gemini`、`grok`、`cursor`、`droid`、`kimi` 尚未获得具体的 supervised worker 运行时验证，viewer 不再提供内置预设，亦不暴露可用于启动的选项。若节点配置或已保存设置尝试以这些未验证 harness 启动，将被前端与服务端以前置错误 `unverified_harness` 明确拒绝，绝不进行静默替换或自动迁移；历史已落定的 worker 数据与相关记录在 viewer 中保持只读可查。
- **实验性自定义命令**：需显式设置环境变量 `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` 方可解锁自定义命令，且仅走本地兼容路径、不支持隔离放置。自定义命令属于实验性逃生通道，**不构成**已验证支持承诺；即使开启该开关，上述 5 个未验证 bare ID（`gemini`、`grok`、`cursor`、`droid`、`kimi`）依然被直接拒绝并报错 `unverified_harness`，严禁将其作为 bare ID 绕过验证机制。
- **技能安装与规划能力独立保留**：Agent 的 skill 安装（如 Claude Code、Codex、Cursor、OpenCode、Gemini、Grok、Droid、Kimi）和阅读 `SKILL.md` 的建图规划支持依然完整保留，因为建图端与 skill 生态能力与 worker 执行验证相互独立。
- **每节点模型覆盖**：
  - `opencode` harness：
    - **建议性发现与下拉选单**：通过本地工作区模型发现接口（`GET /api/models/opencode`）动态加载。作用域限定于 `local-workspace`；失败时提供受控英文诊断且不泄露 stderr。明确区分成功但目录为空（`status: "available"`、空 `models`）与发现失败（`status: "unavailable"`）。
    - **下拉选单与手动自由文本输入**：支持直接从发现目录中选取，亦可在文本框中手动填写 `provider/model[#variant]`。
    - **草稿校验与持久化规则**：自由文本输入校验严格匹配 `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:#[A-Za-z0-9._-]{1,64})?$/` 正则。不合法的输入被标记为 `aria-invalid`，且绝不写入节点配置存储；清空文本框则重置恢复为默认模型（`null`）。
    - **已保存但不在目录中的模型保留**：若节点此前保存的模型在本地发现目录中不存在（如自定义 provider 或宿主环境差异），该模型依然作为候选项保留在下拉列表中，绝不自动抹除。
    - **启动锁定（Launch-Locked）**：任务一旦派发过首次 Dispatch 或协调者处于运行中，模型下拉选单与手动输入文本框连同 harness、effort、placement 一同置灰禁用（`disabled={launchLocked}`）。
  - `claude` 通过 `worker-start --model` 传递模型；
  - 本地 POSIX Codex 在当前/已有工作区、运行中的 Orca ≥ 1.4.217 时使用原生模型启动；旧版/未知运行时及本地新建工作区保留预启动绑定路径，远程与 Windows 使用原生路径。详见[Codex 启动边界](../tutorials/viewer-operations_zh.md#codex-原生启动与兼容路径)。
  - **OMP / Antigravity**：自由文本形式的完整 selector，原样作为单个原生 `--model` 参数传递，或省略以使用已配置默认模型。要求运行中的 Orca 与解析后的 CLI 均 ≥ 1.4.245，仅本地 Linux 的 Current/精确 Existing，不能使用 lane。原生 `worker-start --agent` 将 Chat/Terminal 选择留给 Orca 设置，viewer 不检查或覆盖偏好。Terminal TUI 基线使用 OMP 18.15.0 与 Antigravity 1.4.12；Native Chat 尚未实测，但不拦截。不提供预启动绑定、回退、通用复用、新工作树、远程或 Windows 路径。
- **推理力度（Effort）**：`claude`、`codex` 可选择各自支持的力度，且必须同时设置模型；清空模型会清空 effort。原生启动传递 `--effort`，兼容预启动 Codex 则在启动命令中设置。OMP/Antigravity 拒绝所有非空 effort，即使同时指定模型；已保存的不支持值保持可见并提供明确清除入口，清空模型不会静默删除它们。
- **OpenCode 启动模式与原生路由边界**：
  - **自动模式（默认）**：未指定模型且 Orca ≥ 1.4.220 时使用原生 `opencode2`；纯净显式模型（不含 `#variant`、不带 effort、非 lane、非 Windows、当前/已有放置、非 TUI 模式）在运行中 Orca ≥ 1.4.241+ 上使用独立的 Orca 原生 `opencode` 启动器。本地目录发现仅具建议性，不代表执行宿主真实可用。
  - **兼容路径保留**：显式 Mini TUI、Full TUI、模型变体（`#variant`）、推理力度（effort）、lanes、新建工作树（new child/top-level）及远程放置均保留各自适配器与兼容路径。
  - **启动前路由判定与拒绝规则**：启动前做出路由判定；原生启动被拒绝后绝不启动替代 worker 或静默降级重试。
  - **显式 Mini TUI / 完整 TUI**：要求本机 Linux、当前/已有且非 lane 工作区、运行中的 Orca ≥ 1.4.222 及 OpenCode ≥ 2.1.2；
  - **实验性 API 预选模型完整 TUI（`ORCA_DAG_OPENCODE_TUI=1`）**：在 Orca ≥ 1.4.222 上针对指定模型使用预建 API 会话，会话与终端身份持久化于 `.orca-dag/sessions.json`。Stop 操作先通过 API 中断执行，再执行编排记账，提供更精细的外部进程控制。

## 工作区隔离、放置矩阵与 Lanes

- **按工作区隔离的 Run 视图**：Orca 编排注册表全局共享，但 viewer 仅展示任务创建者身份与当前工作区匹配的 Run，杜绝跨工作区混淆。支持新建 Run、游标分页加载历史 Run 以及精确 ID 查询。
- **Run 健康度徽标与已移除工作**：直观展示 Run 当前归属与健康状态（`viewer-owned / external / unbound / inconsistent`），包含各来源计数、警告以及可选的已移除工作账本证据：
  - **已移除工作摘要（`health.removedWork`）**：展示已移除指标（tasks、dispatches、workers、terminals、覆盖范围 `complete` 或 `partial`、记录起始时间、最近移除时间以及 `activeWorkersAtRemoval`）。宿主不支持或数据缺失时为 `null`，明确提示不可用，缺失数据绝不补 0。
  - **按需分页明细**：仅在操作者显式点击“View removed-work details / 查看已移除工作明细”时通过 `GET /api/runs/:runId/removed-work` 按需拉取历史记录，避免初次数据膨胀。
  - **不透明游标与官方页限制**：单页最多拉取 200 行官方上限。支持“Load more”，具备客户端游标环路检测与停滞游标校验（友好处理 502/503 重试与内联告警）。
  - **历史活跃状态标识**：条目附带 `activeAtRemoval` 标记，表明该工作项在被移除的历史瞬间是否处于活跃运行中——此快照属于历史账本，绝不可等同于当前存活 fleet。
  - **未知与未来 kind 兼容**：对非标准 kind 标记 `unreadable: true` 并安全降级展示，绝不破坏界面渲染。
  - **只读不可变与无重置**：已移除工作历史为只读审计证据，viewer 不提供重置按钮或任何状态重置接口。
- **本地放置矩阵（4 种模式）**：
  1. `Current`：在当前协调者工作区运行（默认）；
  2. `Existing`：放置于 Orca 已注册发现的精确工作区（`worktree list` 返回的完整选择器）；
  3. `New Child`：随 worker 启动新建子 worktree；
  4. `New Top-Level`：随 worker 启动在指定仓库下新建独立的顶层 worktree。
  新建模式允许配置确定性名称、setup 脚本策略（`run / skip / inherit`）、基准分支、显示名称与备注；现有工作区严禁携带创建类参数，亦绝不重跑环境初始化。
- **远程放置支持**：针对已配置的远程环境（`orca environment list`），支持将任务放置于远端已有工作区或新建顶层工作树；跨主机的模糊放置（远程 current 或 new-child）在接口层面强制禁止。
- **工作区 Lane（串行复用工作区）**：支持将一组依赖有序的任务绑定至一条共享的本地非 current 工作区 Lane。同一 Lane 内的任务严格串行执行（同一时刻仅允许一个活动 Dispatch），不同 Lane 之间受 Max parallel 约束并行。若工作区身份证据不足，Lane 冻结为 `unverifiable`，绝不盲目挪移或随意重置。
- **跨 Lane 汇合集成门**：当某个任务的上游依赖分布于不同的工作区 Lane 时，即使上游任务全部成功，也并不代表代码已经合并。协调者会自动建立幂等的跨 Lane 集成门（`[orca-dag:integration]`），强制要求人工介入并在确认代码集成后标记 `integrated`，viewer 自身绝不擅自执行 Git 分支合并或提交。
- **原生代码审阅与清理**：任务完成后，支持直接在 Orca 编辑器中打开精确工作区的改动文件和 diff 对比；工作树清理强制调用 `orca worktree rm`，且必须在 worker 归属落定并经人工确认后方可执行。

## 监控、会话通信与审计

- **独立 Stage 卡片与通信中心**：
  - 选中节点右侧弹出设置与 spec 详情卡片；
  - 专用左侧栏集成 Activity 时间线与 Chat 会话面板。Activity 采用 SSE 实时事件流，Chat 将 Run 作用域内的事件按执行阶段分组呈现，展示协调者派工气泡与 worker 上报。
- **双向会话与指导投递**：支持直接回复 worker 提出的升级提问，亦可向经证实仍处于活跃状态的 Dispatch 主动投递持久化指导消息。
- **实时 Coordinator Check 流**：每轮协调者检查均会在聊天区下方留下有界的实时 receipt 回执（记录空检查、消息类型、耗时以及实际观测到的 agent/模型状态），心跳与状态更新直接在此展现，不再污染聊天历史。
- **协调者群发广播**：支持向白名单受众（`@all` 或已发现的工作树列表）发送经过预览确认的广播指导，严格禁止发送生命周期消息。
- **单 Dispatch 级运维干预**：
  - 针对存活的 Dispatch 发起单点终止（`worker-stop`）；
  - 针对已退出或结果未知的尝试发起放弃（`worker-abandon`）；
  - 针对本地报告等待输入的 worker 发起终端聚焦（`terminal switch`，严格依赖新鲜的 `agentWait` 证据）。
- **Workers 详细面板**：提供完整的 fleet 监控视图，展示存活状态、执行主机、请求与实际生效的启动参数对比、带来源标记（auto/terminal/transcript）的输出日志，并支持对已加载日志的关键词搜索和本地文件下载。

## 后台会话恢复与阻断处理

- **后台会话绑定与恢复（Recovery）**：当 Claude 的 worker 进程、Codex 的引导标识或 OpenCode 的专属标题能唯一确定会话时，系统自动将 provider 端的 session ID 关联绑定并写入 `.orca-dag/sessions.json`，亦支持手动填入 ID 进行绑定；支持按需发起 provider 状态探测，探测结果仅供排查，不影响任务落定。
- **阻断 Stage 的人工结算与重试**：针对已失败且经证实已退出的 Dispatch，提供人工核验后完成任务（标记成功或手动填入结果）或显式重试；重试强制继承原有的 harness、模型和工作区配置。
- **全生命周期变更审计（Request Audit）**：viewer 发起的每一项变更（启动、停止、释放、保留等）均携带持久化的 `--retry-request` ID，并在发起前写入 `.orca-dag/requests.jsonl` 账本。审计面板提供单项请求的只读 Inspect 操作，向 Orca 发起实时的 `request-show` 探测，准确呈现 `completed`、`pending`、`absent` 或 `unknown` 状态，绝不盲目重放请求。

## 界面语言与国际化

- **原生双语无缝切换**：顶栏提供 **中 / EN** 切换按钮，点击即刻实现全界面中英文语言即时切换。
- **首次语言选择**：首次访问时，`navigator.language` 以 `zh` 开头则使用简体中文，否则使用英文。
- **浏览器持久化**：语言偏好保存在浏览器本地存储（`localStorage` 键 `orca-dag:lang`），刷新页面或重启服务不丢失，且绝不向工作区磁盘写入无关文件。
- **全界面深度适配**：所有 DAG 节点、harness 标签、Run 选择器、Activity 时间线、Chat 对话、Lanes 面板、审批门及对话框均完整支持中英对照。
- **保持底层诊断原汁原味**：服务器底层的错误代码、readiness 失败原因及 Orca CLI 原生输出均**严格保持英文原文回显**，确保前端界面展示的信息可与服务端日志完全对齐，避免因翻译失真导致排错困难。
