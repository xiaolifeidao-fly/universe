# 移动端执行与 Git 控制实现说明

## 已落实的命令边界

PWA 仅调用 `server/app-api` 的 `/api/commands`、`/api/commands/attachments` 和移动管理读取接口。任务执行、会话、停止、Git 与附件均不访问 Python bridge 的本地 HTTP 地址。

Worker 只从已登记的 `(bizLine, programId)` 本机映射领取命令，继续沿用命令中心的租约、取消和完成回传。新增的 `task.session` 为只读会话快照命令；它与其他任务动作一样先落入权威命令表后才会读取本机会话。

## 附件流

1. PWA 在发送任务会话时将不超过 5 个、每个不超过 20 MB 的图片或文件提交给 `POST /api/commands/attachments`。
2. `app-api` 根据当前用户、项目写权限和任务键保存临时二进制内容到 `zt_delivery_command_attachment`，响应仅含附件 ID 和元数据。
3. PWA 创建 `task.conversation` 命令，输入仅包含附件 ID，不把文件编码进命令 JSON。
4. 已领取命令的同用户 Worker 通过 `GET /api/workers/attachments/{attachmentId}?programId=...` 下载内容，并通过本机已映射工作目录的附件存储写入后，再调用既有会话入口。

附件内容不出现在命令结果、SSE 活动或 Worker 注册信息中，本机绝对路径也不会经过 app-api。

## PWA 交互

`client/app/src/components/screens/command-screen.tsx` 在活动页提供执行和 Git 两个工作面：

- 单任务、批量、按依赖顺序执行，任务停止和全部停止。
- 会话快照、追加消息以及系统键盘原生听写输入框。
- Git 状态、分支、改动、文件差异、关联工程、工作区检查、初始化、子模块、创建/准备分支、推送、合并预览和确认合并。
- 命令详情以自定义 `fetch` SSE 流接收活动，用命令 ID 的 `sessionStorage` 游标去重并在断线后从服务端快照恢复。

通知携带的 `commandId` 和跳转到关联任务的既有入口继续保留。

## 部署

执行 [`server/migrations/20260906_delivery_command_attachment.sql`](../../../../server/migrations/20260906_delivery_command_attachment.sql) 后启动 `app-api`。PWA 使用已有 `NEXT_PUBLIC_APP_API_BASE_URL` 指向该服务；Worker 继续使用部署配置 `DELIVERY_COMMAND_API_URL`。

## 已知验证限制

当前会话没有可用的受控浏览器，未能生成手机视口截图。PWA 已通过 TypeScript 类型检查和生产构建；服务端与 Worker 的自动化测试覆盖附件上下文及本机会话附件写入路径。
