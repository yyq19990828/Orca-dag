# Viewer 功能特性参考

[English](viewer-features.md) | 简体中文

> [返回文档索引](../README_zh.md) · [返回 README](../../README_zh.md)

本参考文档对 orca-dag viewer 的核心特性进行分类梳理，涵盖界面呈现、执行调度、多 agent 与模型支持、工作树隔离、监控审计及双语本地化规范。关于逐步操作流程请参考[操作教程](../tutorials/viewer-operations_zh.md)，底层版本门槛请参考[兼容性矩阵](compatibility_zh.md)。

## 双形态工作台、原生插件与 DAG 可视化

- **完整标签页工作台（四区双主题 IDE 布局）**：高克制黑白灰深浅双主题 IDE 工作台（`styles/ide-workbench.css`，自动跟随 Orca 宿主主题并支持手动切换），配备自定义分叉汇聚 DAG 品牌图标（`DagBrandMark`）、左侧实时舰队与决策门禁导航、中央常驻 React Flow DAG 画布 / 状态泳道 / Run 历史账本 / 工作区与清理 / 执行与运行时能力、底部可调高坞（`实时事件流`、`Worker 输出`、`变更请求账本`）及右侧上下文检视面板（`消息`、`会话`、`任务`、`启动配置`）。
- **精简右侧边栏伴生面板（`orchestration-panel` 内置 `SidebarApp`）**：原生 Orca 伴生插件面板（`?view=sidebar`，`320–450px`），内嵌自托管后端服务（`plugin/server/index.mjs`，无需用户手动开启前后端终端）。提供紧凑 Run 进度条与状态筛选、3 个主标签（**任务** / **待处理** / **活动**），任务下钻详情复用与完整工作台完全一致的 `ChatPanel` **消息**聊天气泡、**会话**工具卡片与**输出**流，顶部保留唯一 `↗ 标签页` 入口（`POST /api/open-tab`）打开或原地复活完整标签页。
- **实时会话工具卡片（`NodeSessionPanel`）**：由服务端统一 `OutputTail` SSE（`/api/workers/:dispatchId/output/stream`）与插件实时 `agent.tool.after` / `agent.status.changed` Hook（仅存内存并按 `callId` 去重）共同驱动，在侧边栏与完整标签页的**会话**页签中实时展示可折叠工具调用卡片与对话轮次。
- **L1 原生会话恢复**：通过 `GET /api/workers/:dispatchId/resume-preview` 预检已退出本机已验证 Worker 的可恢复会话，经 `POST /api/workers/:dispatchId/resume` 调用 Orca 原生 `agent.resume` 恢复原终端并以 `worker-start --terminal --retry-of` 绑定新 Dispatch，全流程写入 `sessions.json` `resumeAttempts`。
- **状态感知配色与 Harness 徽章**：节点具有固定尺寸（280×120px，标题 16px，数据 14px），按 `pending / ready / dispatched / completed / failed / blocked` 映射专属颜色，并在节点右上角明确标注其绑定的执行 harness。轮询周期为 2 秒。
- **DAG 画布懒加载**：`DagView` 在首次进入“任务”图视图时才进行动态懒加载（`React.lazy`），并在挂载后常驻内存，大幅降低首屏渲染负载与内存消耗。
- **布局即时切换**：视图面板按任务状态、连线、布局分组，提供六类状态计数、连线示例、父子连线开关，以及横向分层（LR）和纵向分层（TB，基于 dagre / Sugiyama）；**重新布局**重置手动拖拽的位置。布局选择保存至工作区配置，旧力导配置迁移为横向，不改变执行设置。
- **自由拖拽与持久化**：用户可手动拖拽节点微调排版，拖拽后的坐标在后台实时轮询刷新中保持固定；未手动调整的节点继续跟随自动布局算法。
- **层级关系与执行依赖分离**：Task 的 `parent_id` 以淡色点线括弧（子节点端带小圆环）呈现，与带有实线箭头的依赖连线明确区分。父子关系不影响任务就绪判定与拓扑调度，可通过**视图 → 连线**中的开关控制显隐。
- **静态连线与受控动效**：依赖连线保持静态实线（`edge--idle`、`edge--run`、`edge--done`），消除持续流动的虚线循环。仅对具有明确执行证据的运行中任务显示轻量脉冲圆点（`@keyframes graph-executing`），并在页面隐藏、图非激活或启用 `prefers-reduced-motion: reduce` 时自动停用。
- **Task 私聊与详情页签（NodePanel）**：在画布中选中节点，URL 路由更新为 `#section=chat&task=<id>`，在操作区进入该 Task 的私聊 Messages 视图。完整的任务详情与启动配置（`NodePanel`）作为同级 **Task** 页签与 Messages、收件检查并列展示。首次访问该页签时挂载并在后续同级页签切换中常驻，无独立 `h1`、无关闭按钮、无 Escape 监听或自动聚焦，同时完整保留所有配置项、启动锁及运维跳转入口。
- **常驻通信侧栏**：右侧可调节宽度的操作面板（`.workbench-operations`，默认在 380–820px 之间根据视口预留空间动态缩放），承载会话、Task 详情配置、收件检查与完整运维分节。在 ≤900px 移动端视口下，通过顶部切换条在画布与操作区之间快速切换。
- **显式主代理阶段（Lead Stage）**：支持将 Run 中的某个关键阶段标记为语义上的主导 Agent。被标记节点叠加专属的金色 `★ Lead` 徽章，同时保留底层状态颜色。此功能仅为 viewer 本地展示元数据，不改变底层协调者权限。
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
- **Task 详情只读卡片与配置**：Task 详情页签（`NodePanel`）提供只读 spec 预览（支持一键展开完整内容）。结构化执行结果会自动解析出简报、修改文件列表及产物路径，复杂 payload 折叠收纳于技术详情中。

## Harness 适配、模型与推理力度

- **已验证 Harness 矩阵**：`claude`、`codex`、`opencode`、`omp`、`antigravity` 在各自[有记录的版本与放置范围](compatibility_zh.md)内可选。未单独配置的节点继承顶栏默认 harness（`claude`）。原生基线不代表尚未运行的 viewer/重启检查已通过。
- **未验证 Harness 明确拒绝**：`gemini`、`grok`、`cursor`、`droid`、`kimi` 尚未获得具体的 supervised worker 运行时验证，viewer 不再提供内置预设，亦不暴露可用于启动的选项。若节点配置或已保存设置尝试以这些未验证 harness 启动，将被前端与服务端以前置错误 `unverified_harness` 明确拒绝，绝不进行静默替换或自动迁移；历史已落定的 worker 数据与相关记录在 viewer 中保持只读可查。
- **实验性自定义命令**：需显式设置环境变量 `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` 方可解锁自定义命令，且仅走本地兼容路径、不支持隔离放置。自定义命令属于实验性逃生通道，**不构成**已验证支持承诺；即使开启该开关，上述 5 个未验证 bare ID（`gemini`、`grok`、`cursor`、`droid`、`kimi`）依然被直接拒绝并报错 `unverified_harness`，严禁将其作为 bare ID 绕过验证机制。
- **技能安装与规划能力独立保留**：Agent 的 skill 安装（如 Claude Code、Codex、Cursor、OpenCode、Gemini、Grok、Droid、Kimi）和阅读 `SKILL.md` 的建图规划支持依然完整保留，因为建图端与 skill 生态能力与 worker 执行验证相互独立。
- **每节点模型覆盖**：
  - `opencode` harness：
    - **建议性发现与下拉选单**：通过本地工作区模型发现接口（`GET /api/models/opencode`）动态加载。作用域限定于 `local-workspace`；失败时提供受控英文诊断且不泄露 stderr。明确区分成功但目录为空（`status: "available"`、空 `models`）与发现失败（`status: "unavailable"`）。
    - **下拉选单与手动自由文本输入**：支持直接从发现目录中选取，亦可在文本框中手动填写 `provider/model[#variant]`。
    - **草稿校验与持久化规则**：自由文本输入校验严格匹配 `/^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}(?:#[A-Za-z0-9._-]{1,128})?$/` 正则，支持首斜杠后带命名空间的多段路径（如 `openrouter/meta-llama/llama-3.1-70b-instruct#high`）。不合法的输入被标记为 `aria-invalid`，且绝不写入节点配置存储；清空文本框则重置恢复为默认模型（`null`）。
    - **已保存但不在目录中的模型保留**：若节点此前保存的模型在本地发现目录中不存在（如自定义 provider 或宿主环境差异），该模型依然作为候选项保留在下拉列表中，绝不自动抹除。
    - **启动锁定（Launch-Locked）**：任务一旦派发过首次 Dispatch 或协调者处于运行中，模型下拉选单与手动输入文本框连同 harness、effort、placement 一同置灰禁用（`disabled={launchLocked}`）。
  - `claude` 通过 `worker-start --model` 传递模型；
  - 本地 POSIX Codex 在当前/已有工作区、运行中的 Orca ≥ 1.4.217 时使用原生模型启动；新建子工作树与新建顶层工作树在本地 Linux、Orca ≥ 1.4.247、CLI ≥ 1.4.247 且 Codex CLI ≥ 0.166.0 时切换至原生启动（`canUseNativeCodexFreshWorktree`），并在 Run `run_44b240b8e6ee` 中完成真实端到端验证。旧版/未知运行时及非 Linux 环境保留预启动绑定路径，远程与 Windows 使用原生路径。详见[Codex 启动边界](../tutorials/viewer-operations_zh.md#codex-原生启动与兼容路径)。
  - **OMP / Antigravity**：自由文本形式的完整 selector，原样作为单个原生 `--model` 参数传递，或省略以使用已配置默认模型。Current 或精确 Existing 放置要求运行中的 Orca 与解析后的 CLI 均 ≥ 1.4.245。创建新建 Git 工作树（`new-child`、`new-top-level`）或任何工作区 Lane 则要求运行中的 Orca 与解析后的 CLI 均 ≥ 1.4.246。仅限本地 Linux；远程环境、macOS 与 Windows 均被拒绝。新建 child 放置必须具有明确正向识别的本地被托管 Git 父工作区；新建 top-level 放置要求精确的仓库标识符（`id:...` 或绝对路径 `path:/...`）指向已验证的本地 Git 仓库（拒绝模糊名称、普通目录、异构主机仓库且不自动 git-init）。工作区 Lane 仅共享工作区：首个 Task 创建或接纳工作区，后续依赖有序 Task 复用精确 Existing。每个 Task 均分配全新的原生 agent 会话与 Dispatch（绝不进行通用终端复用、禁止 `--terminal` 或 `--surface` 覆盖，拒绝后绝不回退）。原生 `worker-start --agent` 严格遵循用户的 Orca Chat/Terminal 设置，viewer 不检查或覆盖偏好。保留 1.4.245 的 Terminal TUI 与 OMP Native Chat 验证基线；1.4.246 上的真实端到端 Run `run_67072641a11a` 验证了 OMP 用户默认 Chat 与 Antigravity 用户默认 Terminal 在 4 条 Lane 下的串行工作区交接（共 8 个 Task、全新原生会话、零清理债务、setup `skip` 与配置默认模型）。不代表已实测新放置下的活动 Stop/重启、Antigravity Chat、Orca 运行时重启、setup `run`/`inherit` 或显式模型新放置。所有非空 effort 均被拒绝，即使同时指定模型。
- **推理力度（Effort）**：`claude`、`codex` 以及在运行中 Orca ≥ **1.4.263** 上的 `omp` 均可配合模型选择推理力度。原生启动传递 `--effort`，兼容预启动 Codex 则在启动命令中设置。Antigravity（以及 Orca < 1.4.263 上的 OMP）拒绝所有非空 effort；已保存的不支持值保持可见并提供明确清除入口，清空模型不会静默删除它们。
- **单次 Worker 权限弹窗审批（Orca ≥ 1.4.263）**：挂起的 Worker 权限请求会在聊天消息、待办聚焦与侧边栏**待处理**中就地展示，在 Orca 设置开启协调器权限审批后可通过 `POST /api/workers/:dispatchId/permission` 执行单次**允许一次**（`approve`）或**拒绝**（`deny`）。
- **OpenCode 启动模式与原生路由边界**：
  - **自动模式（默认）**：未指定模型且 Orca ≥ 1.4.220 时使用原生 `opencode2`；纯净显式模型（不含 `#variant`、不带 effort、非 lane、非 Windows、当前/已有放置、非 TUI 模式）在运行中 Orca ≥ 1.4.241+ 上使用独立的 Orca 原生 `opencode` 启动器。本地目录发现仅具建议性，不代表执行宿主真实可用。
  - **兼容路径保留**：显式 Mini TUI、Full TUI、模型变体（`#variant`）、推理力度（effort）、lanes、新建工作树（new child/top-level）及远程放置均保留各自适配器与兼容路径。
  - **启动前路由判定与拒绝规则**：启动前做出路由判定；原生启动被拒绝后绝不启动替代 worker 或静默降级重试。
  - **显式 Mini TUI / 完整 TUI**：要求本机 Linux、当前/已有且非 lane 工作区、运行中的 Orca ≥ 1.4.222 及 OpenCode ≥ 2.1.2；
  - **实验性 API 预选模型完整 TUI（`ORCA_DAG_OPENCODE_TUI=1`）**：在 Orca ≥ 1.4.222 上针对指定模型使用预建 API 会话，会话与终端身份持久化于 `.orca-dag/sessions.json`。Stop 操作先通过 API 中断执行，再执行编排记账，提供更精细的外部进程控制。

## 工作区隔离、放置矩阵与 Lanes

- **按工作区隔离的 Run 视图**：Orca 编排注册表全局共享，但 viewer 仅展示任务创建者身份与当前工作区匹配的 Run，杜绝跨工作区混淆。基于有界的工作区 Run 分页接口（`GET /api/runs/page?limit=1..100&cursor=`）加载历史，刷新保留遍历游标，外来 Run 如实标记 `workspace.owned: false`。
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
- **工作区 Lane（串行复用工作区）**：支持将一组依赖有序的任务绑定至一条共享的本地非 current 工作区 Lane。同一 Lane 内的任务严格串行执行（同一时刻仅允许一个活动 Dispatch），不同 Lane 之间受 Max parallel 约束并行。若工作区身份证据不足，Lane 冻结为 `unverifiable`，绝不盲目挪移或随意重置。原生 OMP 与 Antigravity 在本地 Linux、运行中的 Orca 与已解析 CLI 均 ≥ 1.4.246 时支持工作区 Lane 与新建 Git 工作树。准入检查与计划预览会评估 Lane 的种子放置，若版本低于 1.4.246 则在发起任何变更前直接拒绝。Lane 仅共享工作区：每个 Task 均分配全新的原生 agent 会话与 Dispatch，绝不复用终端进程或在拒绝后降级回退。
- **CLI 编排兼容性**：当解析后的 CLI ≥ 1.4.246 时，`runOrca` 会根据缓存的就绪探针为编排命令追加 `--full` 参数，防止 1.4.246 默认的精简 JSON 导致数据缺失；CLI 1.4.245 拒绝 `--full`，因此在调用前完成版本判断，遇到不确定响应绝不重试变更。真实验收证实单次 `POST /api/runs` 即可创建 Run（`run_2a67b90e6a94`），避免了因精简响应误报 500 或重复变更的问题。
- **跨 Lane 汇合集成门**：当某个任务的上游依赖分布于不同的工作区 Lane 时，即使上游任务全部成功，也并不代表代码已经合并。协调者会自动建立幂等的跨 Lane 集成门（`[orca-dag:integration]`），强制要求人工介入并在确认代码集成后标记 `integrated`，viewer 自身绝不擅自执行 Git 分支合并或提交。
- **原生代码审阅、安全清理与回收**：任务完成后，支持直接在 Orca 编辑器中打开精确工作区的改动文件和 diff 对比；工作树清理强制使用 `worktree` 字段调用 `orca worktree rm --worktree <worktree>`。提供按需候选审查（`review`）清单，清理安全判定会重新核查全局完整 fleet 列表（`listWorkers(undefined, { includeRemote: true })`），以覆盖未出现在终端列表中的其他 Run Chat；带安全删除已合并分支原生选项（`deleteBranch`）并显示 `preservedBranch` 证据，绝不从 Web 端强行删除未合并分支；受主工作区与活跃工作区保护。

## 监控、会话通信与审计

- **独立 Stage 卡片与规范审批门创建**：
  - 选中节点右侧弹出设置与 spec 详情卡片；可直接为同 Run 尚未派发的任务创建规范审批门（`POST /api/gates`），受 coordinator 生命周期锁保护；
  - 专用左侧栏集成 Activity 时间线与 Chat 会话面板。Activity 采用 SSE 实时事件流，在页面隐藏时（`document.visibilityState === 'hidden'`）自动暂停连接，重新可见时刷新重连，保留轨道收起期间的未读计数；Chat 展示协调者派工气泡、worker 上报，并区分可回复提问与非可回复的原生 `stopReason` 升级事件（`kind: 'stop_event'`）。
- **双向会话与指导投递**：支持直接回复 worker 提出的升级提问，亦可向经证实仍处于活跃状态的 Dispatch 主动投递持久化指导消息（支持嵌套 coordinator 重定向，不篡夺子所有权）。
- **独立收件检查**：单独的 Radix 页签保留有界的协调器检查回执、投递/重放详情、错误和 agent 快照，不将轮询记录插入聊天时间线。
- **Run 群聊与 Task 私聊**：共用同一份保留的编排消息。Task 发言标注 `@协调器`；群聊发送前明确选择 `@Task`，复用私聊的指导/回复接口及权限检查。点击 Task 头像进入对应私聊；私聊列表不再包含 Run 控制。窄面板先显示列表，返回时保留私聊/群聊分类。群聊不另建消息存储或自动广播给所有 worker；同一 Task 的发送中/未知指导保护在两种视图间共享，草稿按视图和收件人隔离。历史广播保留原始受众及仅证明入队的来源信息，HTTP 广播 API 仍独立保留。
- **单 Dispatch 级运维干预**：
  - 针对存活的 Dispatch 发起单点终止（`worker-stop`）；
  - 针对已退出或结果未知的尝试发起放弃（`worker-abandon`）；
  - 针对本地报告等待输入的 worker 发起终端聚焦（`terminal switch`，严格依赖新鲜的 `agentWait` 证据）。
- **Workers 详细面板**：提供完整的 fleet 监控视图，展示存活状态、执行主机、请求与实际生效的启动参数对比、部分主机错误汇总（`partialHostErrors`）、主动 Keep-open、显式 Release/Retain、原生 `autoReleaseAt`，以及带来源标记（auto/terminal/transcript）的输出日志。选择与请求生成代际标记防止旧异步结果覆盖新选中内容。NextAction 映射 inspect/read/release 绝不预设 abandon；显式 Abandon 为独立确认的权限隔离动作。支持对已加载日志的关键词搜索和本地文件下载。

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
