# 移动端工作台改造实现说明

## 交互结构

底部导航是「工作台 / 项目 / 设置」三个入口，`/` 直接进工作台，原「概览」页与「项目」重复，已合并；原「活动」页降级为工作台右上角的运行记录入口（`/commands`），只列命令活动，不再摆命令表单。

工作台按需求组织：选项目 → 需求卡片（完成度、任务计数）→ 卡片上四个入口。

| 入口 | 落点 | 形态 |
| --- | --- | --- |
| 对话 | `/workbench/requirements/<需求键>/chat` | 整屏会话，聊天记录从顶部下拉 |
| 进度 | `/workbench/requirements/<需求键>/progress` | 进度环 + 阶段分组 + 执行批次 |
| Git | 底部面板 | 状态 / 分支 / 改动 / 工程，含单文件差异 |
| 文档 | 底部面板 | 该需求目录下已同步的云端文档 |

任务进度里展开一条任务还能进 `/workbench/tasks/<任务键>/chat`，即任务级会话。`/workbench/` 下的路由是沉浸式的：外壳不再叠加顶部品牌栏和底部导航，页面自带返回。

## 数据通路

移动端仍然只连 `server/app-api`，不访问本机桥接地址。

只读视图直接读服务端：新增 `GET /api/delivery/requirement/progress`、`/requirement/timeline`、`/requirement/planning-sessions`，都挂在既有的产研只读组上，复用交付服务已有的实现。聊天记录目录因此在 Worker 回话之前就能铺出来。

会话与 Git 走远程命令。新增两条只读命令类型：`task.planning-session` 读需求拆解会话快照，`task.planning-stop` 停止本轮拆解；发送仍是既有的 `task.planning`。移动端只传需求键，需求正文、起始阶段和拆解开关由 Worker 从任务面板补齐后再进入本机会话，附件同 `task.conversation`，按 `__project_planning__:<需求键>` 归档。

## Worker 的只读通道

一台 Worker 现在开两条领取通道。执行通道照旧串行跑写操作；只读通道单独领取快照类命令（会话快照、`git.status` / `git.branches` / `git.changes` / `git.change` / `git.projects` / `git.merge-preview` / `git.workspace-check`），两条通道各有各的运行锁。

服务端 `POST /api/workers/commands/claim` 因此接受 `commandTypes`：申请的类型先与该 Worker 登记的能力求交集，交集为空就不领，未登记的类型一律忽略，不会因为申请而扩权。

这条通道是为了让一轮几分钟的拆解跑着的时候，手机上仍然能刷新会话、翻 Git 改动，而不是排在长任务后面等。

## 会话呈现

桥接回传的回合条目按类型分开渲染：用户消息和最终回复始终展开，思考、命令、工具调用折叠成一行，文件改动在回合末尾汇总成「本次改动 N 个文件」并带增删行数。正文用内置的轻量 Markdown 呈现（代码块、标题、列表、行内代码），不引入 Markdown 依赖，也不注入 HTML。

回合在跑时，界面同时盯两处：命令状态给出「执行电脑处理中 x%」，会话快照每 4 秒回读一次正文。

## 文件差异

`git.change` 回的是改动前后两份正文。手机放不下左右分栏，前端用 LCS 把两份正文对齐成单栏，增删各自着色并保留行号；任一侧超过 1200 行就不再逐行比对，只显示新正文。

## 验证

- `client/app`：`npx tsc --noEmit`、`npm run build` 通过；在 375×812 视口下逐屏走查了工作台、需求对话（含聊天记录展开）、Git 面板（状态 / 改动 / 单文件差异）、需求文档面板、任务进度（含多选执行）。
- `server`：`go test ./service/... ./app-api/...` 通过，新增只读通道的能力收敛用例。
- `delivery-task-planner`：`scripts/test_remote_worker.py`、`scripts/test_http_bridge.py` 通过，新增拆解会话快照命令与需求上下文补齐的用例。

页面走查用的是本地打桩数据；接真实执行电脑的联调需要 Worker 在线。
