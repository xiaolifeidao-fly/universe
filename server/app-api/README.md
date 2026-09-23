# app-api

独立的移动端与本机 Worker API。它复用现有用户 token 和 `service/delivery` 的权威命令领域；Redis 仅用于唤醒同一用户的 Worker，MySQL 始终保存命令状态、租约、活动和结果。

## 启动前

1. 对已有数据库依次执行 [`../migrations/20260903_delivery_command_center.sql`](../migrations/20260903_delivery_command_center.sql)、[`../migrations/20260904_app_api_push_subscription.sql`](../migrations/20260904_app_api_push_subscription.sql) 和 [`../migrations/20260906_delivery_command_attachment.sql`](../migrations/20260906_delivery_command_attachment.sql)。
2. 基于 [`configs/application.example.properties`](configs/application.example.properties) 在运行目录创建 `configs/application.properties`，填入 `sqlconn`、`auth.token_secret`，并按部署环境设置 Redis、OSS 和 Web Push VAPID 配置。业务访谈的 `business.kodes.*` 取值必须与 web-api 一致：手机端和控制台提的诉求落在同一张表上，装配不一致会让同一条访谈在两个入口得到两种行为。
3. Worker 注册时只提交 `programIds`，本机工作目录绝对路径不能提交到服务端。

## 本地运行

```bash
cd server/app-api
go run .
```

默认监听 `:10002`，可用 `APP_API_ADDR` 覆盖。`redis.addr` 为空时服务仍可启动，Worker 会在每次长轮询结束后从数据库回退领取；生产环境应配置 Redis 以获得即时唤醒。

协议端点、状态流转、续租和 SSE 游标见 [`../../doc/module/command-center-169a8d1f48/design/command-protocol.md`](../../doc/module/command-center-169a8d1f48/design/command-protocol.md)。

## 移动 API

- `POST /api/auth/login`、`GET /api/auth/me`：登录与当前授权范围。
- `POST /api/commands/attachments`、`GET /api/workers/attachments/{attachmentId}`：任务会话附件先由 app-api 按用户、项目和任务临时保存，再由已领取命令的同用户 Worker 下载。浏览器不会连接本机 bridge，命令输入只保存附件 ID。
- `GET /api/delivery/programs`、`/program`、`/board`、`/requirements`、`/requirement`、`/items`、`/item`：项目与任务面板查询。
- `POST /api/delivery/requirement/save`、`/requirement/planning-batch/create`、`/item/create`、`/item/patch`：需求编辑与拆解批次、任务编辑和依赖图调整。所有项目写入按 token 权限检查，负责人显示名由项目成员目录重写。
- `GET /api/business/programs`、`/requirements`、`POST /api/business/requirements`、`GET /api/business/requirement`、`POST /api/business/requirement/messages`、`/requirement/attachments`、`GET /api/business/requirement/attachment`、`/requirement/references`：业务方的诉求访谈，接口语义与控制台业务工作台一致，访谈本身由 `service/businessassistant` 直接打到常驻的远端 Kodes 访谈主机（`business.kodes.remote_url`）。`GET /api/business/research/requirements`、`/research/requirement` 是产研侧的只读诉求采集。
- `GET /api/documents`、`/documents/preview`、`/documents/url`：仅在项目启用云同步且调用者有项目权限时读取 OSS 目录、受控预览或按 `oss.expireTime` 生成的短时签名地址。
- `GET /api/push/config`、`PUT|DELETE /api/push/subscription`：PWA Web Push 配置与订阅。任务完成、失败、超时或结果标记 `status=blocked`，以及 `task.conversation` 的 AI 回复完成时会尝试推送，不改变命令权威状态。
