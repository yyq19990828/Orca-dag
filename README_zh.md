# Orca DAG — skill + viewer

[English](README.md) | 简体中文

> 本项目 fork 自 [ZinkLu/Orca-Orchestration](https://github.com/ZinkLu/Orca-Orchestration)，在其基础上扩展出自己的功能链（每节点模型/effort 覆盖、工作区 lane、集成门、会话恢复、变更审计、中英双语 UI 等），并以 [`orca-orchestration-launcher`](https://www.npmjs.com/package/orca-orchestration-launcher) npm 包独立发布。

把「和 agent 聊天规划」与「可视化 + 执行」拆成两个独立模块：

1. **skill**（`skill/SKILL.md`）：教**你自己的 agent**（Claude Code / kimi / …）项目工作流 —— PRD → 技术设计 → 拆成 **Orca orchestration 的任务 DAG**。它对命令刻意保持「薄」：先解析出正确的 Orca CLI，再加载**与运行时匹配的编排指南**（`orca skills get orchestration`），把命令语法和生命周期规则都交给那份指南 —— 已安装的指引因此不会和你的运行时脱节。规划的"大脑"在你的 agent 里，**不内嵌 Claude Agent SDK**。
2. **viewer**（`server/` + `web/`，以 `orca-orchestration-launcher` npm 包和独立二进制分发）：连到 Orca 的编排状态，**实时可视化**这张 DAG；每个节点**各自选 harness**（claude / kimi / opencode / grok …），还可以**选模型**；点 **「▶ Run with Orca」**，viewer 内置的**自驱动 coordinator** 就按依赖把 ready 任务**并行**派发给按需拉起的自主 worker，直到整张图跑完。

> 核心流程：**agent 建图 → viewer 里选 Run、给节点选 harness → Run → 按 DAG 并行自动执行**。要改某个任务或依赖，就让 agent 重绘 DAG —— Orca 没有改单个任务的接口。
>
> ⚠️ **执行需要 Orca ≥ 1.4.205。** 这是 supervised-worker 的执行基线；**1.4.160–1.4.204 保持只读**（DAG 照常渲染，执行控件自动禁用）。更早的版本（Run/Task/Dispatch 契约，2026-07-29 的 PR #9925 落地之前）不支持。
>
> ⚠️ 为什么 viewer 仍然自己当 coordinator：不是因为 `orca orchestration run` 有 bug —— 那个命令连同 `coordinator-start` 已被**正式退休**（调用无副作用，只返回"去读 skill"）。Orca 是**故意不做调度器**的，官方 skill 原话：*"Agents still choose placement and concurrency; Orca does not schedule workers."* 所以走 DAG 的循环归 viewer，但循环里**每一步**现在都用 Orca 自己的 Run / Task / Dispatch 原语。

![蜡笔风 viewer：全宽 DAG + 默认 harness/最多并行/Run 工具条 + 带每节点 harness 与模型选择的只读节点详情](docs/screenshot.png)

## 它是怎么工作的

```
   你的 agent（加载 orca-dag skill）                 orca-dag viewer（npx orca-orchestration-launcher）
 ┌───────────────────────────────┐             ┌──────────────────────────────┐
 │  和你聊需求 → 拆解 → 建图        │             │  轮询 task-list → 画 DAG        │
 │  Bash: orca orchestration      │             │  每节点选 harness              │
 │        task-create / gate-*    │             │  ▶ Run → 自驱动 coordinator     │
 └───────────────┬───────────────┘             └───────────────┬──────────────┘
                 │  写编排状态                                     │  轮询 + worker-start（并行）
                 ▼                                               ▼
        ┌──────────────────────────  Orca 编排状态  ──────────────────────────┐
        │  tasks / deps / gates   ·   按需拉起的自主 worker（各节点的 harness）    │
        └──────────────────────────────────────────────────────────────────┘
```

1. 你在**自己的 agent** 里聊需求。agent 加载 `orca-dag` skill，先 `orca orchestration run-create` 开一个 **Run**，再用 `task-create --deps …` 把任务与依赖建进这个 Run。
2. 打开 viewer（`npx orca-orchestration-launcher`）。顶栏选 Run，它每 2 秒轮询 `orca orchestration task-list --run <id> --json`，用 **dagre** 布局、**React Flow** 渲染，状态实时变色。
3. 在 viewer 里给节点选 harness（或用一个默认 harness 兜底），设置 "Max parallel"，点 **「▶ Run with Orca」**。
4. viewer 的 **coordinator 循环**接管：先把自己的一个 Orca 终端绑定为该 Run 的 coordinator（拿写权限），然后每轮找出所有 `ready` 任务，**并行**调 `orca orchestration worker-start --task <id> --agent <harness>` —— 由 **Orca 自己**创建 worker 终端、等就绪、注入 dispatch，并返回一个 **Dispatch**（一次尝试）。worker 干完发 `worker_done --outcome` → Orca **自动**把 task 和 dispatch 置为完成/失败 → 依赖转 `ready` → 继续，直到全跑完。落定的 worker 先归档输出，终端默认**释放**；只有在有立即可兼容的后续任务时才通过 `worker-start --terminal` **复用**，或按明确请求**保留**。
5. 要改计划：回到 agent 对话让它重绘 DAG。

### Run / Task / Dispatch 三层

| 层 | 是什么 | 谁维护 |
|---|---|---|
| **Run** | 命名空间 + coordinator 收件箱；同一时刻只有一个绑定的 coordinator（`consumer_generation` 做 fencing） | Orca |
| **Task** | 工作项；`deps` 定义 DAG 边，`run_id` 归属 Run | Orca |
| **Dispatch** | **一次尝试**（id 形如 `ctx_*`）；带 `failure_count`（3 次熔断）、心跳、pane 身份、能力凭证。重试产生新的 Dispatch | Orca |
| 每节点启动偏好、每 Run 主阶段、画布坐标、默认值、当前 Run | viewer 自己的元数据与偏好 | `.orca-dag.config.json` |
| Viewer Activity 记录与有意义的 coordinator check | 有界的解释性历史，包括回复、启动、清理决定、新消息、错误和 agent 状态变化；绝不作为 Task 落定依据 | `.orca-dag.activity.jsonl` |

Run 是命名空间，**不等于 DAG** —— 一个 Run 里可以躺多张互不相连的图。"一个 Run 一张图"是 `skill/SKILL.md` 里的约定，不是 Orca 的约束。

### 权限模型（为什么 viewer 要占一个终端）

Orca 的所有编排调用都过 `resolveRunScope`：

- **读**（`task-list` / `gate-list`）只要带 `--run <id>` 就跳过 consumer 检查，**任何进程都能读**。viewer 的轮询只需要这个。
- **写**（`dispatch` / `gate-resolve` / `task-create` / `worker-start`）要求调用方**就是当前绑定该 Run 的那个 Orca 终端**，靠 `--from <handle>` 解析出 pane 来比对。

viewer 是个普通进程，没有终端身份，所以写操作一律 `run_required`。解法是 viewer 自己开一个标题为 `orca-dag coordinator · <workspace-hash> · <instance-id>` 的 Orca 终端，`run-use` 绑定，然后所有写操作带 `--from`。**绑定会 fence 掉原来的 coordinator**（通常就是给你画图的那个 agent 终端），所以点执行前 viewer 会明确确认一次；agent 随时可以用 `orca orchestration run-use --id <run>` 抢回去。停止执行时 viewer 会关掉这个终端，把 Run 让出来。

标题里的 `<workspace-hash>` 把 coordinator 限定在一个工作区：两个 viewer 指向**不同**工作区时各用各的 coordinator 终端，互不干扰；第二个 viewer 若启动在**同一**工作区，会直接报 `coordinator_conflict`（HTTP 409）——不会悄悄接管，也不会关掉第一个的终端。

### 用哪个 orca、哪个工作区、能不能执行

这些都在**启动时解析一次**，进程存活期内不再变：

- **可执行文件**，按这个顺序：`ORCA_CLI_COMMAND`（精确的带引号 argv —— 不经过 shell 解析；管道、重定向、`$()` 直接拒绝，而不是悄悄不展开）→ 设了 `ORCA_DEV_REPO_ROOT` 就用 `orca-dev` → **Linux 上不在 Orca 终端里**时用 `orca-ide`（那儿的裸 `orca` 是 GNOME 读屏软件 `/usr/bin/orca`）→ 其余情况用 `orca`。所有 CLI 调用都走这一份 argv 规格（`shell: false`），cwd 是解析出的工作区目录。
- **工作区**：`WORKSPACE_DIR`（默认当前目录）必须存在，并解析成**真实路径** —— symlink 和同一目录的不同写法会归一到同一个身份。它直接变成精确的 worktree 选择器 `path:<WORKSPACE_DIR>`，所以在目录 A 启动、设 `WORKSPACE_DIR=/abs/B` 的 viewer 会把 coordinator **和 worker 都放进 B**。显式设了 `ORCA_WORKTREE` 仍然以它为准。
- **能不能执行**（`GET /api/readiness`）：跑 DAG 需要 **Orca ≥ 1.4.205** —— supervised Dispatch 契约从这个版本开始。**1.4.160–1.4.204 只读**：DAG、gate、状态照常渲染，但 Run/gate 控件会禁用并给出升级提示（绕过 UI 直接调接口会得到 `503 execution_disabled`）。CLI 找不到时 readiness 会如实报告它尝试过的解析结果。

## 前置条件

- **Orca ≥ 1.4.160 可浏览，≥ 1.4.205 可执行**（`orca status --json` 里的 `result.runtime.appVersion`）。Run/Dispatch 契约是 1.4.160 引入的；**执行**需要 1.4.205 的 supervised-worker 契约 —— 更老的运行时进入只读模式，执行控件禁用。见[读哪个 orca、哪个工作区、能不能执行](#用哪个-orca哪个工作区能不能执行)。
- **编排实验特性已开启**：Settings → Experimental。
- **Orca 运行中**：`orca status --json` 的 `result.runtime.state` 应为 `"ready"`；否则先 `orca open`。
- **项目是 Orca 管理的 worktree**：加 worker / 执行都要求当前目录是 Orca 注册的 repo/worktree（否则 `orca terminal create` 会报 `selector_not_found`）。用 `orca repo add <path>` 或 `orca worktree …` 先纳管。
- **一个能跑 skill 的 agent**（建图侧）：Claude Code、或任何能读 `SKILL.md` 并执行 Bash 的 agent。
- **viewer 侧只依赖 `orca` CLI** —— 不需要 `claude`、不需要 `ANTHROPIC_API_KEY`。
- **Node.js ≥ 20** 用于跑 `npx orca-orchestration-launcher` —— 用 release 二进制的话什么都不需要。**Bun** 只在你想自己打二进制时才需要。

## 安装

一条命令，两个模块一起到位：

```bash
cd ~/any/orca-managed/project
npx orca-orchestration-launcher
```

它会把 `orca-dag` **skill** 装进你本机所有的 coding agent（Claude Code、Codex、Cursor、OpenCode、Gemini CLI、Droid，以及共享的 `~/.agents/skills` —— 存在哪个装哪个），然后在 <http://localhost:8787> 起 **viewer**，并把当前目录当作工作区。重复执行是安全的：skill 只在内容真的变了时才重写，你自己做的 symlink 目录会被完全跳过。

接着直接在 agent 里聊需求就行，它会按 `SKILL.md` 的规范把 DAG 建进 Orca，并提示你打开 viewer。

只要 **Node.js ≥ 20** —— 包是个约 500 KB、零依赖的 bundle，`bunx orca-orchestration-launcher` 同样可用。想常驻就 `npm i -g orca-orchestration-launcher`。

机器上没有 Node？去 [releases 页](https://github.com/yyq19990828/Orca-dag/releases) 拿独立二进制，行为完全一样，自带运行时，只需要 PATH 上有 `orca`：

```bash
tar xzf orca-dag-darwin-arm64.tar.gz && sudo mv orca-dag /usr/local/bin/ && orca-dag
```

开关：`PORT`（默认 8787）、`NO_OPEN=1`（不自动开浏览器）、`--no-skill` / `ORCA_DAG_NO_SKILL=1`（不碰 agent 的 skill 目录）、`WORKSPACE_DIR`（用别的工作区代替当前目录 —— 必须存在，直接作为 `path:` worktree）、`ORCA_WORKTREE`（显式 Orca worktree 选择器，覆盖 `path:` 默认值）、`ORCA_CLI_COMMAND`（要运行的 Orca CLI，带引号的 argv、不经 shell —— 见[用哪个 orca、哪个工作区](#用哪个-orca哪个工作区能不能执行)）、`ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`（允许任意自定义 harness 命令 —— 见[安全模型](#安全模型)）。

只想要 skill、不要 viewer，或者想用标准工具管理？`npx skills add yyq19990828/Orca-dag --skill orca-dag --global` —— 即 [open agent skills CLI](https://github.com/vercel-labs/skills)，`orca skills install` 底层调的也是它。

## 卸载

```bash
npx orca-orchestration-launcher uninstall   # 想先看清单就加 --dry-run
```

把 skill 从所有装过的 agent 目录里删掉，并关掉 viewer 崩溃后残留的 `orca-dag coordinator` 终端，关闭前会逐个报告每个终端当时协调的工作区（目录 + hash）—— 后面这条其实最要紧，残留的 coordinator 会一直占着 Run，把你自己的 agent 挡在外面。你自己做的 symlink 只会被 unlink，不会顺着链接删，checkout 是安全的。

工作区历史默认保留：`.orca-dag.config.json` 保存启动选择和布局，`.orca-dag.activity.jsonl` 保存有界的 Viewer Activity 与有意义的 coordinator check（重复的空轮询仅保留在内存中）；加 `--purge` 会同时删除两者。程序本身也会保留，因为进程不能删除正在运行的自身二进制；uninstall 会打印对应的后续命令。

### 自己构建和发版

```bash
npm install
npm run check          # skill 校验 + 类型检查 + 测试 + web 构建（CI 跑的就是它）
npm run dev            # 前端 5173 + 后端 8787（vite 代理 /api）→ http://localhost:5173
npm run build:npm      # 打出可发布的包 → dist-npm/（只要 Node）
npm run build:binary   # 便携单文件二进制 → dist/orca-dag（约 100 MB，前端已内嵌；需要 Bun）
npm run release 1.0.0  # 打 tag 并推送；CI 负责发 npm + 把各平台二进制挂到 GitHub release
```

用 `TARGET=bun-linux-x64 npm run build:binary` 交叉编译到别的平台；`bash scripts/build-all-binaries.sh` 一次编出全部目标，release workflow 跑的就是它。

npm 发布任务使用 **Trusted Publishing（OIDC）**，不需要 GitHub 的 `NPM_TOKEN` secret。npm 要求先有包，才能配置 Trusted Publisher。仅首次发版时，先用启用了 2FA 的 npm 账号登录，用 `bootstrap` 标签发布一个预发布版本来创建包：

```bash
npm login
PKG_VERSION=1.0.0-oidc-bootstrap.0 npm run build:npm
npm publish ./dist-npm --access public --tag bootstrap
```

首次发布后，npm 也把 `latest` 初始化为这个预发布版，尽管命令指定了 `--tag bootstrap`；正式版发布时会将 `latest` 更新到 `1.0.0`。然后在 npmjs.com 打开 **orca-orchestration-launcher → Settings → Trusted publishing → GitHub Actions**，填写用户 `yyq19990828`、仓库 `Orca-dag`、工作流文件名 `release.yml`，环境留空，并允许 **npm publish**。也可以用 npm ≥11.15.0 执行 `npm trust github orca-orchestration-launcher --repo yyq19990828/Orca-dag --file release.yml --allow-publish`，再用 `npm trust list orca-orchestration-launcher` 核对。先将 OIDC 工作流提交并推送到 `main`，再运行 `npm run release 1.0.0`；它会推送首个正式版 tag，此后发版沿用同一流程。暂存包的 `repository.url` 已与这个 GitHub 仓库一致。参见 [npm Trusted Publishing 配置说明](https://docs.npmjs.com/trusted-publishers/)。

## Quick start

从零开始，完整走一遍：

1. **把项目纳入 Orca 管理**（每个仓库一次），并确认 Orca 在运行：

   ```bash
   cd ~/code/my-project
   orca repo add .        # 已纳管则跳过
   orca status --json     # runtime.state 应为 "ready"；否则先 `orca open`
   ```

2. **在同一个目录起 viewer**，让它一直开着：

   ```bash
   npx orca-orchestration-launcher
                          # 装 skill 到你的 agent，起在 :8787 并自动开浏览器
   ```

3. **在 agent 里做规划。** 在 Claude Code（或任何刚拿到 skill 的 agent）里描述需求并要一张 DAG：

   > 用 orca-dag skill：把「给报表页加 CSV 导出」拆成一张任务 DAG。

   agent 会先问几个澄清问题，写 `docs/PRD.md` / `docs/TECH_SPEC.md`，然后跑 `orca orchestration run-create` + `task-create --deps …`。建完会告诉你 **Run id**（形如 `run_ab12cd34ef56`）。

4. **在顶栏下拉框选中** agent 刚报的那个 Run。DAG 出现并每 2 秒刷新 —— 你可以继续和 agent 聊着调整计划，看节点实时长出来。

5. **选 harness。** 设置工具条上的 **Default harness**（所有节点的兜底），需要的话再点单个节点覆盖它的 harness/模型。设好 **Max parallel**。

6. **点「▶ Run with Orca」**，确认弹窗（它会说明 viewer 将接管该 Run 的 coordinator，你的 agent 终端会被 fence —— 这是预期行为）。ready 任务并行开跑；执行中的节点出现蜡笔涂鸦；worker 回报 `worker_done` 后整张图逐步推进。

7. **审批门弹出时处理它。** 计划里有审批门的话，到点会在 DAG 上浮出批准/驳回按钮。

8. **要改计划？** 回到 agent 对话。它用 `orca orchestration run-use --id <run>` 抢回绑定（或干脆开个新 Run 重绘），viewer 会跟着刷新。改完再点一次 Run。

## 教程

- [规划并运行任务 DAG](docs/tutorials/orchestration_zh.md) — Run/Task/Dispatch 设计、完整示例、CLI 参数和 coordinator 循环。
- [隔离工作树中的 Stage 行为](docs/tutorials/worktree-isolation_zh.md) — 放置与创建参数、Git 暂存边界、lane、集成门及清理。
- [操作 viewer](docs/tutorials/viewer-operations_zh.md) — 启动与执行设置、API 结构、监控、恢复和持久化状态。

## viewer 能做什么

- **按 workspace 隔离的 Run 选择器**：Orca 的 Run 注册表是全局的，但 viewer 只显示任务创建者身份与当前 workspace 匹配的 Run（以及该 workspace 已保存/刚创建的空 Run）。紧凑选择器以稳定的 `run_*` 编号为主信息，objective 作为次级说明。**＋ Create Run** 会从当前 workspace 创建一个空 Run 并立即选中。**Load older** 沿 Orca 的游标分页注册表继续往前翻（不透明游标逐字节透传），也可以直接按精确 `run_*` id 打开 —— 精确查找会重新校验 workspace 归属，外来 id 一律按不存在处理，绝不泄露其他 workspace 的 Run。
- **Run 健康徽标**：选中的 Run 始终报告它的归属状态 —— **viewer 自己协调**、**外部协调中**、**无绑定** 或 **内部不一致**（Orca 自身记录相互矛盾），并给出按来源的计数，读取失败时显示警告（读取失败绝不是悄悄当零处理）。任务为空但仍有消息的 Run 会被解释成这种情况，而不是看起来像渲染故障。
- **运行时能力矩阵**：只读面板读取本地 Orca 运行时 `status --json` 返回的能力声明，并与 1.4.206 规范编排能力 id 对照 —— 有旧别名的注明别名，未知编排能力与缺失字段保持关闭。API 响应保留完整的本地声明；浏览器、终端等无关能力不会铺满面板。远端环境依据各自的能力声明判断，不沿用本地声明。`orchestration.contract.v1` 与 `orchestration.federation.v1` 伞能力仅供参考，绝不会因此启用其下的细分能力。支持与否绝不从版本号推断。
- **实时可视化** DAG，节点状态 `pending / ready / dispatched / completed / failed / blocked` 映射颜色；每个节点角上标着它的 harness。
- **布局算法切换**：顶栏 "Layout" 段控可切**横向/纵向分层**（dagre / Sugiyama）与**力导向**（Fruchterman–Reingold）；**↻ Re-layout** 一键重新自动布局（清除手动拖拽）。选择会持久化。
- **层级与依赖分离**：Task 的 `parent_id` 会被保留，并以安静的点线括弧（子端带圆环）呈现——与铅笔依赖箭头刻意采用不同的视觉语法。父子关系绝不等于依赖：它不影响就绪判定，也不参与布局；顶栏开关（**Hide/Show parent links**）可在影响可读性时隐藏它。
- **调度器 / 就绪队列面板**：画布上的紧凑卡片（与 Activity/Chat 分离）展示当前就绪波次（按 id 排序，不隐含任何调度顺序）、本查看器协调器的worker容量（未运行该 Run 时显示"unknown"，绝不猜测），以及每个等待阶段的证据化原因：未满足的依赖（指明上游 Task 及其状态）、待决策门（指明 gate）、无空闲 worker 槽位或未知状态。选中节点卡片会重复这些原因，并补充其父子关系。
- **拖拽布局**：节点可自由拖动，位置在实时轮询刷新中保持不变（只有你没动过的节点跟随自动布局）。
- **执行动画**：`dispatched`（执行中）节点用蜡笔斜纹从左上到右下一遍遍「涂鸦」；从执行中节点流出的连线先是游动的虚线草稿，再有铅笔笔触从本节点向下游一遍遍「描」成实线。
- **显式主代理阶段**：每个 Run 可以手动标记一个代表主 agent 的语义阶段。该节点会叠加醒目的靛蓝双层外框与金色 `★ Lead` 徽标，同时保留原有状态颜色。这只是 viewer 元数据，不会改变 Orca 的 coordinator 权限。
- **独立 Stage 卡片 + Activity / Chat 通信中心**：选中节点后，右侧纸张卡片单独显示设置；通信则占用专用左侧栏，DAG 自动缩放到剩余画布。Activity 保留 SSE 实时时间线（含有界轮询回退、筛选、实际运行信息和可展开技术证据）；Chat 把同一份 Run 作用域事件流按阶段分组并记录双向通信：worker 成功启动后形成 coordinator 的派工气泡，worker 上报显示在另一侧，待处理问题可以直接回复，也可以向 Orca 已验证仍存活的活跃 Dispatch 主动发送持久化指导（过期、已落定或无法验证的尝试会被拒绝）。聊天气泡下方是有界的实时 check 流：主编排器每轮检查都会留下 receipt，包括空检查、收到的消息类型、失败或重放、耗时，以及运行时实际观察到的 agent/model/activity 摘要；heartbeat/status 只更新这个运行态区域，不再伪装成重复聊天消息。日志功能出现前的历史派工会明确标注为根据 Task spec 恢复。界面中的“已发送”只代表 Orca 已接受持久化入队，不代表 worker 已阅读。
- **忠实的会话语义**：Chat 保留 Orca 的线程身份（回复引用并关联原始提问），如实渲染每条消息的**优先级**徽标与**已读/未读**状态 —— "已发送"只代表 Orca 接受了持久化入队，绝不代表 worker 已读；当全局 Orca inbox 窗口饱和时会警告**"历史可能不完整"**，而不是假装可见的行就是全部（只有真正观察到边界时才渲染警告；没有警告也不是完整性的证明）。
- **协调者群发（刻意的、可审计的广播）**：一条消息发给 `@all` 或 Orca 发现的 worktree 受众，受众来自新鲜发现的下拉选择 —— 绝不是自由填写的收件人。发送需要变更 token、预览过的受众、显式确认，并且本 viewer 必须是该 Run 的**活跃协调者**；生命周期信号类型（`worker_done`、`heartbeat`）在任何 Orca 调用之前就被拒绝。
- **每节点选模型**：支持的 harness 才有 —— opencode 用 `opencode models` 枚举出下拉框；claude / codex / cursor 是自由文本。Claude/Cursor 通过 `worker-start --model` 传入。本地 POSIX Codex 使用当前或已有工作树，且运行中的 Orca 为 1.4.217 或更新版本时，直接走原生 `worker-start --agent codex --model`。旧版或版本未知的运行时，以及本地新建工作树，保留预启动后绑定的兼容路径；工作树创建及已提交 Stage 模式下的基准 SHA 校验都在 Codex 启动前完成。远程和 Windows Codex 使用原生启动。其余 harness 用各自的默认模型。
- **每节点推理力度（effort）**：claude / codex / cursor 还可选 effort 档位。原生启动通过 `worker-start --effort` 传入；兼容路径预启动的 Codex 在终端启动时收到该设置。只有该节点设置了模型才生效（Orca 的契约），清掉模型会一并清掉 effort。
- **每节点放置 —— 完整的本地矩阵**：每个节点都在四种 Orca 放置模式中选一种（在节点面板里选）：coordinator 工作区（**Current**，默认）、Orca 发现的**精确已有工作区**（`worktree list` 返回的完整选择器 —— Git worktree *或*文件夹工作区）、`worker-start` 期间由 Orca 创建的**新建子 worktree**（new child）、或以精确 Orca 仓库选择器创建的独立**新建顶层 worktree**（new top-level）。两种新建 worktree 模式携带有界的创建元数据 —— 显式名称（缺省时由 Run + Task/lane id 推导出确定性名称）、setup 策略（`run` / `skip` / `inherit`，默认 `run`）、可选 base 分支、显示名与备注。Current 与 existing 放置拒绝一切创建类字段，也绝不重跑 setup；每个 worker 的回执都会同时报告**请求值与实际生效值**（requested vs. effective placement）。
- **每节点环境（远程放置）**：节点也可以跑在**已保存的连接环境**上（`orca environment list`），而 Run 仍在本机。远程放置只有两种无歧义形态 —— **精确已有工作区**（该环境发现的完整 `id:<repo>::<path>` 选择器）或**新建顶层 worktree**（精确 repo 选择器 + 显式名称）。远程 `current`/`new-child` 永远不会出现 —— 它们跨服务器有歧义 —— 服务端在 HTTP 边界和适配器里各拒绝一次，都发生在任何 Orca 调用之前。对端未通告 model/effort 能力时，相应控件自动隐藏。
- **工作区 lane（串行共享工作区）**：一条按依赖排序的任务链可以共享一个非 current 的本地工作区。lane 由精确已有、new-child 或 new-top-level 放置作种子；第一个任务打开或创建该工作区，之后的每个任务 —— 以及每次重试、以及 viewer 重启后 —— 都复用 **Orca 返回的精确选择器**，绝不使用 viewer 自己从名称、路径或分支重建的东西。同一条 lane 里的任务绝不并行（每条 lane 同时只有一个未落定 Dispatch）；不同 lane 可以并行，受 Max parallel 约束。无依赖排序的任务不能同处一条 lane —— Run 启动会直接拒绝该计划，而不是发明一个顺序。当 Orca 证据无法正面恢复 lane 的工作区身份时，lane 冻结为 **unverifiable**：不猜测、不重建、也不悄悄挪回 current。Workspace-lanes 面板展示每条 lane 的状态（`planned / creating / active / integration_required / settled / unverifiable / removal_blocked / removed`）及其 Orca 推导的身份（选择器、worktree id、路径、分支、HEAD）与每个事实的来源。
- **跨 lane 汇合处的集成门**：当一个任务的依赖分属不同工作区 lane 时，依赖全部完成**并不等于**它们的改动已经合并。这类任务启动之前，coordinator 会先建一个幂等的 Orca 决策门（稳定的 `[orca-dag:integration]` 标记，注明来源与目标 lane），只提供 `integrated` 一种决议；任务保持阻塞，直到人工解决它。解决门记录的是一次**人工断言** —— viewer 绝不声称自己验证过 Git 合并，也永远不做 merge、rebase、cherry-pick、commit、push 或删分支。
- **单 Dispatch 干预**：停止一个正面确认仍活跃的 Dispatch（`worker-stop`）；对一个正面已退出、或 Orca 字面指定下一步为放弃的「结果未知」尝试做显式放弃（`worker-abandon` —— 只要 Orca 能证明 worker 仍存活就会拒绝）；或聚焦一个 Orca 报告「等待人工输入」的本地 worker 终端（`terminal switch`，只认新鲜的本地 `agentWait` 证据）。证据缺失、过期、远程或不可验证时一律不给操作入口；每次干预都带持久化请求 id，且绝不波及其他 Dispatch。
- **Orca 原生的审阅与移除**：执行结束后，改动文件和 diff 会在 Orca 编辑器里针对精确已证实的工作区打开（`file open` / `file diff` / `file open-changed`；报告/文件路径先对工作区校验再传给 Orca）；已落定 lane 的 worktree 只能通过 `orca worktree rm` 移除 —— 需要显式确认、token 保护，且只要还有任何存活、可回收、被保留、释放中或不可验证的 worker 可能占用该工作区就拒绝移除。归档钩子失败会原样浮现；Orca 文档化的豁免路径是另一次独立确认，绝不是自动的，也绝不是 `--force`。
- **每节点选 harness**：点节点在面板里选 `claude / kimi / opencode / grok / codex` 或自定义命令（持久化到 workspace 的 `.orca-dag.config.json`；自定义命令还需要 `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`，见[安全模型](#安全模型)）；没单独设的节点用顶栏的**默认 harness** 兜底。一条 harness 边界：opencode 与自定义命令走 viewer 的 legacy 本地终端路径，无法拥有非 current 工作区 —— 二者与任何非 current 本地放置（或 lane）组合都会在任何动作开始前被拒绝，**绝不回退到 current**。
- **执行后启动参数不可变**：任务一旦产生首个 Dispatch，harness、模型、effort、环境和放置就永久锁定；viewer 通过完整、包含远程记录的 worker 历史在重启后继续保持这把锁，因此安全重试会沿用原启动方案。所选 Run 的 coordinator 运行期间，尚未启动的任务也会暂时冻结，因为运行中的 coordinator 已持有启动快照；停止后只有从未启动的任务会重新解锁。
- **▶ Run with Orca / ⏹ Stop** + **Max parallel**：启动/停止 viewer 内置的自驱动 coordinator；worker 数由 DAG 并行度决定（能并行就并行，受 "Max parallel" 上限约束）—— **不用手动加 worker**。落定的 worker 先归档输出，终端默认释放；如果有立即可兼容的后续任务（同 harness、模型不变），终端通过 `worker-start --terminal` 直接交给它；也可以用 **Retain for debugging** 显式保留。执行中显示 "N workers"。
- **审批门与集成门**：审批操作放在 Activity 可展开的 Operational details 中，不再与其他卡片叠在画布上。跨 lane 集成门会注明来源与目标 lane，说明「上游完成 ≠ 已集成」，且只提供 `integrated` 一种决议；Workspace-lanes 面板从 lane 一侧展示同一道边界（`integration_required` 状态）。
- **节点详情（只读 spec）**：点节点看 spec / 状态 / 结果。spec 默认是更小的一行预览，并提供可访问的 Expand 控件；结构化 worker 结果会解析为结果状态、简洁报告、修改文件列表和可选报告路径，完整 payload 收进默认折叠的技术详情；改 Task 或依赖仍需让 agent 重绘 DAG。
- **Workers 面板**：Activity 的 Operational details 内按尝试展示 fleet 视图，包括存活状态、attention、执行主机、终端记账、请求值与实际生效值（模型/effort/**放置与工作区**）、Orca 字面 nextAction，以及带**来源徽标**（`auto / terminal / transcript`、截断/完整标记）的有界输出、只过滤**已加载行**的**搜索**（绝不会抓取更多转录）、本地**下载已加载行**导出，以及与 fleet 权威状态 visibly 区分的释放**归档事实**（归档存在只是证据，不等于结算）。每行还带证据门控的**停止 / 放弃 / 聚焦**操作：正面活跃才能停止，正面已退出或 Orca 指定放弃才能放弃，只有本地精确 `agentWait` 才能聚焦 —— 证据不足时连操作入口都不渲染。
- **后台会话恢复**：Claude 的精确 worker 进程、Codex preamble 中的 Task/Dispatch ID，或 OpenCode 启动时的 Dispatch 专属标题能唯一对应会话时，Recovery 会自动绑定 provider 提供的 session ID；证据不足时仍可手动输入已知 ID。绑定保存在 `.orca-dag.sessions.json`，并与 Orca 记录的执行位置核对。provider 探测结果与 Orca Dispatch 状态分开显示；主机不可达、终端关闭或 Codex 返回 `notLoaded` 都不证明后台任务已经退出。未知的尝试继续占用并发额度，不会自动重新派工。绑定和探测本身也不会恢复已停止的 Dispatch。
- **阻断 Stage 的处理**：Operational details 对已失败且 fleet 确认退出的 Dispatch，提供人工核对后完成 Task 或显式重试。人工完成保留旧 Dispatch 的失败记录；重试核对精确 provider session，并沿用旧 harness、模型和工作区。provider 状态未知时，操作员必须输入 Dispatch ID 才能重试，因为后台任务仍可能在运行。
- **变更请求审计**：查看器发起的每个变更（worker-start / release / retain / stop）都携带持久的 `--retry-request` id，并在调用 CLI **之前**写入工作区 `.orca-dag.requests.jsonl` 账本（有界、仅元数据），即使响应丢失或查看器重启之后 id 仍可检视。Operational details 新增只读**审计面板**：每个已记录请求一行（操作、Task/Dispatch 关联、作用域），行内 **Inspect** 会发起一次全新的 `request-show` 探测，并逐字渲染 Orca 自身的状态与解释——`completed`（绿）、`pending`（琥珀）、`absent`（灰，明确标注"absent 绝不证明变更没有发生"）、探测失败则显示 `unknown`。审计面绝不重放变更。
- **手绘蜡笔风**：🖍️ SVG feTurbulence 波动描边 + 米色速写本画布。

## 界面语言

查看器界面提供**英文与简体中文**两套。顶栏的 **中 / EN** 开关就在 Run 健康徽标旁，按钮始终显示「切过去之后」的语言 —— 点一下整个界面立即切换。

- **首次访问**按浏览器语言环境自动选择：`navigator.language` 以 `zh` 开头就进简体中文，其余进英文；从此以后以显式切换为准。
- **选择按浏览器持久化**，只占 `localStorage` 的一个键（`orca-dag:lang`）—— 刷新页面、重启查看器都不丢，也不会往工作区写任何东西。
- **状态名、时间戳、相对时间与全部面板都跟随选择**：DAG 节点及其 harness 标签、Run 选择器、Activity / Chat、Operational details，以及节点 / lane / worker 面板、审批门与对话框。
- **服务器错误消息保留服务器原文（英文）—— 这是有意的。** 诊断信息（readiness 原因、API 错误、Orca 自身输出）一律原样呈现，所以从界面里摘出的任何内容都能和服务端日志对上；翻译的只有查看器自己的文案。

两份字典在 `web/src/i18n/en.ts` / `zh.ts`，`npm run typecheck` 会在任一侧多键或缺键时失败 —— 两者不会漂移。

## 安全模型

viewer 是直通 Orca 的控制面 —— 启动 Run 会 fence 掉原本的 coordinator，dispatch 会拉起真实的 worker 终端 —— 所以它默认是锁死的：

- **只绑回环地址。** 服务只监听 `127.0.0.1`，绝不听所有网卡。局域网里任何机器都够不着它；也没有任何远程监听模式。
- **没有 CORS。** API 不返回任何 `Access-Control-*` 响应头，其他源页面连一个字节的响应都读不到 —— 包括下面的 token。
- **每进程一个 mutation token。** 所有改动类请求（`/api` 下的 `POST`/`PUT`）必须带上 `X-Orca-Dag-Token`，它是进程启动时铸造的 256 位随机值。web 客户端从 `GET /api/session` 取回并持有它；服务重启（token 更换）时会自动重取并重试一次。只读接口（`GET`）不需要 token。被拒绝的请求在任何路由逻辑执行之前就吃 `403` —— 不跑 Orca 命令，也没法拿校验报错当探测口。
- **自定义 harness 命令默认关闭。** 默认只能启动已知的 Orca agent id（`claude`、`codex`、`opencode`、`gemini`、`grok`、`cursor`、`droid`、`kimi`）。任意命令（比如 `aider`）会被 `custom_commands_disabled` 拒绝，除非启动 viewer 时带了 `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`；UI 会相应隐藏/禁用 "Custom…"。已存的自定义值仍会在 `.orca-dag.config.json` 里可见 —— 只是 flag 不在就不跑。
- **边界处严格校验。** Run/task/gate id、harness 名、`provider/model` 值、并发数、`{taskId: …}` 映射都在 HTTP 边界校验，之后才会变成 Orca 命令行参数。
- **一份解析好的 CLI 规格，绝不进 shell。** Orca 可执行文件（来自 `ORCA_CLI_COMMAND` 或平台规则）启动时一次性解析成纯 argv —— `ORCA_CLI_COMMAND` 里的操作符、重定向、命令替换会被拒绝，而不是被悄悄错误地执行 —— 所有调用都以 `shell: false` 拉起。

## 就绪探测与只读模式

`GET /api/readiness` 返回 `{ cli, workspace, worktree, version, executionEnabled, reason }`。执行类操作 —— 启动 Run、解决审批门、新建 Run —— 只在 **Orca ≥ 1.4.205** 上启用；1.4.160–1.4.204 上 UI 会禁用这些控件（Run 按钮显示 "View-only"、gate 按钮带原因置灰、顶栏徽标变黄），绕过 UI 的改动类请求会得到 `503 execution_disabled`。读操作（DAG、Run 列表、终端、配置）始终可用。

## HTTP 接口

所有 `POST`/`PUT` 路由都要求 `X-Orca-Dag-Token` 请求头（见上面的安全模型）；`GET` 路由在回环地址上开放。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/session` | 把本进程的 mutation token + 自定义命令开关交给同源客户端（`Cache-Control: no-store`） |
| `GET` | `/api/readiness` | 解析出的 CLI、Orca 版本，以及是否允许执行（不允许时附上可操作的原因） |
| `GET` | `/api/capabilities` | 运行时能力矩阵：运行时信息加每个能力的 `supported / alias / absent` 状态 —— 未知能力照样列出并保持关闭 |
| `GET` | `/api/run-health?run=<id>` | 单个 Run 的归属与健康：状态（`viewer-owned / external / unbound / inconsistent`）、协调者句柄、计数与按来源的警告 |
| `GET` | `/api/dag?run=<id>` | 该 Run 的 DAG：`{ runId, nodes, edges, hierarchy, gates, readyWave, readiness, generatedAt }` |
| `GET` | `/api/runs` | 列出精确归属于当前 workspace 的 Run（依据任务创建者的 worktree 身份判定） |
| `GET` | `/api/runs/page?cursor=` | 一页原始的 `run-list` 游标分页 —— 不透明 `nextCursor` 逐字节透传（null = 最后一页）；每行只附便宜的本地归属证据 |
| `GET` | `/api/runs/:runId` | 按 `run-show` 精确查找 Run，附 workspace 归属证据；只有 Orca 明确说没有时才返回 `run_not_found` —— 外来 id 按不存在处理，传输失败绝不伪装成「不存在」 |
| `POST` | `/api/runs` | `{ objective }`：在当前 workspace 新建一个空 Run（走一次性 coordinator 终端） |
| `GET` | `/api/terminals` | 列出 Orca 终端 |
| `POST` | `/api/run` | `{ runId, harnessByTask?, modelByTask?, effortByTask?, retainByTask?, environmentByTask?, placementByTask?, worktreeLanes?, laneByTask?, defaultHarness?, maxConcurrency? }`：启动自驱动 coordinator |
| `POST` | `/api/run-stop` | 停止 coordinator 并回收已拉起的 worker |
| `GET` | `/api/run-status` | coordinator 实时状态：`{ running, busy, attempts, inbox, cleanupDebt, recovery, … }` |
| `GET` | `/api/worktree-lanes?run=<id>` | 该 Run 的 workspace-lane 计划加每条 lane 由 Orca 推导的运行时身份（`planned/creating/active/integration_required/settled/unverifiable/removal_blocked/removed`、精确选择器、worktree id、路径、分支、HEAD、来源、警告） |
| `POST` | `/api/worktree-lanes/:laneId/open-changed` | 在 Orca 编辑器中打开 lane 工作区的改动文件/diff（仅限本地；工作区身份不可验证时禁用） |
| `POST` | `/api/worktree-lanes/:laneId/remove` | 通过 `orca worktree rm` 显式移除已证实的 lane 工作区 —— 需要已落定的归属与显式确认；归档钩子失败原样浮现，绝不自动豁免 |
| `GET` | `/api/worktrees` | Orca 发现的本地工作区（`worktree list`）—— 精确已有放置的选择器来源；绝不由文件系统合成 |
| `GET` | `/api/worktrees/:worktreeId` | 通过 `worktree show` 读取单个 worktree 的持久身份；只有 Orca 明确说没有时才 404 —— 传输失败照样传播，不可验证绝不会被渲染成「不存在」 |
| `GET` | `/api/repos` | Orca 发现的本地仓库（`repo list`）—— 新建顶层 worktree 放置的选择器来源 |
| `GET` | `/api/inbox?run=<id>` | 兼容接口：所选 Run 待处理的问题/升级 + 清理欠账 |
| `GET` | `/api/activity?run=<id>&after=&limit=` | 严格归属一个 Run 的可读 Activity、每阶段 fleet 运行态及有界实时 coordinator check receipt |
| `GET` | `/api/activity/stream?run=<id>` | 严格归属一个 Run 的实时 SSE 快照；浏览器失败时退回有界轮询 |
| `POST` | `/api/messages/:id/reply` | `{ body, runId }`：回答 worker 的问题/升级 |
| `GET` | `/api/audiences?run=<id>` | 该 Run 群发受众的预览（`@all` + 已发现的 worktree），带 `coordinatorActive` 与按来源的发现错误 —— 发现失败退化为空列表，绝不猜测收件人 |
| `POST` | `/api/messages/group` | `{ runId, audience, body, subject?, type?, priority? }`：向白名单受众发送一条经确认的协调者广播；生命周期类型报 `forbidden_group_type`，未发现的 worktree 报 `unknown_audience`，非协调者报 `409 not_running` |
| `POST` | `/api/gates/:id/resolve` | `{ resolution, runId }`：解决审批门 |
| `GET` | `/api/workers?run=<id>` | 该 Run 完整、游标分页且包含远程记录的 worker 历史（存活状态、终端状态、projection），也是启动参数锁定的持久证据 |
| `GET` | `/api/workers/:dispatchId?run=<id>` | 单个 worker 的持久行加 `worker-show` 证据（Dispatch/Worker 记录、PTY 事实、带 agent-wait 证据的精确 worker 观察）—— 通过比对接收里的 runId 实现 Run 划界；独立于协调者循环，viewer 重启后历史 worker 依然可查 |
| `GET` | `/api/session-bindings?run=<id>` | 列出此工作区内该 Run 的精确 provider session 绑定，不探测 provider |
| `PUT` | `/api/session-bindings/:dispatchId` | 重查精确 Orca worker 和执行位置后，绑定已知的 `{ runId, taskId, harness, sessionId }` |
| `POST` | `/api/session-bindings/:dispatchId/probe` | `{ runId }`：按需探测该 Dispatch 已绑定的 provider session；结果仅为观察，不会结算 Task |
| `POST` | `/api/workers/:dispatchId/resolve-blocked` | `{ runId, result, acknowledgeUnknownProvider: true }`：将人工核对结果记录到已退出 worker 对应的阻断 Task；旧 Dispatch 保持失败状态 |
| `GET` | `/api/workers/:dispatchId/output` | 有界输出分页（`?source=auto\|terminal\|transcript&cursor=&limit=`，limit 钳制 1–200） |
| `POST` | `/api/workers/:dispatchId/stop` | 停止一个正面确认的 Dispatch —— 行动前用全新 `worker-show` 重读、持久化请求 id、不波及其他 Dispatch；响应丢失返回 `502 response_lost` 与请求 id 供探测，绝不盲试 |
| `POST` | `/api/workers/:dispatchId/abandon` | 证据门控的显式放弃（`worker-abandon`）—— 只用于正面已退出、或 Orca 字面指定放弃的「结果未知」尝试；Orca 能证明 worker 存活时以 `abandon_refused` 拒绝，且该操作不声称任何进程或文件系统动作 |
| `POST` | `/api/workers/:dispatchId/focus` | 切换到本地精确 worker 终端（`terminal switch`）—— 只认新鲜的正向 `agentWait` 证据；远程、不精确、过期或缺失的等待一律不提供入口 |
| `GET` | `/api/requests?run=<id>` | 本工作区已记录变更请求的有界审计列表，按 Run 划界（未记录作用域的行保留并标注；其他 Run 的行只计数不列出） |
| `GET` | `/api/requests/:requestId?run=<id>` | 单条账本行加一次全新的只读 `request-show` 探测：`{ state: completed\|pending\|absent\|unknown, interpretation, outcome }` —— 绝不重放变更 |
| `POST` | `/api/workers/:id/release` / `/retain` | 落定后显式释放终端 / 保留调试 |
| `POST` | `/api/workers/:id/retry` | 重摆一个明确失败的尝试（同 harness/模型/effort/放置） |
| `POST` | `/api/files/open` / `/api/files/diff` / `/api/files/open-changed` | 在 Orca 编辑器中打开某个文件、其 diff 或某工作区的全部改动文件以便审阅 —— 路径先对已证实的工作区校验，仅限本地，不改任何 Git 状态 |
| `POST` | `/api/worktrees/remove` | 用精确选择器经 `orca worktree rm` 显式移除 worktree —— 除非 Orca 正面显示归属已落定（否则 `removal_evidence_required` 拒绝）；回执区分已移除 / 分支保留 / 归档钩子拒绝 / 不可验证 |
| `GET` | `/api/models/:harness` | 该 harness 可选的模型（目前只有 opencode 能枚举） |
| `GET` | `/api/environments` | 已保存的连接环境（`environment list`），每行带解析好的 `peer` 能力集，UI 据此隐藏远端不支持的控制 |
| `GET` | `/api/environments/:envId/worktrees?repo=` | 一个环境上的精确工作区 —— 放置选择器用的完整 `id:<repoId>::<path>` 选择器 |
| `GET` | `/api/environments/:envId/repos` | 一个环境上注册的仓库（用于新建顶层 worktree） |
| `GET` | `/api/environments/:envId/projects` | 一个环境上可见的项目分组 |
| `GET` | `/api/config` | viewer 配置（harness/模型/effort/保留/环境/放置选择、每 Run 主阶段、最多并行、布局、上次的 Run），存在 workspace 的 `.orca-dag.config.json` |
| `PUT` | `/api/config` | 合并写入 viewer 配置 |
| `GET` | `/api/health` | 健康检查（返回 workspace 目录） |

驱动执行的改动类路由（`POST /api/runs`、`POST /api/run`、gate resolve）在 readiness 判定运行时无法执行时会额外返回 `503 execution_disabled` —— 见[就绪探测与只读模式](#就绪探测与只读模式)。对已被另一个 viewer 协调的工作区启动 coordinator 会返回 `409 coordinator_conflict`。

## 代码结构

```
skill/SKILL.md            薄项目工作流：PRD → 设计 → 任务 DAG → viewer；命令语法交给与运行时匹配的编排指南（skills get orchestration）
server/src/
  index.ts               进程入口：子命令（--help / uninstall）、CLI+工作区解析、装 skill、回环监听
  app.ts                 Express 应用（createApp）：readiness / dag / session / runs / run / run-stop / run-status / activity / inbox / messages / gates / workers / requests / environments / models / config + 托管 SPA
  activity.ts            Run 作用域的可读事件解析器 + 有界 viewer Activity 日志
  requestLedger.ts       查看器发起的变更请求 id 的有界、原子账本（.orca-dag.requests.jsonl）——仅元数据，状态永远通过 request-show 实时读取
  security.ts            回环安全策略：每进程 mutation token、请求校验、自定义命令开关
  coordinator.ts          自驱动 coordinator 循环：轮询 DAG，用 worker-start（本机或 --on 环境）派发 ready 任务，负责放置/lane 映射、集成门、落定与终端复用/保留/释放，用 worker-list --include-remote 对账
  orca.ts                 orca CLI 封装：唯一解析的可执行/argv + 工作区、就绪/版本门、task-list→DAG、worker-start/复用/legacy/opencode worker、worktree/repo 发现 + 放置门、环境发现 + 对端能力、worker-read/stop/abandon、门、终端、模型
  orca.test.ts            解析/就绪/冲突覆盖（fake `orca` 桩）
  runHealth.ts            Run 归属/健康评估（viewer 自身协调 / 外部 / 无绑定 / 内部不一致），支撑 /api/run-health 与 /api/capabilities
  config.ts               viewer 配置持久化：workspace 下 .orca-dag.config.json 的读写（/api/config）
  skill.ts                启动时把 skill/SKILL.md 装进本机的各个 agent
  uninstall.ts            `orca-dag uninstall`：skill.ts 的严格镜像，外加清理残留终端
  webAssets.ts            编译期内嵌前端资源（以及 skill）的加载器
web/src/
  App.tsx                 全宽 DAG 主壳、每 2s 轮询、手绘 SVG filter 定义
  components/DagView.tsx     React Flow 图 + 状态节点（含 harness 标签、主阶段标记、蜡笔动画）
  components/ExecControls.tsx 默认 harness + 最多并行 + Run/Stop + 实时状态
  components/NodePanel.tsx    节点详情 + 收起的 spec + 主阶段控制 + 可锁定的启动偏好 + 本地/远程放置编辑器 + lane 成员关系
  components/PlacementEditor.tsx  放置矩阵编辑器：4 种本地模式 / 2 种远程模式，带边界校验的创建元数据字段
  components/LanesPanel.tsx       工作区 lane：Orca 推导的运行时身份、审阅操作、显式的 `orca worktree rm` 移除
  components/ActivityPanel.tsx 实时时间线、筛选、证据详情与上下文操作
  components/ChatPanel.tsx     阶段会话 + 实时 coordinator check 流
  components/GatePanel.tsx    Operational details 内的审批门与跨 lane 集成门
  components/RunPicker.tsx    Run 选择器 + 新建 Run + Load older（游标分页）+ 精确 id 查找
  components/DoodleSelect.tsx 手绘风下拉框（portal 弹层、搜索、键盘导航）
  components/WorkerPanel.tsx  fleet 视图：存活/attention/启动偏好/带来源徽标的输出（搜索 + 下载）、归档事实、保留/释放/停止/放弃/聚焦控件
  components/RequestAuditPanel.tsx 只读变更请求审计：账本行 + request-show 回执（completed/pending/absent/unknown）
  harness.ts                响应式配置 store：每节点启动偏好、放置/lane 意图、每 Run 主阶段、默认 harness、最多并行、布局（/api/config 持久化）
  placement.ts              客户端共享的放置/lane 语法 + lane 计划预检（镜像服务端语法；服务端会全部重新校验）
  layout.ts                 布局算法：dagre 分层（LR/TB）+ 力导向（Fruchterman–Reingold）
  types.ts / api.ts
scripts/
  build-binary.mjs        vite build → 内嵌资源和 skill → bun --compile → dist/orca-dag
  build-npm.mjs           vite build → esbuild 打包 server → dist-npm/（可发布的 `orca-orchestration-launcher` 包）
  build-all-binaries.sh   全部 Bun target + 压缩 + 校验和（release workflow 跑的就是它）
  check-skill.mjs         守住 SKILL.md 的 frontmatter（skills CLI 靠它识别安装）+ 拒绝绕过运行时指南的硬编码 CLI 指引
  release.mjs             `npm run release <version>`：检查、打 tag、推送，剩下交给 CI
```

## 设计说明与边界

- **大脑外移**：规划由你已有的 agent 承担（skill 提供规范），viewer 不内嵌 Claude Agent SDK。
- **viewer 自己当 coordinator**：Orca 故意不做调度器，所以 `server/src/coordinator.ts` 用 Orca 的 Run/Task/Dispatch 原语自己驱动循环。并行度由 DAG 决定（同时 ready 的任务一起派，受 `maxConcurrency` 上限）；落定的 worker 先归档输出，终端默认**释放**；只有在有立即可兼容的后续任务（同 harness、模型不变，走 `worker-start --terminal`）时才**复用**，或按明确请求**保留** —— 每个落定终端都有且只有一次有据可查的归属决定，释放结果含糊时以欠账形式浮出，绝不盲试。
- **worker 必须是自主 agent**：hands-off 执行要求 worker 能自己跑 `orca orchestration send --type worker_done` 回报 —— 否则会卡在权限确认。`worker-start` 会带各 TUI agent 的免审批开关启动；自定义命令走 legacy 路径，用 `orca.ts` 的 `HARNESS_LAUNCH`（目前只验证过 `claude --dangerously-skip-permissions`，其余 harness 需各自填好并验证）。
- **`dispatch --inject` 的坑**（legacy 路径）：它把 preamble 打进 agent 输入框，但常常**不自动提交**（就绪竞态）。coordinator 因此在 dispatch 后停 ~2s 再补发一个 Enter；对已提交/空输入的多余 Enter 是无害 no-op。
- **opencode 走单独的路径**：`worker-start --agent opencode` 能打开 TUI 但注入的 preamble 落不进去，所以 coordinator 开一个裸 shell、铸一个跟踪用 dispatch，然后跑 `opencode run --auto "$(cat <preamble>)"`（**`--auto` 必须带** —— 默认权限策略会静默拒掉工具调用）。
- **放置要么精确、要么不发生 —— 本地与远程一视同仁**：四种本地模式与 `worker-start --worktree` 的取值一一对应（`current`、精确已有选择器、`new-child`、`new-top-level --repo <精确repo>`），创建类旗标（`--name`、`--base-branch`、`--display-name`、`--comment`、`--setup`）**只**在两种新建 worktree 模式上出现 —— current 与 existing 启动绝不带，也绝不重跑 setup。用户没给名称时，服务端在调用 Orca 前从 Run + Task/lane id 推导一个确定性的有界名称。绑定到已保存环境的节点通过 `worker-start --on <environment>` 启动 —— `--on` 只出现在这一次调用上；之后所有的读取、消息、停止、释放都只按 **Dispatch ID** 寻址（进程、文件系统、transcript、停止与清理事实都归执行主机所有）。远程只有两种放置形态 —— 该环境上发现的精确已有工作区选择器，或带精确 repo 选择器与显式名称的新顶层 worktree；远程 `current`/`new-child` 在 HTTP 边界和适配器里各被拒绝一次，都发生在任何 Orca 调用之前。任何地方都没有合成的本地回退：新建 worktree 启动失败绝不让任务跑进 current 工作区，也绝不凭缺失证据再造一个替代品；未知环境或未证实的能力会让启动失败并留下原因记录；安全重试只会重复正面证实过的选择器（放置无法再次证实时重试直接被拒）。模型/effort 转发与结构化 transcript 读取以对端**通告**的能力为准；主机断连时其 worker 显示 `unverifiable`（绝不会是 `exited`），且不会自动停止/重试/释放 —— 重连后恢复存活状态，原 Dispatch 照常落定。
- **legacy harness 边界是「失败即关闭」**：opencode 与自定义命令走 viewer 的 legacy 本地终端路径，无法遵循精确的非 current 工作区，也无法原子地创建并拥有新 worktree。给这类 harness 选任何非 current 本地放置或 lane，都会在任何终端或 Dispatch 出现之前被拒绝 —— 绝不静默回退到 current，`agent_unconfigured` 也绝不在事后放宽放置。
- **worktree 自始至终归 Orca 所有**：每个新 worktree 都由 `worker-start` 自己创建 —— 一份回执同时拥有 Task、Dispatch、setup、终端、worktree 效果、残留资源与恢复命令；没有单独的 `worktree create` 调用。每次移除都是对 Orca 返回或重新发现的精确选择器执行 `orca worktree rm`，前置条件是 worker 归属已落定加显式确认。产品代码里不存在任何原生 `git worktree` 命令或直接删目录，归档钩子失败会阻止移除而不是被豁免，单独一次 `worker-release` 也绝不解锁移除。
- **每节点启动偏好、放置意图和主阶段标记存 workspace 配置文件**：Orca 的 task 没有 harness/metadata 字段（`task-create` 只有 spec/title/display-name/deps/parent），所以 viewer 把启动选择、每任务放置意图、lane 定义与成员关系、每个 Run 的一个语义主阶段、最多并行与布局存到 workspace 根的 `.orca-dag.config.json`（`server/src/config.ts`，`GET/PUT /api/config`），换浏览器 / 清 localStorage 都不丢；前端 `harness.ts` 是响应式 store，启动时从服务器加载并把旧的 localStorage 值一次性迁移上去。该文件只存**意图**：已创建的 worktree id、路径、分支、终端句柄、Dispatch id 与能力授予绝不入库；运行时身份永远从 Orca 回执与读取中重建。Run 时启动选择会被快照进 coordinator，之后由持久 worker 历史保证任务首个 Dispatch 后不能再更改启动方案。
- **改不了已建任务**：`orca orchestration task-update` 只能改 `--status` / `--result`，**没有改 spec/标题/依赖的接口**，也没有删除单个任务的命令；viewer 也刻意不提供清空入口（`orca orchestration reset --tasks` 会一次性清空所有 Run，所以永远不会被调用）。所以"修改任务"= **让 agent 开新 Run 重绘 DAG** —— 新建 Run 是唯一安全的重绘路径。
