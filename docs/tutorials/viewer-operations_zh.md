# 教程：操作 orca-dag viewer

[English](viewer-operations.md) | 简体中文 · [文档导航](../README_zh.md)

本教程覆盖启动、配置、监控、恢复和 viewer 的日常操作流程。完整任务图示例见[编排教程](orchestration_zh.md)，工作区规则见[隔离教程](worktree-isolation_zh.md)。完整的接口清单见[HTTP API 参考](../reference/http-api_zh.md)，功能特性详见[功能特性参考](../reference/viewer-features_zh.md)，兼容性矩阵见[兼容性参考](../reference/compatibility_zh.md)。

viewer 作为独立进程运行，是因为 Orca 有意不内置调度器，而 Orca 插件面板也无法请求本 viewer 的 HTTP API。应用在本机回环地址提供 API 和 SPA，并可把界面打开到普通 Orca 浏览器标签。viewer 的 coordinator 调度 Task；Run、Dispatch、worker 和工作树的权威状态仍由 Orca 管理。

## 启动参数

从 **Orca 管理的工作区根目录**启动。viewer 只在进程启动时解析一次 CLI 和工作区；默认工作树选择器是该目录的真实路径。如果从子目录启动，创建终端时可能因路径没有注册而得到 `selector_not_found`。

```bash
cd /path/to/orca-managed/project
npx orca-orchestration-launcher
```

如果从 Orca 管理的终端中启动，应清除继承的 Orca 身份，让 viewer 新建的 coordinator 终端正常绑定 Run：

```bash
env -u ORCA_TERMINAL_HANDLE -u ORCA_TAB_ID -u ORCA_WORKSPACE_ID -u ORCA_WORKTREE_ID \
  WORKSPACE_DIR="$PWD" npx orca-orchestration-launcher
```

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `8787` | 本机回环地址的 HTTP 监听端口；Vite 开发界面使用 `:5173` 并代理 `/api`。 |
| `NO_OPEN=1` | 关闭 | 不自动打开浏览器。 |
| `WORKSPACE_DIR` | 进程当前目录 | 必须存在；解析成真实路径，作为所有 Orca 调用的 cwd 和默认 `path:` 工作区选择器。 |
| `ORCA_WORKTREE` | `path:<WORKSPACE_DIR>` | coordinator 与 Current worker 的显式 Orca 选择器，可覆盖路径默认值。 |
| `ORCA_CLI_COMMAND` | 自动选择 CLI | 指定准确的可执行文件及带引号的 argv；**不经 shell** 解析。管道、重定向、命令替换及未引用的 `$` 会被拒绝。 |
| `--no-skill` 或 `ORCA_DAG_NO_SKILL=1` | 安装 skill | 跳过将随包提供的 `orca-dag` skill 尽力安装到已有 agent 目录。 |
| `--no-workspace-init` 或 `ORCA_DAG_NO_WORKSPACE_INIT=1` | 初始化 `.orca-dag/` 忽略规则 | 跳过向工作区 `.gitignore` 添加规划产物管理规则；规划前请自行确认 `.orca-dag/` 已被忽略。 |
| `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` | 关闭 | 允许实验性自定义 harness 命令（实验性逃生通道，不构成已验证支持承诺）。它们走兼容性本地路径，不能使用隔离放置。即使开启该开关，未验证 bare ID（`gemini`、`grok`、`cursor`、`droid`、`kimi`）依然被直接拒绝。 |

CLI 自动选择顺序为：`ORCA_CLI_COMMAND` → 设置了 `ORCA_DEV_REPO_ROOT` 时的 `orca-dev` → Linux 且不在 Orca 终端内时的 `orca-ide` → `orca`。读取和修改都使用同一个已解析的 CLI。`GET /api/readiness` 分别报告 `cliVersion`、所选运行时的 `version` 与 `runtimeState`；较新的可执行文件不能证明目标正在运行或已升级。执行要求 CLI 1.4.205+，以及明确处于 ready 状态、稳定 appVersion 为 1.4.205+ 的运行时；状态未知、断连或启动中的运行时保持只读。Orca 1.4.160–1.4.204 仍可查看 Run。viewer 和 skill 可以通过 `npx orca-orchestration-launcher` 一起安装，也有独立发布的二进制文件。

启动时还会提示 `.orca-dag/<timestamp>/{PRD.md,TECH_SPEC.md}` 及默认 `.gitignore` 初始化是否成功。skill 为每个新计划创建独立的 UTC 时间戳目录，记录 Run id，并保留旧计划。这些忽略的文档不提交 Git，也不会自动复制到隔离工作树；Task spec 必须包含 worker 所需信息。旧版 `.orca/` 文档及其忽略管理块原样保留；新规划产物只使用 `.orca-dag/`。

### Skill 安装与 agent 目录

仅为检测到配置目录的 agent 安装 skill。Claude Code、Cursor、Gemini CLI、Droid、Grok、Kiro、Qoder 和 CodeBuddy 使用各自的 skill 目录；Codex、OpenCode、Pi、OMP 和 Kimi 共享 `~/.agents/skills`。即使 `.agents` 尚不存在，检测到这些 agent 的配置也会建立共享安装；没有 agent 配置的 HOME 不会被填充。Agent 的 skill 安装与规划能力与 supervised worker 执行验证相互独立。

`CLAUDE_CONFIG_DIR`、`GROK_HOME` 和 `KIRO_HOME` 可指定已存在的绝对 native-agent 配置路径；相对路径、HOME 本身及其祖先目录会被忽略。`CODEX_HOME` 参与 Codex 发现，但 skill 仍安装到共享目录。卸载时使用同样的目录覆盖设置。

内容未变时保留 mtime；配置路径、skill 目录或 skill 文件的符号链接均不会被跟随。旧版 Codex/OpenCode 或自定义配置目录内的单文件安装，仅在新位置不存在时迁移；有额外文件或链接的目录原样保留。安装发现与卸载使用相同解析器。

独立二进制安装示例：`tar xzf orca-dag-darwin-arm64.tar.gz && sudo mv orca-dag /usr/local/bin/ && orca-dag`。若只安装 skill、不启动 viewer，可使用 `npx skills add yyq19990828/Orca-dag --skill orca-dag --global`；该方式不初始化项目，规划前仍须确认 `.orca-dag/` 已被忽略。

## 点击 Run 之前先看懂界面

| 区域 | 展示的信息 | 可执行的操作 |
| --- | --- | --- |
| Run 选择器与健康徽标 | 当前工作区的 Run 历史；coordinator 状态为 `viewer-owned`、`external`、`unbound` 或 `inconsistent`，并提供可空的 `removedWork` 摘要与按需分页加载（不提供重置数据库控件）。 | 选择或新建 Run、分页加载旧 Run、查看已移除工作历史，或按精确 Run ID 查找。 |
| DAG 与 Stage 卡片 | Task 说明、依赖箭头、单独的父子连线、状态、结果和 worker 实际工作区。 | 选中 Stage，在设置锁定前选择其启动参数。 |
| Scheduler | 就绪波次、可用容量及每个等待中的 Stage 的原因。 | 区分依赖未满足、决策门、无空闲槽位或状态未知。 |
| Chat / Activity | 派工、回复、持久化发送、coordinator 检查和事件时间线。 | 回答问题，或向 Orca 已确认活跃的 Dispatch 发送指导。 |
| Operational details | Workers、决策门、工作区 lane、Recovery、能力和 Request audit。 | 重试、停止、放弃、集成或移除之前先查看证据。 |

DAG 每两秒刷新一次。拖动节点只改变画布位置；布局可选横向/纵向分层或力导向。可选的 **Lead Stage** 只在图中标记语义上的主 agent 阶段，不授予 Orca coordinator 权限。界面支持英文和简体中文，语言选择按浏览器保存。

## 启动选择及其设计逻辑

Orca Task 没有 harness、模型、放置位置或画布布局字段。viewer 将这些选择保存在工作区的 `.orca-dag/config.json`；浏览器 localStorage 只用于一次迁移及写入镜像。此文件存储的是**意图**，不是运行时 ID。实际 Dispatch、工作树、执行主机和终端必须从 Orca 回执和实时读取中取得。

| 设置 | 默认值或允许值 | 效果和限制 |
| --- | --- | --- |
| OpenCode 启动界面 | `auto` | 自动保留当前路由；可显式选择 Mini TUI / 完整 TUI，节点支持覆盖或继承。 |
| 默认 harness | `claude` | Stage 没有单独覆盖时使用。内置选项为 `claude`、`codex`、`opencode`、`omp`、`antigravity`，须遵守各自版本/放置限制。未经验证的 harness（`gemini`、`grok`、`cursor`、`droid`、`kimi`）不再提供内置预设；若节点保存了这些未验证 harness，启动与重试均被前置拦截并以 `unverified_harness` 明确拒绝（绝不进行静默替换或自动迁移），历史记录保持只读可查。 |
| Stage harness | 继承默认值 | 选择启动适配器（`claude`、`codex`、`opencode`、`omp`、`antigravity`）；自定义命令属于实验性逃生通道且不构成已验证支持承诺，需要显式设置 `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`（仅走本地兼容路径，不支持隔离放置；即使开启该开关，5 个未验证 bare ID 仍被拒绝）。 |
| Stage 模型 | agent 默认值 | OpenCode 提供来自本地工作区建议性发现的下拉候选项，同时支持手动输入合法的 `provider/model[#variant]`；Claude 和 Codex 可填写模型名。OMP/Antigravity 接受自由文本形式的完整原生 selector，不拆 provider 或映射后缀；留空省略 `--model`，使用已配置默认值。已保存但未在列表中的模型予以保留；开始执行后锁定。 |
| Stage effort | 不设置 | Claude、Codex 的界面选项是 `low`、`medium`、`high`；同一个 Stage 必须已设置模型，远端还须通告相应能力。OMP/Antigravity 拒绝所有非空 effort，有无模型均相同；已保存值保持可见，必须明确清除。 |
| Max parallel | `4`，整数 `1`–`16` | 限制同时启动的 worker 数；DAG 依赖和 lane 可能使实际并行数更低。 |
| Stage 环境/放置 | 本地 / Current | 已保存的远端环境需要精确 Existing 工作区或显式命名的新顶层工作树。见[放置参数](worktree-isolation_zh.md#创建字段及限制)。 |
| 工作区 lane | 无 | 让一串依赖有序的 Task 复用一个非 Current 本地工作区。 |
| Retain for debugging | 关闭 | 保留已落定 worker 的终端，而不按默认行为释放。 |
| 布局 / Lead Stage | 已保存布局 / 无 | 只影响 viewer 呈现，不改变 Task 就绪或 coordinator 绑定。 |

点击 Run 后，这些设置会被快照。coordinator 运行期间，即使 Stage 尚未启动，也会锁定到这份快照。Stage 第一次产生 Dispatch 后，启动设置在 viewer 重启后仍锁定；安全重试会使用原有 harness、模型、effort 和放置位置。如果读取 worker 历史失败，界面也会保持锁定，不能假定从未执行。

**OMP / Antigravity 遵循 Orca 设置。**两者均要求运行中的 Orca 和解析后的 CLI ≥ **1.4.245**，仅本地 Linux 的 Current 或精确 Existing 放置，不能使用 lane。viewer 调用原生 `worker-start --agent omp` / `--agent antigravity`，不检查或更改用户的 Chat/Terminal 偏好、不强制界面、不预启动再绑定，也不通用复用终端。Native Chat 尚未实测，但不会被拦截。OpenCode 启动界面选择器只影响 OpenCode。原生拒绝或结果未知后绝不启动替代 worker；请求/effective、存活、归属及未知回执仍以原生证据为准。

**启动前检查**是只读操作，启动设置锁定时仍可使用。它展示当前配置，而不是既有 Dispatch 的启动回执：逐 Task 的请求模型、worker 放置位置、实际选择的适配器及限制。OpenCode Auto 配合 `#xhigh` 等模型变体可能选择 **CLI run 兼容路径**，并不等于原生 TUI。选择 Mini / 完整 TUI 仍须经过现有严格 API 适配器的执行主机版本、权限与启动身份检查，预览不会绕过这些条件。点击 Run 会先刷新已落盘配置，预览同一份计划，确认后才转移协调器权限；取消不会绑定 viewer。

**外部资源必须在派工前准备。** Worker 放置设置不负责创建任意独立测试 runtime、账户或服务。应先准备资源，或添加准备 Task 依赖，交付资源所有者、精确路径/selector、runtime 身份、访问方法、允许修改范围与清理责任。Gate 批准不等于资源已分配；已有 Dispatch 后，不能要求用户通过锁定的放置控件搬迁 worker，而应安全交付额外测试资源，或遵守明确且基于证据的恢复流程。

一次常规的界面操作顺序是：选定 Run 并查看健康徽标；打开各 Stage，选择 harness 与放置位置；只给依赖有序的任务链分配 lane；设置 Max parallel；核对**启动前检查**、Scheduler 就绪波次和预检警告；点击 **Run with Orca** 并确认刷新的计划与 coordinator 交接。执行期间用 Chat 和 Activity 了解进展，需要准确的 worker 或工作区证据才能处理的决定则到 Operational details 查看。

## 点击 Run 后发生什么

viewer 创建与工作区对应的 Orca 终端，并绑定为 Run 的 coordinator。原 coordinator 会被权限隔离；带 Run 作用域的普通读取仍可进行。每一轮，viewer 找出就绪 Task，遵守依赖、门、lane 和 Max parallel，然后让 Orca 启动受监督 worker。`worker_done` 让 Task 落定；viewer 处理并确认收件箱 Delivery，再复用、明确保留或释放每个已落定终端。跨 lane 的汇合要等人确认 `integrated`；viewer 不会合并 Git 分支。

新建 Run、解决 Gate 等单次界面修改会使用单独的临时 coordinator 终端，不借用正在运行的循环终端，否则会把它隔离。第二个指向**同一工作区**的 viewer 会报告 `coordinator_conflict`，而不会接管或关闭第一个 viewer 的终端；不同工作区的 coordinator 身份互不相同。

### 消息、会话与审计证据

Chat 可向一个经 Orca 证实仍活跃的 `dispatch:<id>` 发送指导。群发编辑器只提供 `@all` 或新发现的工作树受众，先预览接收者，再由此 Run 的活跃 viewer coordinator 确认发送。`worker_done` 和 `heartbeat` 等生命周期消息不能群发；Orca 对群发受众拒绝这些消息，viewer 也会直接以 `forbidden_group_type`（HTTP 400）拒绝。发送成功只表示 Orca 已持久化入队，不表示 agent 已阅读或接受。

Recovery 能在身份唯一时绑定 Claude、Codex 或 OpenCode 的精确提供方会话，也可由操作者手动提供准确 ID。提供方探测可能返回 `active`、`idle`、`exited`、`unknown` 或 `unavailable`；它只是 Orca Dispatch 状态旁边的一项观察，不能代替落定。未知或断连的尝试继续占用并行槽位。Request audit 会在 CLI 调用前记录 viewer 修改请求的 ID，再通过 `request-show` 区分 `completed`、`pending`、`absent` 和 `unknown`，不会重放操作。

viewer 也通过本地 HTTP API 提供同一套控制。`GET` 是回环地址上的读取；修改类 `POST`/`PUT` 需要同源客户端从 `GET /api/session` 取得的每进程 `X-Orca-Dag-Token`，服务端仍会重新检查版本就绪和输入。核心启动请求体例如：

```json
{
  "runId": "run_example",
  "defaultHarness": "claude",
  "maxConcurrency": 2,
  "harnessByTask": { "task_api": "codex" },
  "modelByTask": { "task_api": "example-model" },
  "placementByTask": { "task_api": { "kind": "new-child", "setup": "run" } }
}
```

`POST /api/run` 还接受 `effortByTask`、`environmentByTask`、`worktreeLanes`、`laneByTask` 和 `retainByTask`。这些 map 使用精确 Task ID 作键。界面从已保存设置构造请求，在启动前验证整个计划；输入无效时显示错误，不创建 worker。`PUT /api/config` 只更新已保存的偏好，不授予 Orca 生命周期权限。其他路由及请求说明见[HTTP API 参考](../reference/http-api_zh.md)。

## 处理受阻或状态不明的 Stage

| 观察结果 | 查看什么 | 下一步 |
| --- | --- | --- |
| Stage 等待中 | Scheduler 原因及 Task 的依赖/门。 | 等待前置任务，解决真正的审批门，或先集成 lane 再选择 `integrated`。 |
| worker 等待输入 | Workers 中的 `agentWait` 和精确的本地终端。 | 只有 Orca 明确报告该等待时才使用 **Focus**。 |
| worker 就绪前启动失败 | 失败阶段、提示和残留资源。 | 清除信任、更新或权限提示，再明确执行 Stop 与 Run；Stage 会被搁置，不自动重试。 |
| Dispatch 失败或停止 | 精确的 worker 记录、Task 状态和原启动参数。 | 使用基于证据开放的重试控件；它会保留原启动选择。 |
| 远端断连或存活状态 `unverifiable` | 包含远端的 worker 历史和 Recovery 观察。 | 继续保留原尝试的占位；缺少信息不能授权停止、重试或替换。 |
| 修改请求响应丢失 | Request audit ID、`request-show` 回执及 Task/worker 状态。 | `completed` 表示已生效；`pending` 要用同一请求身份；仅凭 `absent` 无法得出结论。不要盲目重放。 |

**Stop Run** 停止 viewer coordinator，并按 Dispatch 报告清理结果，包括未知结果。**Stop worker** 只针对一个经证实的 Dispatch。**Abandon** 只隔离编排权限，不声称进程或文件已停止。Task 完成后终端仍可能存活，因此释放或移除工作树前须核对归属。Recovery 面板把提供方会话观察与 Orca Task/Dispatch 权限分开显示。

启动阶段被放弃的尝试，即使精确终端已经退出，也可能继续显示 `unverifiable / missing_status`，因为 agent 从未建立状态记录。显式恢复受阻 Stage（`POST /api/run` 携带 `resumeBlocked`）只在新鲜的 `worker-show` 观察证明该 Dispatch 所记录的精确终端已退出且断开连接，并且两次读取均明确报告客户端证据缺口（`missing_status` 或 `capability_unsupported`）时接受该退出证据；不会改写 fleet 判定。仍存活、仍连接、身份不符或仅失联的终端不符合条件。独立的 provider session 检查仍然保留：没有精确绑定的 provider 退出证据时，操作员必须通过 `allowUnknownProvider` 明确接受未知后台工作的风险。单独 Abandon 或关闭任意 pane 都不能授权替代执行。

### 失败的 worker-start 重试链

在 Orca 1.4.226 中，失败的 `worker-start` 会沿确切的 `--retry-of` 链累计。第三次启动失败会把 Dispatch 设为 `circuit_broken`；之后的启动会以 `task_not_startable` 拒绝。worker 成功就绪后再自报 `failed` 不会增加此计数。viewer 会暂停启动前失败的尝试，不会把 Orca 当前 Task 状态当成允许再次启动的证据；显式重试时会让 Orca 重新核验确切 Task 与 Dispatch。

结果未明的重试会保留自己的 request ID 和未结算槽位。Task 上一次 Dispatch 的指针或终态，不能用于识别或结算这个新请求。只有精确匹配当前新 Dispatch、且不是上一尝试的记录明确确认相同结果时，才接受基于 Task 的结算；否则应检查 Request audit，不得启动替代尝试。

Stop/Run 和重启 viewer 都不会重置该链。重试须沿用同一 Task、Run 和确切的上一 Dispatch；还要重新指定目标放置位置，因为 `--retry-of` 不继承它。不要新建 Task 或 Run 来绕过熔断。标准恢复会在归属证据允许时请求 Orca 释放旧的、归 viewer 所有的失败终端；`user_takeover`、显式选择的终端或结构化/外部会话继续遵守原有 retain/release 保护，绝不强制关闭。释放后仍可通过确切 Dispatch 读取归档输出。

若 Codex 在 TUI 初始化时因 `account/read ... workspace routing discovery timed out` 退出并留下未发送草稿，应检查原 Dispatch 和终端，不要补发 Enter。`codex login status` 有效不代表账号/workspace 初始化已成功。先撤销失败尝试的执行权限；关闭用户拥有的终端前须获得许可；仅在满足上述退出证据和 provider 风险门后，对同一个 Task 显式恢复，并保留原启动参数和 `--retry-of` 关系。

### 分开读取监督、终端 ownership 与实际启动参数

Workers 分层展示证据，任何一层都不能替另一层授予权限：

| 字段 | 含义 |
| --- | --- |
| `workerState` / worker 记录 | 保留原始生命周期（如 `starting`、`ready`、`start_unknown`、`succeeded`），不是 `projection.role: worker`。已知 worker 生命周期表示存在受监督记录；`unsupervised` 只是跟踪 Dispatch，未知值仍按未知处理。 |
| 存活 / 确切观察 | Orca 当前是否能观察 worker 或其精确终端。仅凭终端存活，不能证明 agent 正在执行、Task 已落定或拥有进程控制权。 |
| `ownershipState` / `releaseState` / `retainedReason` | 终端归属和清理记账，独立于生命周期。在线且有受监督记录的 Codex，仍可能是 `user_owned / retained / user_takeover`。 |
| 请求 / 实际启动参数 | 意图与 Orca 的实际生效回显分开展示，包含 model 和 effort。结构化 `launch.effective` 优先；缺少、部分缺失或显式 null 的字段，绝不用请求值填补。重启后通过持久化的 `worker.startOptions` 恢复这一区分。 |

ownership 区域对照最初、当前 owner 的 Dispatch ID，以及 worker 和资源的终端 handle。诊断回执保留 endpoint 身份、释放错误及释放/恢复时间。owner 或 handle 不符，不能授权夺回终端。Orca 公开的 custody 回执**没有**提供是哪次输入、哪个操作者触发了 `user_takeover`，也没有专门的接管时间戳；没有额外证据，不能归因于键盘用户或 viewer。参见 [1.4.226 ownership 实现](https://github.com/stablyai/orca/blob/v1.4.226/src/main/runtime/orchestration/db/worker-terminal/worker-terminal-user-takeover.ts)与[资源回执](https://github.com/stablyai/orca/blob/v1.4.226/src/main/runtime/rpc/methods/orchestration/worker/worker-terminal-resource-presentation.ts)。

worker 保持展开时，fleet 轮询仍会更新 ownership。若 fleet 与详情的 custody 读取不一致，原生 Stop 保持禁用，须重新展开该 worker 刷新精确详情；旧的 `owned` 快照不能掩盖新观察到的 ownership 转移。

恢复时，`pending` 和 `dispatched` 都占用并发与 lane 槽位，包括 Task 为 blocked、worker 为 `start_unknown` 的情况。只使用精确 Task 指针或唯一的 Task/Run 历史关联；有歧义就保留占位，不猜最新 worker。每个状态不明的活跃 Dispatch 单独占一个槽。即使 Orca 已清空 `task.dispatch_id`，已落定的 worker 生命周期记录仍可恢复清理。

原生 **Stop worker** 要求生命周期允许，并有正面的存活证据及匹配的 `owned` 终端。`user_owned`、ownership 已转移、缺少 custody 或 handle 不符，都不能授权强行关闭。API 预选模型的 OpenCode 适配器继续使用由服务端选择的 provider 专用 Stop，并独立核实执行和身份。原生 `stop_unknown` 或未知回执，在 Stop 报告、请求审计和清理债务中仍保留为未知；已知终端 handle 不能代替已确认的 Stop。

一次 Orca 1.4.226 只读验收在 API 和中英文 Workers 界面同时确认了 `ready`、有受监督 worker 记录、`user_owned / retained / user_takeover`，以及实际生效的 `codex / gpt-6-luna / max`。这证明解析和诊断有效，不证明终端 ownership 已归还或进程已成功停止。

## 审核、持久化与清理

使用 Workspace lanes 的 **Changed files / Diff** 或文件审核操作，在 Orca 中打开精确的本地工作区。只有目标工作区已经包含预期代码，才解决集成门。lane 已落定，且改动和 worker 归属都已处理后，才能在明确确认下通过 `orca worktree rm` 移除工作树。

5 个状态文件都在 `.orca-dag/` 内：`config.json` 保存偏好，`activity.jsonl` 保存有界的解释性活动记录，`requests.jsonl` 保存可审计的修改请求 ID，`sessions.json` 保存精确的提供方会话绑定，`launches.jsonl` 保存历史派工身份。它们都不能代替 Orca 权威的 Run/Task/Dispatch 记录。升级前请停止旧 viewer：启动时将根目录旧 `.orca-dag.*` 文件迁入，绝不覆盖目标，并打印结果。发生冲突时保留两份文件、使用新位置，需人工核对。无法写入迁移时，旧普通文件仍可读取，新写入绝不回退到根目录；不会顺着符号链接读写目录或文件。

Run health 还包含可选的 `removedWork` 移除工作摘要（`coverage` 为 `complete` 或 `partial`、记录数量及可空的 `lastRemovedAt`）。旧版本运行时或未提供摘要时保持 `null`（不可用）而非补零。历史 `activeWorkersAtRemoval` 记录移除瞬间可能活跃的 worker 数，并非当前存活进程的探测结果。详细记录支持通过 `GET /api/runs/:runId/removed-work?cursor=` 按需游标分页加载（每页上限 200 条），未知类型标记为 `unreadable` 而不丢弃。查看移除历史绝不会重置编排状态；viewer 明确不提供任何 reset 按钮。

`orca-dag uninstall` 会移除已安装的 skill、残留的 viewer coordinator 终端，以及所选工作区中自己写入且未被修改的 `.orca-dag/` 和旧版 `.orca/` 忽略管理块；用户自写规则会保留。关闭残留 coordinator 终端前会逐个报告其当时协调的工作区（目录与 hash），防止残留终端持续占用 Run 导致外部 agent 被隔离。你自己创建的 symlink 仅被解除链接，绝不会顺着符号链接递归删除。加 `--purge` 只删除新旧位置已知的 viewer 状态文件和已提交 Stage 的 Git 证据，**永远不删除共享目录、时间戳规划目录或其他用户文件**。普通卸载与 `--dry-run` 都不会迁移状态。运行中的程序二进制本身会保留（进程无法删除自身二进制），卸载命令会打印对应的后续清理指令。卸载后如需继续忽略保留的文件，请自行添加相应的忽略规则。它不会删除 Orca Run/Task 历史，也不会替你集成或发布分支。

### OpenCode 启动界面选择

运行设置及 OpenCode 节点面板提供自动、Mini TUI 和完整 TUI。节点覆盖优先于工作区默认；继承会删除覆盖。自动模式保留下文的现有路由，包括 `ORCA_DAG_OPENCODE_TUI=1`；显式选择不需要该开关。选择在 Run 内冻结，Retry 也保持该快照；Recovery 启动新循环前会刷新保存的选择。

显式界面当前要求本机 Linux 当前/已有工作区、无 lane 或通用终端复用，运行中的 Orca ≥ 1.4.222，以及工作区内的 OpenCode ≥ 2.1.2。不支持的放置或未知版本在 worker preparation 前拒绝，不自动换模式。官方工作区默认模型接口解析配置默认值，再通过精确新 session 回读验证；显式 variant 仍严格校验。Mini 使用不带 `--auto` 的 `opencode mini --session`，遵守当前权限并可能等待确认。

两种界面都在 `sessions.json` 保存精确 API/session/terminal 身份；viewer 的界面记录不是 Orca effective launch 回显。接受 Task 结算且确认 provider 退出后才允许关闭自建终端。后续用户输入或来源不明的消息保留终端，不能仅凭熟悉的 nudge 文案豁免。Stop 先中断精确 provider execution，再沿用 external `worker-abandon` 记账。当前版本能兼容旧 journal，但旧二进制可能拒绝新字段；软件降级前应结算新 preparation 并备份历史，通常只需把未来启动改回自动来回退本功能。

**2026-11-02**，**Orca 1.4.245 + OpenCode 2.2.0** 在工作区默认界面为 **Mini**、模型固定 **`openai/gpt-6.1-sol#xhigh`** 时，通过精确启动身份门。当前工作区场景排他创建一个文件、独立复算 `2+3+5+7=17`、获得接受的 `worker_done`，并在无清理债务时关闭自建 pane（`run_0e5b949ffb1b`）。冷启动 viewer 在 Run 请求省略两个前端字段时仍继承保存的 Mini，完成另一份排他文件、求和 `24` 后关闭 pane（`run_dee4d21b8c0c`）。已有工作区场景经故意崩溃的 viewer 重启后恢复同一 Dispatch/session，再停止精确活动执行和前台工具子进程，未写入完成文件（`run_e86a2745afe1`）。Orca 取消使用 `worker-abandon` 记账；fencing 后 release 返回 `identity_unproven`，pane 保留供检查。这只验证 Mini，不是完整 TUI 或多账户认证，也没有解释或抹掉下文 1.4.243 的历史启动拒绝。这些检查没有打开 Orca 桌面或原生 Chat。

### OMP / Antigravity 原生证据与输出限制

**2026-11-02** 的独立原生基线使用 **Orca 运行时/CLI 1.4.245、OMP 18.15.0、Antigravity 1.4.12**，沿用已有 Terminal TUI 偏好。已观察 Current/精确 Existing、已配置默认模型/显式模型、写文件并读回、独立复算、获接受的 `worker_done`、正常原生释放和 owned 活动 Stop。OMP 提供有界 transcript/工具输出及正常释放时的 transcript 归档。Antigravity 明确提供 terminal fallback（`provider_unsupported`）及正常释放时的 terminal 归档，不冒充结构化提供方 transcript 或已验证的提供方会话身份。两者活动 Stop 后归档均不可用。Antigravity 的早期 1.4.10 版本证据漂移到实际执行的 1.4.12；根因与 1.4.10 执行均未验证。

Run `run_8713a6b6ebfe` 中更早的强制 Terminal 预启动绑定认证未通过归属、Stop 和归档门；失败结论保留为被拒绝的**设计**证据，不代表原生 agent 不可用。历史边界及当前策略见[兼容矩阵](../reference/compatibility_zh.md#验证边界与限制说明)。

**2026-11-02** 新增 viewer 实测单独记录于 `.orca-dag/20261102T084604Z/`：

- `run_f94b248416ff`：Current 默认模型 OMP 与精确 Existing 显式模型 Antigravity 均写入/读回产物，独立复算通过（和分别为 **38**、**60**）并获得接受的 `worker_done`。Antigravity 释放并捕获 terminal 归档；OMP 按原生 `user_takeover` 判断保留 pane，没有强关。
- `run_19ca9da2a106`：Existing 显式模型 OMP 与 Current 默认模型 Antigravity 运行真实前台 Node 子进程。仅使 viewer 崩溃后，重启恢复两个原有 Dispatch 和终端，未启动替代。原生 Stop 返回 owned `closed_agent_terminal`；两个子进程 PID 均退出，未写入完成文件。获授权的释放成功，Stop 后归档明确为 `unavailable`。
- `run_1c6712c54ee8`：真实英文/中文网页提供两个预设及完整模型 selector。已保存的孤立 effort 在启动前被拒绝，清空模型后仍保留，仅经**清除不支持的 effort**按钮移除。点击 Run 并确认预览后启动两个原生 agent；独立求和分别为 **10**、**31**，报告均获接受、终端均释放。网页在关闭后读取 OMP transcript 与 Antigravity terminal 归档，保留裁剪/来源提示。

原生启动回执明确为 `mode: terminal`、`preferred: terminal`、`reason: user_default`；viewer 没有强制界面或更改 Orca 偏好。这些验证证明 viewer 的 TUI 执行与 viewer 重启恢复，不证明 Native Chat、Orca 运行时重启或其他未实测放置。

## 已知局限

在自动模式下，viewer 的 `opencode` 选择运行的就是 OpenCode 2。在运行中的 Orca ≥ 1.4.220 且未设置逐节点模型时，Task 使用原生 `worker-start --agent opencode2`。在 OpenCode 2.0.22 上，这条路径已送达只读 Task，并在隔离工作树中自主写入、读回一个文件；Orca 接受 `worker_done`、报告 `agent_status` 并释放终端。显式模型遵循下方新增门槛，或保留一次性兼容路径。原生启动失败后绝不再启动第二个 worker。当前 `worker-read --source auto` 对 OpenCode 2 会回退到终端输出，无法得到精确的 provider transcript。

后续运行时发现可继续加在这里，写清受影响的启动路径、可观察的现象和已验证的处理方式。Codex TUI 可见、Task 已完成与 Orca 的 worker 存活状态是不同的证据。

### Orca 1.4.243 发现、心跳与已移除工作边界

通过 `GET /api/models/:harness` 获取的建议性模型发现运行在本地解析的 viewer 工作区（`scope: "local-workspace"`），而非所选执行主机或远端环境。它明确区分空列表（`status: "available", models: []`）与不可用/失败查询（`status: "unavailable"`，返回脱敏的英文诊断而不泄露 stderr）。Node 面板提供建议下拉列表与 `provider/model[#variant]` 手动输入，未完成的草稿不持久化到 config，已保存的非列表模型予以保留；执行开始后与启动参数一同锁定。

本地发现失败不改变原生路由门槛：2026-10-29，在隔离 Linux Orca 1.4.243 与 OpenCode 2.2.0 环境中，PATH wrapper 强制 `opencode models` 退出码为 23，但显式指定 `deepseek/deepseek-flash` 的单个原生 worker 依然成功启动，完成 `{"verified":243,"frontend":"native"}` 的文件写入与读回，获得接受的 `worker_done`，恰好 1 个 Dispatch，终端释放且无清理债务。这证明本地 viewer 发现失败时原生执行依然通过，但不能证明执行宿主发现也失败。上游 PR 32006（nativeChat 模型）或新顶层工作树修复不得视为 `opencode2`、新工作树、variant/effort 或远程/Windows 的 worker 支持扩展。

心跳消息（`type: "heartbeat"`）严格作为**存活证据**，绝非完成或结算依据。coordinator 仅记录 attempt 上的 `lastHeartbeatAt`，绝不落定 Task 或 Dispatch。Activity 时间线合并同阶段的相邻心跳（`label is working · <phase>`），不掩盖结果或后续事件。Orca 在群发中拒绝生命周期消息（`worker_done`、`heartbeat`），viewer 校验为 HTTP 400 `forbidden_group_type`。隔离 profile 中，派工前 preamble 预览验证了 5 分钟、关闭、15 分钟三种配置，关闭时 preamble 中不输出心跳命令；本次仅在预览中验证，未启动心跳 worker 或测试旧 worker 热变更，不修改全局设置。

Orca 在 `run-show` 中可选返回 `removedWork` 摘要，映射至 `GET /api/run-health`。旧宿主或未提供时保持 `null`（不可用）而非补零；历史 `activeWorkersAtRemoval` 记录移除时刻的状态，不是当前存活进程检查。详细移除历史通过 `GET /api/runs/:runId/removed-work?cursor=` 按需游标分页（每页最多 200 条），未知类型标记为 `unreadable: true`。viewer 绝不提供 reset 按钮（因为 `orchestration reset --tasks` 没有 `--run` 作用域，会清空整个本地编排数据库）。查看移除历史不重置任何状态。

在 Orca 1.4.243 与 OpenCode 2.2.0 上，显式 Mini 和 Full TUI 均未通过启动身份就绪门：API 预建会话已使用所请求的模型，但 60 秒内未观察到精确的 `OC | odag:<request>` 标题。另一个不发送输入的 Mini 诊断 pane 显示 `▪ oc mini v2.2.0 ...` / `Build · Default model`，终端仍保持创建标题。两次均未发送 Task 输入或创建 Dispatch。viewer 记录 `settledVia=start_failed` 并搁置该尝试；`awaiting_input` 是 Run 调度循环阶段，不是新的 Orca Task 状态。两条 preparation 最终均安全关闭，`POST /api/run-stop` 返回 `clean: true`，清理债务为空。这是安全拒绝验证，不是 Mini/Full 执行认证通过；根因尚未证实，身份检查未被放宽。

当前没有可用的 Orca 托管 OpenCode 账户，因此不宣称已通过真实多账户认证。独立回归 fixture 模拟建 pane 后 API 会话不可见：两个前端都保留精确的 `prepared` 记录、原 provider session 与 pane，不发送 Task 输入、不关闭 pane、不启动替代。这些 fixture 不代表真实账户兼容性已通过。

### Orca 1.4.242 输出、启动与权限边界

原生 transcript 页面包含带角色和类型化 block 的 `transcript.messages`。viewer 以标签显示正文、工具调用/结果和图片引用；未知 block 保留明确标记，不会消失或变成 `[object Object]`。每条显示消息最多 16,000 字符、每页最多 10,000 行；运行时 `limited` 或 viewer 裁剪都会保留“不完整”标记。terminal 与 OpenCode API 仍是独立适配器。

cursor 从当前有界尾部之后**向前**继续，包括当前 EOF；不能恢复已经省略的较早历史。`contentComplete` 描述当前页面/读取窗口，不代表 Task 落定或全部历史会话。来源替换仍只重读一次，并标记不连续。[Orca 1.4.242](https://github.com/stablyai/orca/releases/tag/v1.4.242) 在上游修复了满页后继续扫描；viewer 不新增输出重试或自动耗尽历史。

worker-start 回执优先将官方 `state` 规范化为状态，并单独保留可空的 `workerOutcome`。`ready / settled / workerOutcome: failed` 代表启动成功、工作失败，不是启动失败。显式 `outcome_unknown` 或 `start_unknown` 在确认落定前保留精确 Dispatch、request 与并发槽位，绝不授权 release、重放或替代派工。已记录回执的重放经过相同就绪检查。接受的 Task/Dispatch 证据会清除未决 request 标记，原始回执仍可检查。

回归模拟启动后期报错前已获接受的成功/失败结果，检查终端归属、不重复派工及成功后的依赖推进；也覆盖显式 unknown 后确认精确落定。这依据标签中的[提前回报契约](https://github.com/stablyai/orca/pull/26762)，并非强制制造真实 provider 竞态。

隔离 Linux Orca 1.4.242、Codex 0.164.0 已验证写文件与读回、原生 transcript 正文显示、跨多个页面向前翻页、接受完成、终端释放及释放后的 transcript 读取。本次未覆盖远程/Windows 和活动 Stop。

ACK 返回的不同后续批次立即进入正常处理与核验；空批次、错误及未解决的重放批次保留轮询节流。worker 不能占用自身或祖先 Run 的协调者席位，也不能使用 `--takeover-legacy`。收信/回报遵循有效 preamble，只有有资格的协调者恢复 Run 权限；运行时匹配的 guide 仍是权威。

### Orca 1.4.241 原生模型与 coordinator 边界

当运行中的应用为稳定版 **1.4.241+**、声明 `orchestration.worker-launch-preferences.v1`，且放置为本机 POSIX 当前/已有、非 lane 工作区，不含模型 variant 或 effort 时，自动模式可使用原生 `opencode` 指定模型。这不证明 `opencode2` 支持指定模型。显式 Mini/完整 TUI 及 `ORCA_DAG_OPENCODE_TUI=1` 保留各自适配器。不符合条件的请求保留原兼容边界；原生启动被拒绝后绝不启动第二个 worker。

执行主机验证 CLI 与模型可用性。标签中的[模型版本策略](https://github.com/stablyai/orca/blob/v1.4.241/src/main/opencode/opencode-model-version-policy.ts) 扩大了支持版本，而 [1.4.241](https://github.com/stablyai/orca/releases/tag/v1.4.241) 排除了会丢失首条 prompt 的版本。不能用本地 `opencode --version` 代替执行主机证据。所有 OpenCode worker 都不进入通用终端复用：不能仅凭 viewer 请求推断恢复终端当前的默认模型或前端。

2026-10-26，在隔离 Linux Orca **1.4.241**、OpenCode **2.1.2** 上，原生 `opencode` + `deepseek/deepseek-flash` 完成了写文件及读回、获接受的 `worker_done`、effective 模型回显和终端释放。viewer 重启后恢复原 Dispatch，完成依赖 Task，以两个 Dispatch、无清理债务结束。这不覆盖远程/Windows、新工作树模型选择、活动 Stop 或精确 provider transcript。

同一运行时确认 ACK 可以返回下一批 FIFO Delivery；coordinator 会保存该批次并在完成前处理。普通/过期报告会确认，未回答的问题与未执行的终端决策继续阻止 ACK；在外部释放的 reclaimable 债务会用新鲜 fleet 证据重新核验。并发展示 GET 只共享尚未完成的相同读取，不缓存变更证据。

helper 仍归活动创建者管理，以精确 `worker-show` Dispatch lineage 为证据。Task parent 只是发现线索，不构成停止或释放权限。lineage 缺失时保持等待，确认创建者落定后才交回。回归覆盖保留中的活动 helper、blocked 交回及 Stop/重启读取竞争。真实 helper 启动被该 profile 的嵌套深度上限 **1** 拒绝，未修改或绕过限制。Max parallel 根据可见活动 fleet 限制 viewer 派工，不是运行时独立准入所有 helper 的硬上限。
### Orca 1.4.229 兼容边界

[Orca 1.4.229](https://github.com/stablyai/orca/releases/tag/v1.4.229) 扩大了原生聊天 worker 的范围，但不能据此认定 viewer 单独使用的 `opencode2` 路径已支持原生模型选择。现有 OpenCode 模型适配器，以及 Codex 创建工作区后验证基准再启动的顺序保持不变。

- **原生拒绝不代表可以降级。** 不支持的 model/effort、无效参数或已知 agent 的 launcher 被禁用时，保留原尝试及回执并停车，绝不启动第二个 legacy worker。显式启用的自定义命令会在任何原生启动之前选择本地 legacy 路径。
- **所有已处理 FIFO 批次都按归属约束确认**，包括只有被拒绝或重复报告的批次。ack 返回的下一批消息也会在 Run 完成前处理；未回答问题和未落定的终端归属仍阻止确认。
- **未决 gate 会阻止完成**，包括没有关联阻塞 Task 的 Run 级 gate。普通审批 gate 仅接受精确的已解决选项 `approve` 或 `approved`；Task 必须满足所有 gate 和同一 Run 内的依赖后才可运行。`integrated` 仍是独立且精确的集成决定。Orca 可能在仅通过一个审批后就报告 `ready`；其余未决 gate，或未完成、失败、阻塞、缺失的依赖，仍会将 Task 排除在就绪波外，并显示在等待原因中。
- **Orca 可以纠正暂定启动失败。** Orca 接受精确同一 Run/Task/Dispatch 的迟到成功后，viewer 更新尝试结果，同时保留原启动回执和已执行的 release/retain 决策。旧报告、被拒绝报告或其他 Dispatch 都不能清除失败。

本机 Orca 1.4.229 的只读 smoke 确认了 runtime readiness 与能力发现；所选环境不可达时保持只读，新建 Run 返回 `503 execution_disabled`。构建后页面的浏览器 smoke 还确认：该状态下执行和 **New Run** 均被禁用，而精确 ID 输入仍可编辑。原生拒绝、FIFO 消息、gate 推进和迟到纠正则使用隔离 CLI fixture 运行真实 coordinator 验证，没有启动真实付费 agent；这不代表全部 agent 都通过了 1.4.229 端到端验收。

**真实 agent 认证（2026-10-17）。** Run `run_e78451d88bc7` 在 Orca 1.4.229 上，通过默认的显式模型 one-shot 适配器，使用 OpenCode 2.0.28 和 `deepseek/deepseek-flash` 完成两个依赖任务。两个 OpenCode 会话导出均记录 provider `deepseek`、model `deepseek-flash`，并以 `idle / succeeded` 事件结束；模型使用情况不只是根据请求 argv 推断。

构建后的 viewer 完成了 worker 的阻塞 ask/reply 和第二次审批。第一个 gate 已通过、另一个仍未决时，依赖任务没有被放行。在该检查点暂停并恢复同一 Run，也没有重新启动已完成的生产任务。两个 Dispatch 均经已接受的 `worker_done` 完成；独立重算的 JSON 产物与输入 nonce、整数计算结果、回复 token 和 SHA-256 一致。最终没有未确认 Delivery、清理债务、待回收 worker 或仍存在的实验自有终端。Orca 的跟踪记录仍报告 `terminalState: retained`，而 viewer 对实际 pane 的处置是 `closed`；这不代表原生 `worker-release` 回执。

工作区本地证据保留在 `.orca-dag/e2e-20261017T162611Z-b1d3a6/certificate.json`。本次只认证本地 POSIX 当前工作区的显式模型 one-shot 路径，不代表原生 `opencode2` 模型选择、实验性 API 预选 TUI、远程/Windows 放置或其他 agent 已通过认证。无 Task 绑定的 Run 级 gate，以及原生拒绝、无效/重复报告批次和暂定启动失败后迟到纠正等故障场景，仍由隔离 fixture 验证。


### Orca 1.4.222 兼容边界

[Orca 1.4.222](https://github.com/stablyai/orca/releases/tag/v1.4.222) 会等到 OpenCode 确实能够提交 worker 的 Task，而不只是等输入框出现。这同时适用于原生 `opencode` 和 `opencode2` 启动；viewer 在节点未指定模型时已经使用后者。就绪检测和提交交给 Orca，viewer 不追加 Enter 重试。远程 worker 需要执行主机更新才能使用这项等待逻辑；只更新 Run 所在的主机不能证明它已经生效。

新版原生模型覆盖是另一份契约。在该发布标签的源码中，[`opencode` 模型预检](https://github.com/stablyai/orca/blob/v1.4.222/src/main/opencode/opencode-model-startup-plan.ts) 只接受经过验证的 OpenCode 2.0.16，或[精确的旧版 1.18.30、1.18.32](https://github.com/stablyai/orca/blob/v1.4.222/src/main/opencode/opencode-model-version-policy.ts)，并在执行主机检查模型是否可用。它没有为 `opencode2` 增加启动模型目录。因此，通用的 `orchestration.worker-launch-preferences.v1` 声明不足以开启 viewer 原生分支的模型选择。OpenCode 模型覆盖还要求当前或已有工作区，不能创建新工作树，也不支持 effort 或复用已有终端。在 1.4.222 上，viewer 继续让选定模型走现有一次性路径，并保留该路径的放置限制。

coordinator 回归套件覆盖 1.4.220 和 1.4.222：原生完成与释放、原生拒绝后不启动第二个 worker，以及即使声明了模型能力也保留指定模型的兼容路径。较新的 CLI 连接到旧版、预发布或版本未知的运行中应用时，仍走兼容路径。这些模拟 CLI 测试证明路由和生命周期记账，不证明真实 prompt 已提交；运行时验收必须观察到 Task 执行、获接受的 `worker_done` 和终端释放。

若 Orca 拒绝启动并报告 `Agent launcher opencode2 is disabled or unavailable`，检查执行主机上的 **设置 → 智能体 → OpenCode 2**。PATH 上安装了命令并不会自动启用 Orca launcher。启用后 Stop，再 Run，或明确重试失败的 Task。viewer 会保留原始拒绝和请求 ID、补充这条恢复提示，并停住 Task，不启动替代 worker。后续“未创建资源”的清理结论也不再覆盖启动原因。

2026-10-08，Orca 1.4.222 上首次真实只读验收在创建 Dispatch 前被拒绝，原因是当前 profile 禁用了 `opencode2`；PATH 上的两个命令当时已经报告 OpenCode 2.0.15。用户启用 OpenCode 2 后，同一 viewer coordinator 路径通过验收：Run `run_293bfeda1764`、Task `task_eeae01b16f77`、Dispatch `ctx_ff7d6ff78bf4`。worker 阅读 README.md 并发送 `ORCA-14222-E2E-OK`；Orca 记录了获接受的消息 `msg_eeb2e81dec48`、Task `completed` 和 worker `succeeded`。coordinator 通过 `worker_done` 结算、进入 `completed`，并释放 worker 终端。按 Dispatch 查询的 `worker-show` 确认终端资源为 `released`，没有后续动作。所有测试 coordinator 终端已关闭，没有新增终端残留，原有终端均保留。这次验收覆盖本地当前工作树、未指定模型的只读路径；worker 输出仍是有裁剪的终端归档，不是精确的 provider transcript。

### Codex 原生启动与兼容路径

在 Orca 1.4.209、Codex 0.156.1 上，未显式传入 `--enable hooks` 的 Codex TUI 可以执行注入的 Task 并发送 `worker_done`，但 `worker-list` 仍显示 `unverifiable / missing_status`。同一 Run 的 GPT-6 Luna 对照测试中，用 `codex --enable hooks ...` 新启动的 TUI 在任务运行时显示 `live`，来源为 `agent_status`；本机的 `codex features list` 原本就显示 `hooks` 已启用。复用的 Codex app-server 缺少 Orca pane 环境变量是可能的原因，但尚未直接捕获钩子子进程的环境。

Orca 1.4.217 修复了 Codex 就绪检测，并默认隔离每个新终端的后台服务。在 Codex 0.159.2 上的本机只读测试已确认：原生 `worker-start --agent codex` 能观察到回合开始、`live / agent_status`、精确 transcript 和已接受的 `worker_done`。因此，当 `status.runtime.appVersion` 至少为 1.4.217 时，viewer 对当前或已有 POSIX 工作区使用原生启动，直接传入模型与 effort。路径选择依据运行中的应用版本，不能只看较新的 CLI 版本。已有终端需要重新打开，才能获得 Orca 的隔离改动。参见 [1.4.217 发布说明](https://github.com/stablyai/orca/releases/tag/v1.4.217)。

旧版或版本未知的运行时继续使用显式 `--enable hooks` 的预启动后绑定兼容路径。本地新建 POSIX 工作树也保留此路径，使创建及已提交 Stage 模式下的基准 SHA 校验在 worker 启动前完成；原生组合创建尚未在这里完成验收。兼容路径要求连续两帧稳定的空输入框，并拒绝 `model: loading`，但不再要求 `model:` 页脚：Codex 0.159.2 显示的是 `GPT-…`。远程和 Windows Codex 保留原生启动。原生启动失败会记录下来，不自动再启动一个兼容 worker。

在旧版运行时手动启动会话时，应在 Orca 管理的终端中新启动 `codex --enable hooks`；恢复会话可用 `codex --enable hooks resume`。在 Dispatch 运行期间，用 `worker-list` 检查 `liveness.source: agent_status`。仅凭 `missing_status` 不能判断进程已退出，也不能据此重试。`worker-release` 可能保留被归为 `user_takeover` 的终端；终端归属判定与进度、完成监督是否成功是不同的结果。

### OpenCode 的跟踪 Dispatch 没有 fleet 存活证据

对下述显式启用的完整 TUI 适配器，Stop 会确认 API execution 退出后，通过 `worker-abandon` 只做 Orca 取消记账，而非使用不拥有 external 进程的原生 `worker-stop`。随后再次读取落定。如果撤销权限后 release 返回 `retained / identity_unproven`，终端会保留供检查，不强行关闭或伪称原生进程终止。

**实验性替代路径：** `ORCA_DAG_OPENCODE_TUI=1` 会让显式 OpenCode 模型在运行中的 Orca ≥ 1.4.222 上使用 API 预选模型完整 TUI。首版仅支持本机 POSIX 当前/已有、非 lane 工作区；拒绝或回执未知后不回退。Dispatch 属于 supervised，但预建进程对 Orca 仍是 external。准备记录与 session/terminal 身份持久化到 `.orca-dag/sessions.json`；API assistant turn 证明执行，不替代 Task 落定。Orca model/effort 回显仍可能为空。

完整 TUI 准备使用请求独立的 `OPENCODE_TUI_CHANNEL`，避免共享 tab 恢复选中旧会话。它只隔离 TUI 持久化，不改变后端服务发现，也不重写 OpenCode 全局配置。绑定前，viewer 先等待会话生成的精确 `OC | odag:<request>` 标题，再检查 TUI idle；启动 shell 的空闲不算就绪。OpenCode V2 可能把未指定的模型 variant 回显为 `default`：这两种形式等价，但 provider、模型 ID 和显式选择的 variant 仍必须精确匹配。

Output 将有界的 assistant 文本、工具进度与工具结果标为 `opencode-api` 来源，关闭终端后仍可读取；过滤工具输入的敏感键、隐藏 auth/settings/config 工具结果并排除推理。Mini/完整 TUI 与 CLI-run 共用渲染器，包含 OpenCode 2.2 的 `state.content` 结果和错误。向前游标固定已渲染内容：游标之前的工具从运行变为完成时会明确重置输出，不会静默漏掉结果；旧游标格式也通过 `sourceChanged` 重置。这些 API 历史不冒充 Orca transcript 归档。默认清理要求有效落定、明确 external release、精确终端身份和 provider execution 退出；retain 或后续用户输入会保留终端。Stop 先中断精确共享服务会话，再做 Orca 编排记账；服务失败、身份变化或退出未知都不算成功。即使关闭开关，未知准备记录仍会阻止重新派工：应检查保存的 request/session/terminal 与请求审计，不是再次启动。首版仍禁用自动复用、新工作区、lane、远程与 Windows；未设置开关时，自动模式按版本门槛选择原生或兼容路径。

输出读取完整后，面板将**加载更多**替换为**读取输出**，按当前选择的来源重新开始一次有界读取。读到输出窗口末尾不等于 Task 已结算。

在一次性兼容路径上，viewer 用 `opencode run --auto` 启动 OpenCode，并创建 Orca Dispatch 记录任务。这条路径标记为 `unsupervised`，没有受监督的 worker 资源，也没有 `agent_status` fleet 证据。在 Orca 1.4.209 的并行只读对照中，OpenCode 通过 `worker_done` 完成了 Task，但运行时的 `worker-list` 显示 `unverifiable / missing_status`，落定后变为 `unverifiable / unsupervised_settled`。运行期间，`worker-show` 另外观察到精确的 OpenCode 终端仍然存活。这些 fleet 值符合兼容路径的设计，不能单独证明 OpenCode 钩子损坏。对此路径应核对 Task/Dispatch 的结果与精确终端观察，也不能把 `unverifiable` 当作进程已退出的证据。

Worker 详情现在独立展示精确持久化绑定的本地 OpenCode session 的 provider 状态、实测模型/variant、证据来源与观测时间。读取必须匹配 Run/Task/Dispatch、规范工作区路径、session 标题及 Task preamble，绝不猜“最新会话”。Provider 为 `active` 时 fleet 仍可为 `unverifiable`；provider execution 的 `exited` 不是 Task 成功，也不授予重试、Stop 或释放权限。

对这类精确 CLI-run 绑定，Output 的 Auto / Transcript 模式读取有界的 `opencode-api` 文本与工具结果，并过滤工具输入中的敏感键；不展示启动指令、推理或后续用户拥有的回合。新增输出可以继续翻页，已读内容改变会明确报告来源重置。历史不完整、截断或读取不可用均保留可见提示，不伪造成空白或已完成的 transcript；显式 Terminal 模式仍只读取终端。小页读取规避了实测 OpenCode 2.2.0 大响应中“CLI 成功退出但 JSON 未完整输出”的情况；单条超大或不可读证据仍不能授权启动替代 worker。

在 Orca 1.4.209、OpenCode 2.0.15 上直接执行只读 `worker-start --agent opencode` 测试，任务正文仍未送达：回执显示 `input_accepted`，但 OpenCode TUI 始终停在空白初始输入框，没有 agent 回合或 `worker_done`。测试 Dispatch 已隔离，精确终端已关闭，Task 已标记失败。因此 viewer 仍保留一次性兼容路径；不能只凭 `input_accepted` 判断任务已经送达。

在上述版本中，先在 Orca 终端启动并等候 `opencode mini` 就绪，再通过 `worker-start --terminal <handle>` 绑定，**可以**送达只读 Task，并通过 `worker_done` 完成。此时 Dispatch 是受监督的，但 `worker-list` 仍显示 `unverifiable / missing_status`。`mini` 是交互界面，`opencode run` 才是一次性 CLI 模式；OpenCode 2.0.15 的 `mini --help` 没有 `--auto` 选项。尚未验证 mini 在自动编辑时的权限行为，所以这次实验还不足以替换 viewer 的 `opencode run --auto` 路径。
