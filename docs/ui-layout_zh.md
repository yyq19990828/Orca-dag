# 分节式编排工作台布局

[English](ui-layout.md) | 简体中文 · [文档导航](README_zh.md)

## 目标与决策

帮助操作者依次回答：现在发生了什么、哪些事项需要我决策、涉及哪个任务或执行者、状态由什么证据支持。
应用彻底摒弃旧版纸张、蜡笔手绘风格与 SVG 湍流滤镜，采用精确、低噪且资源高效的现代化分节式工作台（`workbench.css`、`styles.css`、`chat-dock.css`、`graph-motion.css`）。它结合了稳定的顶层操作栏、深蓝色导航侧栏、支持就地任务检查的中央主阅读区，以及右侧常驻可调节宽度的通信侧栏。

| 阅读层次 | 界面位置 | 内容 |
| --- | --- | --- |
| 顶栏与概览（Overview） | 自适应网格顶栏（宽屏 ≥1200px 单行合并，<1200px 两行网格）、概览分节 | 紧凑 Run 选择器（具备省略号与完整 Tooltip，本页不含“新建 Run”按钮）、居中协调者健康徽标与就绪连接状态指示、阶段完成进度、传送执行动作组、六类任务状态计数、紧凑待办运维操作摘要（`OperationsAttention` 紧凑摘要变体，支持在流内直接跳转至“决策”分节）以及调度器就绪队列与阻断原因。 |
| 任务与检查（Tasks） | 任务分节（列表与图）、中央详情（`NodePanel`） | 无障碍垂直任务列表（`TaskList`）与懒加载 DAG 画布（`DagView`）；选中任务时在中央阅读区（`.workbench-detail`）以标准文档流（`position: static; width: 100%`）就地展开 `NodePanel`，包含标题 `h1.node-panel__title`，替换中央视图并完整保留路由、滚动位置与筛选上下文。 |
| 决策（Decisions） | 决策分节 | 完整待办操作列表（`OperationsAttention` 完整变体）、待处理审批门（`GatePanel`）、跨工作区集成门以及中断启动恢复卡片（`RecoveryPanel`）。 |
| 执行（Executions） | 执行分节 | Worker 状态卡片（`WorkerPanel`），展示独立 worker 字段、能力列、精确派发（Dispatch）标识（不回退到重复任务 ID），呈现 worker 存活状态（包括中立的 `exited` 已退出状态观测 `#52647a`），归档输出日志、搜索、下载、终端释放/保留控制及协调者权限保护。 |
| 动态与审计（Activity） | 动态分节 | 单条共享 SSE 连接驱动的实时事件流（`ActivityPanel`，页面隐藏时自动暂停）与变更请求账本（`RequestAuditPanel`）。 |
| 资源（Resources） | 资源分节 | 工作区 Lane 管理（`LanesPanel`，含分支 diff 与显式待读/不可用证据状态 `lane.pending`）与按需工作区清理面板（`CleanupPanel`，支持安全清理已合并分支）。 |
| 设置（Settings） | 设置分节 | Run 级别执行默认偏好、流内分组执行设置（`.exec__settings-panel`、`ExecControls`）以及运行时预检能力诊断（`CapabilityPanel`）。 |
| 通信（Communication） | 常驻通信侧栏（`.workbench-chat`） | 右侧常驻通信面板，展示会话线程、实时 check 回执、受众预览，并通过 `useScopedChatState` 实施细粒度状态隔离。 |

该架构将依赖图与应用容器完全解耦。DAG 负责解释任务拓扑依赖，而不是占满整个视口。7 个工作台分节之间的切换与 URL Hash 路由（`#section=<name>&task=<id>`）保持同步，支持浏览器前进/后退历史与精确滚动记忆。选中任务时在中央主区域直接替换呈现 `NodePanel` 详情，而非浮动遮罩抽屉；关闭详情直接平滑返回离开前的列表或画布滚动上下文。

## 展示规则

- 已知操作和终端代码提供中英文名称；未知代码原样保留。翻译不会授予权限或推断完成。
- 请求的 `absent` 表示运行时无记录，不代表操作一定未发生。
- 从当前 DAG 解析任务名称。完整任务、派发、请求和 Run 标识放入展开的证据区域；无法解析名称时回退到 ID。
- 结构化结果保留 `false`、`0`、null、空集合、未知字段、数组与嵌套对象。嵌套集合通过原生折叠控件查看。
- worker 报告的字段先检查类型再格式化。长正文与诊断信息分别展开，原始 JSON 保持可查。
- 现代化设计系统：清晰的 1px 边框（`#dbe2ea`、`#d8e1eb`）、扁平 CSS 表面、浅色冷中性底色（`#f3f5f8`、`#ffffff`）、深蓝色命令侧栏（`#14263d`）以及本地系统无衬线字体。严禁引入 SVG `feTurbulence` 滤镜、位移噪点或外部网络字体。
- 执行操作提示通过 portal 传送到顶栏网格的 `.workbench-action-host` 中：在宽屏视口（`@media (min-width: 1200px)`）下，主操作按钮（“启动前检查”与“用 Orca 运行” / “停止”）通过 `display: contents;` 打平包装层，按 DOM 焦点顺序直接合入顶栏同一行（动作按钮固定为 156×40px 且 `white-space: nowrap` 不换行），错误信息与执行回执独占下方整行展开，不挤压控件；在 `<1200px` 视口下，主操作按钮仍占第二行。顶栏提供带省略号与完整 Tooltip 的紧凑 Run 选择器（224×40px），以及居中放置的协调者健康徽标与连接状态指示。查看器页面不提供“新建 Run”按钮；Run 的创建归属于规划智能体或 CLI，查看器仅负责读取和协调已有 Run（服务端 `POST /api/runs` 接口保持公共开放且不变）。

### 读取状态

四种明确区分的读取状态，避免将网络或服务异常误当成空数据：
1. *正在读取（Loading）*：初次加载进行中，展示专属 loading 状态。
2. *首读失败（First-read failure）*：当前 Run 尚无成功读取的任务快照，或尚未选择 Run 时初次列表读取失败。显示明确错误、可展开的技术详情与重新加载页面入口；未取得任务数据时，启动前检查与执行不可用。
3. *确认为空（Confirmed empty）*：Run 列表或 DAG 快照正常返回且数量为 0。展示明确的空状态引导，与加载中或失败截然分开。
4. *陈旧快照（Stale snapshot）*：已有同一 Run 的成功快照，但后续周期性刷新失败。保留任务与计数，提示数据可能过期，并允许查看详情。“**重试读取**”只刷新投影，不重放启动或其他变更，也不刷新全页。

`RunPicker` 对外暴露首读状态（`RunListReadState`: `loaded`, `error`），使顶层视图能准确区分“空工作区”与“读取失败”。其下拉面板保留历史分页与精确 Run ID 查询；规划/CLI 创建 Run，选择器仅读取既有 Run，本页不提供新建 Run 按钮。

### 键盘操作与中央详情焦点管理

- 在选中的 DAG 节点或 `TaskList` 任务项上按 `Enter` 或 `Space`，即可在中央主区域打开该阶段详情（`NodePanel`）。
- 详情打开时，焦点自动移动至标题（`h1.node-panel__title`，`id="node-panel-title"`，`tabIndex={-1}`），方便屏幕阅读器和键盘操作者迅速定位。
- 在 `NodePanel` 内按 `Escape` 键，详情关闭，并在下一帧（`requestAnimationFrame`）将焦点精确恢复至触发该操作的原列表项或节点元素。
- 详情内部嵌套的交互控件（如选择 harness 或模型的 `DoodleSelect` 下拉菜单）优先拦截消费自身的 `Escape` 键，仅关闭自身下拉面板并将焦点归还其触发按钮，绝不误关闭外层中央详情。

### 移动端响应式呈现与有界浮动菜单

- **窄屏默认列表（≤760px）**：主工作区默认切换为垂直无障碍 `TaskList`，展示任务名、状态圆点与就绪/阻塞原因，替代移动端难以操作的画布漫游。顶栏提供切换开关，可在任务列表与 DAG 图之间自由切换。点击列表项在中央区域打开详情，关闭后恢复焦点至该项。
- **平板与移动端断点（≤900px）**：
  - 左侧导航栏由 200px 纵向列收缩为顶部横向滚动栏，具备适配触控的边距。
  - 右侧常驻通信侧栏转为单面板聚焦视图：打开聊天时自动隐藏中央工作台主区域（`.workbench-body--chat-open .workbench-main { display: none; }`），避免在小屏幕上挤压三列。
  - 点击顶部导航切换分节时，自动关闭移动端聊天面板，直接展示目标分节，且不会清空已选会话或丢失未发送草稿。
- **有界菜单折叠与流内设置**：
  - 任务工具栏中的视图菜单（`.view-menu`）为原生行内 `<details>` 折叠控件，由 `<summary>` 触发并在下方展开绝对定位面板（`.view-menu__panel`），不展示 `.menu-close` 关闭按钮（`.menu-close { display: none; }`）。按 `Escape` 键或点击外部（通过 App 全局菜单关闭钩子）即可关闭菜单并将焦点归还至 `<summary>` 触发元素。
  - Run 选项面板（`.runpick__menu`）为相对定位的 `<details>` 控件，在触发按钮下方展开绝对定位面板（`.runpick__menu-panel`），提供精确 ID 查找与历史分页，本页不设新建按钮。
  - 执行设置面板（`.exec__settings-panel`）作为设置分节内的标准流内表单渲染，而非浮动弹窗或视口固定 sheet。
  - 在任何打开的折叠面板内按 `Escape` 键或点击外部即可关闭当前面板并归还焦点。

### 结构化启动前检查（Preflight Launch Preview）

- 启动前检查（`LaunchPreview` 在 `DecisionDialog` 中承载）在执行前清晰呈现完整启动计划：
  - 请求的默认执行器与最大并行度在顶部展示一次；只有涉及 OpenCode 时才显示其默认界面。
  - 所有任务共有的限制（Common limits）在顶部去重汇总展示一次，避免各任务逐条重复刷屏。
  - 展示完整任务名，名称缺失时回退到精确 ID；展开任务可查看或复制完整 ID，剪贴板拒绝时明确提示手动复制。
  - 存在不支持路径、未知路由/限制代码、或包含任务特有额外限制的任务，标记为待核对状态并默认自动展开（`open={needsReview || undefined}`）。
  - 每个任务下方清晰罗列该任务单独请求的配置覆盖（harness、模型、effort、保留设置、放置、环境、lane、OpenCode 界面）。
- 对话框（`DecisionDialog`）承载启动前检查与确认：
  - 支持独立于文本消息的自定义内容（`content`）渲染。
  - 具备详情感知（details-aware）的焦点陷阱（`trapKeys`），Tab 键循环仅在当前可见的表单与展开的 `<details>` 内流转，自动跳过折叠隐藏的元素。
  - 安全取消：点击“暂不”、按 `Escape` 或点击遮罩，不调用 `POST /api/run`。准备预检时已经保存的配置不会因取消而回滚。
  - 严格声明权威边界：预览仅为当前配置意图的只读检查与预排版；“预览不等于验证执行”，不代表模型可用性、agent 就绪状态或实际执行已获验证。

### 动态流管理与代际防线

- **Activity SSE 事件流（`/api/activity/stream`）**：单条共享事件流在页面隐藏时（`document.visibilityState === "hidden"`）自动断开连接，通过受控的文档可见性事件与真实服务端 EventSource 验证，保留轨道收起期间的未读计数，并在恢复可见时自动重连与刷新。
- **代际标记防线**：详情与日志面板记录请求与选择代际标记（`generation.current`、`outputGeneration.current`），防止快速切换节点或 Run 时过期的异步响应覆盖新选中内容。

### 运维治理、标准流内面板与审批门

- **标准文档流**：运维卡片与面板（`.gates`、`LanesPanel`、`CleanupPanel`、`WorkerPanel`、`SchedulerPanel`）及中央详情区（`.workbench-detail .node-panel`）均参与常规文档布局流（`position: static; width: 100%`）。全局 `.gates` 不再使用绝对定位，彻底消除了早期版本中 Lane 与 Cleanup 绝对定位坐标（y=121）与中央主标题垂直重叠的缺陷。
- **概览与决策分级**：概览分节承载紧凑的待办操作摘要（`OperationsAttention` `variant="summary"`），显示待办计数与流内“打开决策”跳转按钮（`attention.openDecisions`）；决策分节承载完整交互列表（`variant="full"`），提供逐项聚焦定位与处理控件。
- **Lane 证据状态表达**：`LanesPanel` 在 Lane 证据尚未读取或不可用时显式展示待读状态提示（`lane.pending`：“通道证据尚未读取或不可用。”），避免无根据的假阴性推断。
- **Worker 舰队与派发标识**：`WorkerPanel` 展示清晰的 worker 属性、能力列与精确的 Dispatch 派发标识，移除重复的 Task ID 回退。进程退出报告为中立的 `exited` 存活状态（`#52647a`），仅表示进程终止，不推断成功或失败。
- **清理面板（`CleanupPanel`）**：提供按需候选审查（`review`），通过核验全局完整 fleet 列表（`listWorkers(undefined, { includeRemote: true })`）保护未在终端列表中的其他 Run Chat 及主/活跃工作区，要求逐项确认，并暴露原生安全删除已合并分支选项（`deleteBranch`）及 `preservedBranch` 证据。
- **规范审批门创建（`POST /api/gates`）**：中央详情区（`NodePanel`）支持为同 Run 尚未派发的任务创建审批门，受 coordinator 生命周期锁保护。
- **显式控制确认**：对未处于当前 viewer 活跃调度下的 Run 发起一次性变更时，要求提供匹配当前 Run 绑定的显式控制确认（`coordinatorControl`），严格拒绝隐式接管。
### 内存与性能边界的客观表达

技术文档与性能评估中，必须严格区分 **V8 JavaScript 堆内存（JS Heap）** 与**浏览器渲染进程 / GPU 合成器内存**：
- JavaScript 堆内存衡量的是 V8 引擎内分配的 JS 对象与闭包大小。
- 渲染进程与 GPU 合成器内存（图层位图缓存、Canvas 绘图上下文、DOM 节点树底层结构）由浏览器底层与操作系统独立调度。
- 移除持续的 SVG 滤镜运算、消除永久动画循环、实施 DAG 画布懒加载减轻了 CPU 运算与合成器图层负担；但关于内存与性能的表述必须基于实测证据。当前未对 CPU、合成器或内存的量化节省进行基准测试或认证声明。历史 Run 533 基线测得 JS 堆旧值 5708840 / 新值 5769648，未产生 GPU 或渲染器总内存缩减。严禁仅凭 JS 堆内存测量数据推断 GPU 或渲染器总内存节省，亦不得把设计优化方案描述为实测性能收益。
## 实施与验收

`App.tsx` 统一协调分节导航、URL Hash 路由、读取状态、传送执行控件、移动端单面板通信切换与中央详情焦点。顶栏采用居中徽标的自适应确定性 CSS 网格：在宽屏视口（`@media (min-width: 1200px)`）下采用单行 10 槽位网格（`grid-template-columns: 140px minmax(180px, 270px) 92px minmax(0, 1fr) 128px 128px 156px 156px 44px 60px; grid-template-areas: "brand run progress . health connection preview launch lang chat";`），将品牌、紧凑 Run 选择器、进度、占位弹性区、居中健康与连接徽标、预检、启动、语言切换及通信切换整合于单行，通知回执独占整行；在 `<1200px` 下动作按钮占第二行（在 901..1000px 间仅隐藏次要进度槽位以维持紧凑对齐）。在无通知展开的稳定状态下，顶栏实测高度为：宽屏视口（`≥1200px`：`1200px`、`1280px`、`1440px`）下中英文统一为 **69px**；中等视口（`901px`–`1199px`：`901px`、`959px`、`960px`、`1000px`、`1024px`、`1199px`）下统一为 **117px**；移动/窄屏视口（`≤900px`：`375px`、`390px`、`900px`）下统一为 **216px**。自然高度展开的诊断通知在激活时可自适应撑高顶栏，文档如实记录稳定态高度，不虚假声称所有通知状态下均死板锁死 69px。左侧导航项高度在双语下固定为 56px（行高 20px），设置面板同行交互控件在 1280px 下统一为 40px × 360px。
`DagView` 在首次访问时通过 `React.lazy` 动态加载，并在挂载后常驻内存。任务节点尺寸固定为 280×120px（`layout.ts` 中的 `NODE_W = 280`、`NODE_H = 120`），标题为 16px（行高 20px，字重 650），数据摘要为 14px（行高 20px）。依赖连线使用静态实线描边（`edge--idle`、`edge--run`、`edge--done`）与虚线层级连接，彻底消除持续循环的跑马灯动效。轻量执行脉冲（`@keyframes graph-executing`）仅在任务具有明确正向执行证据时呈现，并在后台、图非激活或启用 `prefers-reduced-motion: reduce` 时自动停用。
### 验收与核验清单

旧版测试脚本 `scripts/check-ui-layout.js` 针对已被移除的标签数量、CSS 类名和陈旧 API 桩数据进行了精确断言；根据项目测试原则，这些偶然性断言已被废止退休，不再重新固定。服务端测试套件保持完备运行（`npm test`）。

在本次深层布局重构前，既有完整检查套件处于通过状态（`npm run check`，841 项通过）。基于真实 Run 44 数据的构建后重新核验确认在全部 **168 组浏览器样本**中（7 条路由 × 12 个视口 × 2 种语言：375、390、900、901、959、960、1000、1024、1199、1200、1280、1440）达到完全稳定通过：
- **零文档溢出**：内容严格适配视口边界，覆盖包含 901px 边界及 375px 窄屏在内的全部测试断点。
- **零面板与标题交叉重叠**：运维面板（`.gates`、`LanesPanel`、`CleanupPanel`、`WorkerPanel`、`SchedulerPanel`）与中央详情区（`NodePanel`）均参与常规文档布局流（`position: static; width: 100%`），彻底消除了绝对定位导致的坐标冲突。
- **零顶栏/导航主槽位几何不一致**：在全部 12 个受测视口下，无通知稳定状态下的顶栏高度在中英文间完全一致（`≥1200px` 为 69px；`901–1199px` 为 117px；`≤900px` 为 216px）；导航按钮双语统一为固定 56px 高度与 20px 行高；设置面板三项同级控件在 1280px 下稳定为 40px × 360px。
- **隔离化冒烟检查全部通过**：8 组前端运行阶段用例（running、binding、completed、readonly 双语组合）确认 2 个主按钮在 156×40px 下同排不截字，状态与通知占满下方 1416px 整行，未调用任何写操作或原生停止；中央详情 5 处控件（44px）及 H1 标题；在主导航切换、语言切换及移动端切换下草稿与收件人保持完好；`lane.pending` 准确如实反映通道状态。
- 完整检查套件通过（`npm run check`，841 项通过），且通过 CSS/import 专项构建验证（`App.tsx` 显式引入 `operations-nav.css`，确保 B 行网格正常加载）。
- 视觉与交互核验记录存于：`web/.impeccable/review/deep-layout-verification.json` 与截屏记录 `deep-after-{section}-{lang}.png`。
#### 浏览器冒烟核验清单

1. **分节导航与 URL Hash 路由**：
   - 逐一浏览 7 个分节：概览（Overview）、任务（Tasks）、决策（Decisions）、执行（Executions）、动态（Activity）、资源（Resources）、设置（Settings）。
   - 验证激活项的高亮样式（`aria-current="page"`，`#284b72`）以及“决策”分节上的待办数量徽标。
   - 验证 URL Hash 同步更新为 `#section=<name>`，点击浏览器前进/后退按钮可在不同分节间平滑导航且不重新加载页面。
2. **任务：列表与图自由切换及 DagView 懒加载**：
   - 在任务分节中，切换“任务”（`TaskList`）与“依赖图”（`DagView`）。
   - 确认首次点击“依赖图”时展示 loading 占位并完成懒加载挂载，后续再次切换时无需重新加载。
   - 验证节点以 280×120px 规范渲染，带有清晰 1px 边框与静态依赖连线。
   - 验证执行中圆点的脉冲动画在切出视图、页面隐藏或启用 `prefers-reduced-motion: reduce` 时自动暂停。
3. **中央详情阅读区（`NodePanel`）**：
   - 在 `TaskList` 或 `DagView` 中点击任务：中央主工作区切换为 `NodePanel`（`.workbench-detail`），URL Hash 更新为 `#section=tasks&task=<id>`。
   - 验证标题（`h1.node-panel__title`）立即获得焦点。
   - 点击“关闭”按钮或按 `Escape` 键：验证平滑返回原视图（列表或图），离开时的滚动位置与焦点完全恢复。
   - 在详情内展开嵌套的 `DoodleSelect` 下拉菜单并按 `Escape`：验证仅关闭下拉菜单，详情区域保持打开。
4. **常驻通信侧栏与作用域草稿**：
   - 点击顶栏通信按钮打开侧栏：验证右侧面板以 440px 默认宽度展开，且拖拽分割线可在 380–820px 间平滑缩放（`COMMUNICATION_MIN_WIDTH = 380`、`COMMUNICATION_MAX_WIDTH = 820`，受视口宽度与导航/主阅读区预留空间动态约束，极限场景回退至 280px）。
   - 输入针对某任务或 coordinator 的草稿，切换至其他分节后返回：验证草稿内容保持完整。
   - 在 `RunPicker` 中切换至其他 Run：验证各 Run 之间的草稿与所选会话完全独立隔离，绝不隐式重定向派发。
5. **移动端单面板聚焦视图（≤900px 与 ≤760px）**：
   - 在 ≤900px 视口下，验证左侧导航栏转为顶部横向滚动栏。
   - 在 ≤900px 下打开通信侧栏：验证中央主区域自动隐藏，通信侧栏全宽占据视口。
   - 点击顶部导航切换分节：验证侧栏自动关闭，目标分节清晰呈现。
   - 在 ≤760px 下，验证“任务”分节默认呈现垂直 `TaskList`。
6. **菜单折叠面板与流内设置**：
   - 展开任务栏中的视图菜单：验证呈现为行内 `<details>` 控件与绝对定位面板 `.view-menu__panel`。
   - 验证按 `Escape` 键或点击外部可关闭面板并归还焦点至 `<summary>` 触发元素。
   - 切换至设置分节：验证执行偏好以标准流内表单（`.exec__settings-panel`）呈现，同级控件在 1280px 下保持 40px × 360px。
7. **四种读取状态与重试**：
   - 验证首次加载时的 loading 动画。
   - 验证首读失败时显示技术详情与刷新按钮，且禁用启动控制。
   - 验证确认为空时显示空工作区引导。
   - 验证刷新失败陈旧快照时展示过期提示条，点击“重试读取”只更新投影且不刷新全页。

## 聊天阅读优化

通信侧栏（`.workbench-chat`）延续了工作台的低噪现代风格。正文为 16px（`1rem`）、1.65 行高；元信息为 14px（`0.875rem`）或 13px（`0.8125rem`），会话标题保持 16px 半粗体。发出消息采用天蓝色底色（`#eaf2ff`），接收消息采用柔和中性底色（`#f5f7fa`），错误报告采用浅粉底色（`#fff0f1`）。消息最大阅读宽度限制在 65ch 内，长标识符具备自动折行防护（`overflow-wrap: anywhere`）。

- **受众选择器**：紧凑下拉菜单展示可用会话列表、主代理标签及未读徽标，不挤占侧栏顶部空间。
- **引用上下文**：引用的回复上下文基于正向证据驱动；仅当当前收件箱窗口中存在匹配 `threadId` 的原消息时才展示引用框。
- **草稿与状态细粒度隔离**：所有草稿与状态通过 `useScopedChatState` 实施清晰边界隔离：
  - 不确定性标记（`uncertainMessages`）按 `runId` 隔离。
  - 输入草稿（`draft`）按 `[runId, conversationId, targetId/dispatchId]`（Run、会话及目标问题/派发标识）隔离。
  - 繁忙状态（`busy`）、错误（`error`）、回执（`messageReceipt`、`operatorReceipt`）、时间线分页上限及展开检查按会话作用域 `[runId, conversationId]` 隔离。
  - 群播草稿与预览状态按 `runId` 隔离。
  切换 Run 或会话时草稿独立隔离，绝不发生误发或串话。
## 节点启动配置

中央节点详情（`NodePanel`）按依赖顺序列出启动参数：Agent/harness、模型、支持的 effort、工作区放置/环境，以及 OpenCode 界面模式。它强制贯彻 Orca 的不可变任务契约：任务一旦派发，其启动配置即永久锁定。

- **OpenCode 模型选择**：通过可搜索下拉菜单展示本地工作区建议性发现结果，并支持手动自由文本输入（`provider/model[#variant]`）。输入具备即时语法校验反馈，避免写入非法格式。
- **只读锁定字段**：禁用的表单项使用高对比度可读文字、实线边框与柔和背景底色（`opacity: 1; color: var(--ink); background: var(--paper-2); cursor: not-allowed;`）呈现，不再整体淡化为不可读的灰色，亦不再采用过时的虚线边框，锁定原因在相邻提示中清晰可见。
- **桌面端与移动端协同**：桌面端检查直接替换中央工作区，提供开阔视角；在 ≤900px 移动端视口下，任务检查优先于聊天显示，关闭后平滑返回原界面。
