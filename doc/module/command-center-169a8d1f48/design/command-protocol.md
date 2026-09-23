# 用户命令领取协议

## 权威边界

- MySQL 的 `zt_delivery_command` 与 `zt_delivery_command_event` 是命令状态、租约、结果和活动的唯一权威来源。
- Redis 键 `delivery:command:notify:{userID}` 只保存待领取命令的 `commandId` 提示；队列过期、重复或不可用不影响数据库回退领取。
- 插件只登记 `(bizLine, programId)` 本机映射，不上传绝对工作目录。服务端拒绝命令、活动和结果 JSON 中的 Unix、Windows 盘符及 UNC 绝对路径；项目内相对路径可用。

## 端点

所有端点使用当前登录用户 token；`bizLine` 通过 `X-Biz-Line`（或查询参数）传递。

| 调用方 | 方法与路径 | 要点 |
| --- | --- | --- |
| PWA | `POST /api/commands` | 提交 `programId`、`commandType`、对象形式 `input` 与稳定 `idempotencyKey`；用户标识由 token 覆盖。 |
| PWA | `GET /api/commands` | 返回当前用户的命令快照。 |
| PWA | `POST /api/commands/{commandId}/cancel` | `pending` 立即取消；已领取或运行中仅写 `cancelRequested=true`。 |
| PWA | `GET /api/commands/{commandId}/events` | SSE，使用 `afterId` 或 `Last-Event-ID` 重连。事件 `id` 是单调数据库游标。 |
| Worker | `POST /api/workers/register` | 登记单一业务线的 `workerId`、`capabilities` 和有本机映射的 `programIds`。 |
| Worker | `POST /api/workers/commands/claim?waitSeconds=20` | 先消费 Redis 唤醒提示，再由数据库筛选同用户、映射项目和声明能力匹配的待领取命令。 |
| Worker | `POST /api/workers/commands/{commandId}/lease` | 两分钟租约续租，必须携带领取时返回的 `leaseToken`。 |
| Worker | `POST /api/workers/commands/{commandId}/activity` | 上报活动、可选 `progress`（0-100）并续租，命令转为 `running`。 |
| Worker | `POST /api/workers/commands/{commandId}/complete` | 以 `succeeded`、`failed` 或 `cancelled` 之一回传对象形式结果。 |

## 状态与恢复

`pending -> leased -> running -> succeeded|failed|cancelled` 是正常路径。`pending` 可直接取消；运行中的取消是尽力而为，不抢占 Worker 的最终回传。

超时由 `app-api` 每 30 秒扫描：待领取命令超过两分钟会重新通知，累计三次投递仍未领取则转为 `timed_out`；已领取命令租约超时后，领取次数不足 3 次会回到 `pending` 并重新通知，否则也转为 `timed_out`。每次提交、领取、续租、活动、取消、完成和超时处理都追加事件，SSE 仅从事件表读取，因此刷新和断线重连不会重复展示已确认的游标。
