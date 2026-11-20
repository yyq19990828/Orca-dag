# orca-dag 技能中文审阅版

> **说明**：本文档是 [`skill/SKILL.md`](../skill/SKILL.md) 的**中文阅读与审阅副本**，仅用于人工阅读、评审与校对，**不会被当作实际的 Agent Harness Skill 安装或发现**（故意省略了 YAML frontmatter，且位于 `docs/` 而非 `skill/`）。实际安装并生效的技能文件始终为英文版 [`skill/SKILL.md`](../skill/SKILL.md)。
>
> **技能元信息（对应原文件 frontmatter）**：
> - **名称 (`name`)**：`orca-dag`
> - **描述 (`description`)**：将软件开发工作规划为 Orca 编排任务 DAG（有向无环图），并移交至 Orchestration Panel（或在用户明确要求时直接在 Orca 中担任协调器推进）。当用户希望将一个功能或项目拆解为带有依赖关系和人工审批门禁的可执行任务图、按对话语言编写自包含任务规范，并通过 Orchestration Panel / `orca-dag` 查看器可视化和驱动执行时触发。

---

# orca-dag

通过对话细化软件需求，并将其落地为一个 **Orca 编排任务 DAG**（有向无环图）。你负责**项目规划流程**——需求澄清、PRD、技术方案设计以及写入 Orca 的任务图结构。

Orca 编排支持**两种协调模式**，请严格尊重用户的选择：

1. **人工通过 Orchestration Panel 主导协调（默认移交模式）**：你构建好 DAG 并将 Run ID 交回给用户。在 **Orchestration Panel**（自包含原生 Orca 插件 `orchestration-panel` 或独立 `orca-dag` 查看器）中，由用户逐节点挑选 Harness、模型、推理力度（`--effort`）和工作区放置，核对启动预检与账号配额后点击 **Run**，并由人直接把关审批门禁、Worker 提问回复、权限弹窗、重试与 L1 原生会话恢复，底层确定性调度器按依赖自动并行推进就绪波次。
2. **模型 / Agent 在 Orca 中担任协调器（仅在用户明确要求时）**：若用户明确要求由**你**（在 Orca 中选定的某个模型/Agent 会话）亲自担任该 Run 的协调器，请严格遵循运行时匹配的 `orchestration` 指南的事件唤醒循环：启动所有独立的就绪 Worker 后**结束当前轮次**，等待 Orca 在收到回复或完成回报时唤醒你（绝不轮询或跑 watch 脚本），通过 `send` 引导 Worker，此时 Orchestration Panel 作为只读可视化观测面运行。

本技能对具体编排命令刻意保持**精简（thin）**。命令参数、JSON 数据结构、Worker 生命周期、异常恢复与门禁规则全部以**解析到的 Orca CLI 所打印的、与当前运行时匹配的编排指南**为准——请按步骤 2 加载并遵循它。把命令语法硬拷贝到本文件中会随运行时升级悄然漂移；本文件只围绕该指南补充项目级规划工作流。若运行时指南与本文件存在任何分歧，**以运行时指南为准**。

所有规划结果**必须真正写入 Orca 的编排状态**（通过执行编排命令完成），绝不能只留在聊天文本中——Orchestration Panel 会实时轮询 Orca 并直接渲染已写入的任务图。

## 可使用的工具

- **Bash**：执行已解析的 Orca CLI，读写编排状态。
- **Read / Write / Edit**：在当前工作目录中编写规划文档（`.orca-dag/<timestamp>/PRD.md`、`.orca-dag/<timestamp>/TECH_SPEC.md`）。
- 禁止执行与本任务无关的破坏性命令（如 `rm`、`git push`、删除文件等）。

## 步骤 1 — 解析 Orca CLI（仅执行一次，先于一切操作）

选错可执行文件会静默导致一切失败：在 Linux 环境下且处于 Orca 托管终端之外时，直接调用 `orca` 往往指向 GNOME 的**屏幕阅读器**（`/usr/bin/orca`，其 `--version` 输出类似 `42.0` 的小版本号），而非 Orca IDE。请严格按以下顺序解析出**唯一一个**可执行文件（与查看器内部规则一致）：

1. 环境变量 `ORCA_CLI_COMMAND`（精确的带引号 argv，不使用 shell 解析）；
2. 当设置了 `ORCA_DEV_REPO_ROOT` 时，使用 `orca-dev`；
3. 在 **Linux 且位于 Orca 托管终端之外**时，使用 `orca-ide`；
4. 其余情况使用 `orca`。

使用前先校验：运行 `<cli> status --json`，其 `result.runtime.appVersion` 必须 **≥ 1.4.205**（执行能力基线版本；1.4.160–1.4.204 处于只读模式；**≥ 1.4.263** 新增原生 `orchestration-panel` 伴生插件、已验证的 OMP `--effort`、级联停止 helper、配对对端直邮与单次 Worker 权限审批）。确认后，**整个会话的所有命令都必须使用这同一个字面可执行文件**，绝不在中途切换。运行时指南示例中的 `ORCA` 占位符始终指代此处解析出的二进制程序。

## 步骤 2 — 加载与当前运行时匹配的编排指南（必做）

在提出规划问题或接触编排状态之前，先加载该指南并在后续所有编排命令中严格遵守——其中的参数、JSON 格式、Worker 生命周期、完成记账和门禁规则均为权威规范：

```bash
<cli> skills get orchestration
```

按需加载随附参考文档（`<cli> skills get orchestration --references` 可列出全部名称）：
- 任务 DAG 与多 Run 管理：`--reference references/coordinator-loop.md`
- 群发消息与决策门禁：`--reference references/messaging-and-gates.md`
- 子/顶层工作树、SSH/WSL 与配对服务器：`--reference references/placement-and-remote.md`
- 失败/未知 Worker、停止/放弃、熔断与重开：`--reference references/recovery-and-cleanup.md`

如果 CLI 完全拒绝 `skills get`，请立即停止并向用户报告运行时版本——无论如何，查看器执行 DAG 也要求运行时 ≥ 1.4.205。

## 预检（Preflight）

```bash
<cli> status --json      # result.runtime.state 应为 "ready"；否则请提示用户先运行 `orca open`
                         # result.runtime.appVersion >= 1.4.205 可执行；>= 1.4.263 支持插件/OMP effort/权限审批
```

## 工作流（三个阶段，均在对话中推进）

1. **需求澄清（PRD）**：用简短的问题对齐目标、MVP 范围以及明确的非目标（Non-goals）——每次只问一个关键问题。如果 MVP 已满足需要，就只规划 P0，避免过度设计。达成一致后，使用**与用户当前交互一致的语言**写入 `.orca-dag/<timestamp>/PRD.md`。
2. **技术设计（TECH_SPEC）**：明确技术栈、数据模型（细化到字段）和模块接口（伪代码）。使用**同一交互语言**将 `.orca-dag/<timestamp>/TECH_SPEC.md` 写入**同一个**规划目录。
3. **拆解为任务 DAG**：把设计拆分为并行/串行子任务，并写入 Orca（见下一节）。**这一步是必需的最终产出。**

### 派发前让所有前置条件可落地

- **区分 Worker 放置位置（placement）与测试资源**。Task 分配到的 worktree 只是 Worker 的执行目录；独立的测试运行时、fixture 工作区、账号或外部服务属于独立资源，放置选项并不会自动创建任意外部运行时。
- **先就绪资源，或增加前置准备依赖任务**。在依赖该资源的 Task 规范中写明资源归属方、精确路径/选择器、运行时标识、访问方式、允许的改动范围以及清理责任人。不要在必需资源仍未指定且无人负责时请求执行审批。
- **遵循已验证 Worker Harness 与适配器约束**。Orchestration Panel 已验证的内置受管 Worker Harness 为 `claude`、`codex`、`opencode`、`omp` 和 `antigravity`（其余 5 个未验证 ID `gemini`、`grok`、`cursor`、`droid`、`kimi` 会被拒绝用于 Worker 启动，即便这些 Agent 安装了本技能用于规划）。在 Orca ≥ **1.4.263** 上，OMP 与 Claude、Codex 一样支持具名 `--effort` 档位（切勿把底层数值型 `reasoning_effort` 当成 0–100 刻度汇报）。OpenCode Auto 在无模型覆盖时走原生 `opencode2`，在 ≥ 1.4.241 的纯净显式模型下走原生 `opencode`，其余 `#variant`、effort 或旧运行时保留 CLI 兼容或显式 Mini/Full TUI 适配器。务必保留用户请求的模型/变体，绝不为了凑合另一条路由而静默改写。Provider 活动/输出与 Orca 完成结算彼此独立。
- **移交前审阅启动预览与账号配额**。`POST /api/launch-preview` 与 `GET /api/accounts` 展示路由选择、启动约束与账号配额状态，但不保证启动必然成功或文本中隐含的外部前提已就绪。各 Agent 专属校验仍由执行宿主机完成。
- **考虑启动锁定（Launch Locks）**。协调器运行期间偏好配置会被冻结，且 Task 首次派发后即永久锁定。不要要求用户通过已禁用的控件移动已启动的 Worker，也不要要求在不存在的字段中配置外部运行时。在安全前提下可补充额外测试资源；否则保留结果并走运行时明确的恢复契约。

### 规划文档与产物规范（每次规划独立目录）

- 每次**新需求或全新的重新规划 Run**，都要新建一个 `.orca-dag/<timestamp>/` 目录。使用文件系统安全的 UTC 毫秒级时间戳：`YYYYMMDD-HHmmss-SSS`（例如 `.orca-dag/20261008-143012-123/`）。独占创建最终目录；若已存在，则换用新时间戳或追加数字后缀。绝不复用其他规划的目录，也绝不覆盖其文档。
- **所有基于文件的规划中间产物**都放在同一个目录下，包括补充笔记、任务规范草稿或本地 DAG 草稿。不要散落在项目根目录或共享 `docs/` 目录中。本地草稿绝不能替代向 Orca 编排状态的实际写入。
- 查看器运行时状态共享 `.orca-dag/` 根目录：`config.json`、`activity.jsonl`、`launches.jsonl`、`requests.jsonl` 和 `sessions.json`。端点记录绝不属于工作区数据，只存于原生插件专用的用户私有发现注册表，API 客户端不应读取。除 Provider 会话绑定外，`sessions.json` 还存储关键恢复日志（`mailboxChecks`、`guidanceSends`、`operatorMessages` 与 `resumeAttempts`），它们属于恢复权威依据而非可轮转的普通审计日志。不支持这些字段的旧版读取器遇到时会失败，因此不能跨不兼容读取器直接热降级。查看器会自动迁移旧版根目录 `.orca-dag.*` 文件且不覆盖已有目标文件；升级前请先停止旧版查看器。规划过程中不要手工编辑这些状态文件。卸载操作默认保留这些文件；`--purge` 也仅删除已知状态文件，绝不删除时间戳规划目录或其他用户文件。
- 在同一规划的迭代完善或向现有 Run 追加 Task 期间，持续沿用同一个规划目录。恢复规划时请使用文档中显式记录的路径，而非盲目取最新目录。创建 Run 后，在两份文档中记录其 `run_*` ID，并向用户同时汇报 **Run ID + 规划目录**。
- `npx orca-orchestration-launcher` 启动时会在工作区的 `.gitignore` 中写入带标记的 `.orca-dag/` 忽略规则并提示。原生插件不会自动修改 `.gitignore`；若项目尚未忽略 `.orca-dag/`，请在使用插件前添加规则。若仅安装了技能、跳过了工作区初始化或看到了初始化警告，也要在写规划文档前确认 `.orca-dag/` 已被忽略。保留用户原有规则，绝不穿透符号链接写入 `.gitignore` 或 `.orca-dag` 目录。若无法设置忽略规则，请明确说明。
- 规划文档属于**本地被忽略的产物**，不是应提交的源码，切勿 `git add -f` 强制提交。隔离 worktree 不会自动包含这些被忽略文档，因此每个 Task 规范都必须**内嵌** Worker 所需的完整需求、接口与验收标准，不能仅靠引用规划文档路径。可以附上源规划路径以便追溯，但不能作为 Worker 的必需输入。
- 历史遗留的 `.orca/` 文档不会被自动移动或删除。所有新规划一律使用 `.orca-dag/`。启动会保留旧版受管忽略块；`npx orca-orchestration-launcher uninstall` 会移除已安装的技能、当前工作区的私有 viewer 注册记录、旧版 `.orca-dag/endpoint.json`、残留的协调器终端以及两处位置的精确受管忽略块，但**即使带上 `--purge` 也会保留规划文档**。用户手写的忽略规则始终保持原样。

## 将 DAG 写入 Orca（核心步骤）

一个 Run 对应一张 DAG——Orca 底层将 Run 视为命名空间与主收件箱，“一 Run 一图”是由 Orchestration Panel 渲染的规划约定。具体命令语法以运行时指南为准；概念上你需要完成以下步骤：

- **根据用户交互的语言来确定中英文（或用户所用语言）**：Run 的 `--objective`、每个 Task 的标题（`--task-title`）、显示名（`--display-name`）与任务规范正文（`--spec` / `--spec-file`），以及每个审批门禁的 `--question`，都**必须跟随用户当前的交互语言**来编写（例如用户用中文沟通则全部用中文编写，用户用英文沟通则用英文编写）。同时保持精确的技术标识、文件路径、符号名、CLI 参数、代码片段和本地协议标记（如 `[orca-dag:merge-prep]` / `[orca-dag:merge-inputs-v3]`）原样不变。
- **为本次规划创建全新 Run**（`run-create`）并记下返回的 `run_*` ID。注意在 Orca 1.4.263+ 上，后续 `run-create` 会保留旧 Run 活跃，而不带 `--run` 的命令默认指向最新 Run——因此在追加任务或读取指定 Run 时始终显式传入 `--run <run_id>`。需要推倒重来时，请新建一个 Run——**绝对不要执行 `reset`**。
- **逐个创建 Task**，将前置依赖作为**前置 Task ID 的 JSON 数组**传入。依赖只能指向**同一个 Run 内**的 Task，它们决定了自动执行顺序——**务必记住每个返回的 Task ID**。在 Orca 1.4.263+ 上，推荐通过运行时指南提供的 `--spec-file` 参数（从文件或 stdin 读取）传递多行 Markdown 规范，并配合简洁的（与用户语言一致的）`--task-title` 和 `--display-name`，既能避免 shell 转义破坏代码块或反引号，也能让任务卡片在完整标签页与窄侧边栏中都清晰可读。
- **每创建一批任务后自检任务图**：执行 Run 级读取（`task-list --run <run_id> --json`）核对依赖连线，因为错误依赖边**创建后无法修改**（见下文“边界与已知约束”）。
- **编写自包含的任务规范（Spec）**——以运行时指南中的 *Task-spec contract* 为底线：明确目标、改动内容、约束、职责归属（允许编辑的范围）、可观测的验收证据，以及非零退出码代表失败还是本身即交付产物。所有计划内的输入与资源必须在 Worker 启动时即已就绪，不要留到派发后再澄清或让 Worker 进入本地 plan 模式。遇到计划外的运行时阻塞时，遵循实时 preamble 的 `ask` 契约（调用 `ask` 后结束本轮，等待 Orca 带着回答唤醒）。使用祈使句，避免“调研一下”“视情况处理”等模糊措辞。
- **通过查看器（或 `worker-start`）配置工作区放置，而非让 Worker 自行建分支**：默认情况下每个 Task 在协调器当前工作区运行。并行修改相同文件的 Task 必须配置到隔离的本地工作区——精确指定的已有工作区、叠放子 worktree 或独立顶层 worktree；存在先后依赖的链路也可共用同一个工作区作为串行泳道（lane）。任务落在哪里属于**启动配置**，不是 Orca 的任务状态。应在规范中告诉每个 Worker：直接在**已为其 Dispatch 分配好的 worktree** 内编辑并提交；当放置配置已创建独立 worktree 时，**绝不要让 Worker 自行新建 worktree 或切换分支**，否则可能嵌套出不同 Git 基准的 worktree，导致原分配 Stage 毫无改动。
- **对于需要合并已提交成果的跨工作区汇聚（Join），必须拆分为两个 Task**：先建一个同时包含 `[orca-dag:merge-prep]` 与 `[orca-dag:merge-inputs-v3]` 两个标记的**合并准备 Task**，再建一个依赖于它的**开发 Task**。
  - 合并准备 Task 依赖所有上游源 Stage，并在目标 worktree 中运行。其规范必须要求 Worker 在做任何 Git 修改前，按运行时指南向已绑定的协调器请求不可变依赖输入；**整条提问正文必须严格为 `[orca-dag:merge-inputs-v3]`**，不得附加任何多余文字；等待收到精确的不可变 SHA 回复后再继续，使用保留历史的 Git merge 合并这些提交、解决冲突、提交并上报完成。
  - 两个标记缺一不可；缺少该标记的旧版可执行合并规范必须在全新 Run 中重新规划。
  - 注意术语区分：上游官方公开编排契约为 `contract 1`（`orchestration.contract.v1`），运行时协议为 `3`，联邦生命周期结算协议为 `3`，控制邮件协议为 `2`；`[orca-dag:merge-inputs-v3]` 是**查看器本地契约标记**（不是全局上游版本号），严禁改名。
  - 绝不要依赖盲发启动后消息来传递关键输入。后续开发 Task 与合并准备 Task 使用**同一个工作区**并依赖合并准备 Task，只负责开发工作。
  - 启动 Run **之前**请先提交当前工作树的源码改动（包含新加的 `.gitignore` 规则），确保基线 HEAD 干净；同时保持 `.orca-dag/` 规划文档被忽略且不强制提交。每个 Stage Worker 在上报 `worker_done` 前都必须保持工作区干净并提交成果。并行的源 Stage 应分配到彼此独立的 worktree；无先后依赖关系的 Task 即使修改不同文件也不得共享工作树。该模式下新建 worktree 从 Run 捕获的 HEAD 出发，因此请将查看器的 `baseBranch` 覆盖项留空。下游开发开始前，Git 必须验证所有依赖 SHA 都是合并工作区干净 HEAD 的祖先提交，缺失证据时下游 Task 会被挂起。该模式仅支持本地 Git 仓库，不支持远程工作区或普通文件夹工作区。
- **对于不带该标记的普通泳道（lane）Run**：跨泳道汇聚保留人工 `integrated` 检查点。对该门禁的判定属于人工声明，不构成 Git 祖先提交证明。
- **合并握手实现约束**：查看器在回复前会校验不可变依赖快照和当前合并 Worker 的身份。缺少本地 `merge-inputs-v3` 标记的旧版合并规范会在预览与执行准入阶段被拒绝；请在新 Run 中重新规划，切勿在启动后补发关键输入。
- **在需要人工审批处添加决策门禁（Decision Gate）**（如审批设计或波次里程碑，问题同样使用用户交互语言编写）——遵循运行时指南的门禁参考规则；Orchestration Panel 会在完整标签页与侧边栏 **待处理** 中提供批准/拒绝按钮。派发前也可通过 `POST /api/gates` 为同 Run 内尚未派发的 Task 创建标准审批门禁。

## DAG 构建完成后：移交 Orchestration Panel（或在明确要求时直接协调）

确认任务图无误后，向用户汇报 **Run ID 与 `.orca-dag/<timestamp>/` 规划目录**：

- **已安装原生 Orca 插件（`orchestration-panel`，Orca ≥ 1.4.263）**：无需额外开终端——插件自动为当前工作区托管独立的回环后端，并在 Orca 右侧边栏（**任务** / **待处理** / **活动**）及完整工作台标签页（`↗ 标签页` 或点击状态栏）展示 Run。**会话**工具卡片来自精确限定到该 Worker 的 `worker-read` 会话记录；工具、提示词和状态事件只负责唤醒读取，不转发预览。**L1 原生会话恢复**要求会话精确匹配同一本地工作区、同一 Provider 的历史，且会话未活跃、没有已打开的面板；OMP 和 Antigravity 不支持此路径。
- **独立 CLI / Web 查看器**：未安装插件时，请提示用户在项目根目录运行：
  ```bash
  npx orca-orchestration-launcher    # 在项目根目录运行；输出本机 viewer URL 并打开浏览器
  ```

用户选择该 Run、配置逐节点 Harness / 模型 / effort / 放置策略，然后点击 **“▶ Run with Orca”**。

**若用户要求由你通过后端 API 触发 Orchestration Panel 执行：**
只使用你为目标工作区启动的 launcher 所输出的本机 viewer URL，或 Orca 为该工作区打开的 viewer URL。获取或发送令牌前，先在启动输出或 Orca 标签页中确认工作区。不要从工作区文件读取 URL 或端口，不要猜测备用端口、读取插件私有注册表或跟随重定向。若无法确认 viewer，请改用 Orca 界面。启动前先调用只读 `POST /api/launch-preview` 与 `GET /api/accounts` 预检；接口无法从任务描述中判断外部资源是否就绪。

```bash
(
  set -o pipefail
  PORT='<verified_port>' # 替换为受信任本机 viewer URL 中的端口。
  if [[ ! $PORT =~ ^[1-9][0-9]{0,4}$ ]] || (( PORT > 65535 )); then
    printf '%s\n' '请输入 1 到 65535 之间的数字端口。' >&2
    exit 1
  fi
  VIEWER="http://127.0.0.1:${PORT}"
  TOKEN=$(curl -q --noproxy '*' --fail --silent --show-error "$VIEWER/api/session" |
    python3 -c '
import json, re, sys
token = json.load(sys.stdin)["token"]
if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
    sys.exit("Invalid viewer token")
print(token)
') || exit 1
  curl -q --noproxy '*' --fail --silent --show-error "$VIEWER/api/run" \
    -H "X-Orca-Dag-Token: $TOKEN" -H "Content-Type: application/json" \
    -d '{"runId":"<run_id>","defaultHarness":"codex","maxConcurrency":2}'
)
```

此后，查看器会把**它自己的独立终端**绑定为该 Run 的协调器并自主推进——并行波次派发、持久化收件恢复、门禁与单次权限弹窗呈现、终端释放或保留。**会话**页签显示指定 Worker 的会话记录，**消息**页签显示 Worker 消息和检查回执。启动失败不会自动重试；对应 Task 会暂停，等待排查或显式重试。仅当已退出的会话符合上述条件时，才使用 L1 原生会话恢复。

**若用户明确要求由你（选定模型）在 Orca 中亲自担任协调器而非交由查看器调度：**
严格遵循已加载的 `orchestration` 指南事件唤醒循环（`references/coordinator-loop.md` 与 `references/recovery-and-cleanup.md`）：启动就绪 Worker 后结束本轮，等待 Orca 在来信或任务完成时唤醒你；严禁编写轮询或 watch 脚本（普通 `check` 会偷走邮件导致 Orca 无法唤醒）；始终用 `send` 引导 Worker（不要往终端敲字）；若用户希望保留 Worker 对话继续使用，启动时加 `--keep-open` 或调用 `worker-keep-open`。此时 Orchestration Panel 会自动以只读模式实时展示该 Run，不会干扰你的协调。

⚠️ **切换协调器时被围栏拦截（`consumer_fenced`）属于正常保护。** 在 Orchestration Panel 启动执行会将其自身终端绑定为协调器，你随后对该 Run 的变更操作会返回 `consumer_fenced`（只读查询如 `task-list --run <id>` / `gate-list --run <id>` 不受影响）。如需收回控制权，按运行时指南通过 `run-use` 重新绑定；反过来，Orchestration Panel 对外部协调的 Run 绝不隐式夺权，必须由操作员显式确认匹配的绑定证据（`coordinatorControl`）。

## 边界与已知约束

- **默认聚焦规划 + 构建 DAG**；仅当用户明确要求“由模型作为协调器”时才在终端直接驱动，或按要求通过 `/api/run` 触发 Orchestration Panel 执行。
- **已创建的 Task 无法编辑或删除**：`task-update` 只能修改 `--status` / `--result`，没有修改 spec / 标题 / 依赖边的接口，也没有删除单个 Task 的命令。你仍可向未完成的 Run **追加**新 Task 或门禁；但若要**修改**已有 Task 或依赖关系，必须**新建一个 Run 并重绘整张 DAG**，旧 Run 保留作历史。
- **规划期间绝不执行 `reset`**。`orchestration reset --tasks` / `--all` **没有 `--run` 作用域**：它会清空整个本地编排数据库。只有在用户明确放弃本地协调状态时才能运行 `reset`；重做规划的正确方式永远是新建 Run。
- **启动失败熔断与用户指示重开（Orca ≥ 1.4.226 / 1.4.263）**：同一条 `--retry-of` 链连续 3 次启动失败会触发 `circuit_broken`（Worker 自身上报 `failed` 不计入该次数）。严禁新建替代 Task 或 Run 绕过熔断。只有当用户明确指示重试或重新分配时，Run 的协调器才能在核查保留尝试（`worker-show` / `worker-read`）、释放可回收失败终端后，在归属 Run 中重新打开**同一个 Task**。
- **邮箱、权限、helper 与恢复语义取决于运行时版本**：
  - 上游官方公开编排契约为 `contract 1`（`orchestration.contract.v1`），运行时协议为 `3`，联邦生命周期结算协议为 `3`，控制邮件协议为 `2`；本地 V3 迁移是查看器本地契约。
  - 旧版 FIFO 检查会重放最旧未确认 Delivery；消费型检查在读取时即确认，单独 ACK 不拉取下一批。传输层确认不等于本地处理完成：持久化恢复账本保存在 `sessions.json`（`mailboxChecks`、`guidanceSends`、`operatorMessages`、`resumeAttempts`）中，无法跨不兼容旧读取器安全热降级。丢失响应必须复用同一请求身份恢复，不可发新变更。
  - 原生 `stopReason` 上报（`finished`、`errored`、`needs-input`、`exited`、`lost`）属于事件而非可回复提问线程；须通过精确 Dispatch 引导（`send`）、操作员决断或权威后续结算处置。
  - 在 Orca **1.4.263+** 上：`worker-stop` 级联停止子 helper（`orchestration.worker-stop-helpers.v1`），配对服务器直邮使用 `send --on <server>`（`orchestration.peer-mail.v1`），远端回执支持 `request-show --on <server>`（`orchestration.remote-owned-workers.v1`），挂起的 Worker 权限弹窗支持在查看器中单次审批/拒绝（`POST /api/workers/:dispatchId/permission`，在 Orca 设置开启后调用底层 `approve`/`deny`）。
  - 指导发送支持有明确证据支撑的 `recipient_run_bound_redirect` 投递到实际目标邮箱，不篡夺子所有权。`--peek` 仅作观察，严禁消费其他 Agent 的邮箱。
- 已退役的调度器命令（`orchestration run` / `run-stop` / `coordinator-start` / `coordinator-stop`）均为空操作（no-op），切勿使用。
- 禁止执行破坏性或超出任务范围的系统命令。

## 沟通风格

- 全程跟随用户语言（包括对话、规划文档、Run 目标、Task 标题/显示名/规范以及 Gate 问题），简明直接。
- 每创建完一批任务后，用一句话概括当前 DAG 的形态（哪些节点并行、哪些节点串行）——用户正在 Orchestration Panel 中实时观看任务图成形。
