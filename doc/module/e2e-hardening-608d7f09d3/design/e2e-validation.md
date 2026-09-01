# PWA 远程执行联调验收清单

## 已自动验证的边界

- `client/app` 通过 `npm run typecheck` 和 `npm run build`。
- `server/app-api`、`service/delivery`、`common/objectstore` 的 Go 测试覆盖认证上下文、命令输入路径隔离、附件限制、SSE 游标、OSS 受控读取和 Push 订阅校验。
- 新增的 SSE 回归测试验证终态命令超过 200 条活动时，服务端会继续分页回放；浏览器以服务端 `id:` 和 JSON 事件 ID 保持单调游标。
- Remote Worker 的 Python 回归测试覆盖本机 workspace 映射、竞争领取所需的租约回传、路径脱敏、附件下载和尽力取消适配。

以下项目依赖真实 MySQL、Redis、OSS、VAPID 和设备浏览器，不能由没有部署凭证的本地构建替代。执行时使用测试项目和测试账号，不在命令输入、日志或截图中记录 Token、VAPID 私钥、OSS 凭证或本机绝对路径。

## 部署前提

1. 依次执行 `server/migrations/20260903_delivery_command_center.sql`、`server/migrations/20260904_app_api_push_subscription.sql`、`server/migrations/20260906_delivery_command_attachment.sql`。
2. 启动 `app-api`，并为独立部署的 PWA 配置 `app.cors_origins`。该值是逗号分隔的完整来源，例如 `https://pwa.example.test,http://localhost:7894`；不支持通配符。PWA 和 API 由同一反向代理来源提供时保留为空。
3. 准备两个互不授权的产品研发用户、一个开启云同步范围的项目、一个关闭云同步的项目，以及同一用户下两个已登记该项目 workspace 映射的 Worker。
4. 为 Push 测试配置 HTTPS、`push.vapid_public_key`、`push.vapid_private_key` 和 `push.vapid_subject`。无 VAPID 配置时，通知入口应显示服务端未配置，但远程操作仍可提交。

## 联调步骤

| 场景 | 操作 | 可观察结果 |
| --- | --- | --- |
| 权限隔离 | 用户 A 创建命令、附件和 OSS 文档链接；用户 B 使用自己的会话尝试读取、取消、下载和订阅。 | 用户 B 不能读取或修改用户 A 的命令及附件，也不能跨项目读取文档；Worker 只领取当前认证用户的命令。 |
| 幂等与并发领取 | 对同一业务动作并发提交相同 `idempotencyKey`，再让两台同用户 Worker 同时领取。 | 所有提交返回同一 `commandId`；事件中只有一个 `claimed`，仅一个 Worker 有效租约。 |
| 两分钟掉线 | Worker 领取后停止其进程，等待租约过期后恢复或让另一台 Worker 轮询。 | 命令在事件中记录租约恢复；尝试未耗尽时回到 `pending` 并被重新领取，达到上限后为 `timed_out`。 |
| 取消竞态 | 分别取消 `pending`、运行中的任务会话、批量执行和短 Git 命令。 | 待领取命令立即为 `cancelled`；运行中命令保留 `cancelRequested=true`，Worker 尽力停止后以实际终态回传，不产生第二次执行。 |
| SSE 重连 | 在命令运行期间切断 PWA 网络至少一次，再恢复、刷新页面并从 Push 跳转回命令。 | 从最新游标恢复活动，无重复事件 ID；终态命令仍可回放完整历史，即使活动数超过 200。 |
| OSS 开关 | 对开启项目查看 `chat`、`requirement`、`design`、`test`、`prototype`、`execution`、`attachment` 范围的文件；对关闭项目重复请求。 | 开启项目只返回已配置范围的受控内容或五分钟签名地址；关闭项目显示清晰降级错误，不代理本机文件或泄露对象键/本机路径。 |
| Push 拒绝和失效 | 在 iOS/Android 拒绝通知权限、撤销权限，并让测试端点返回 404 或 410。 | 设置页说明权限被拒绝且主流程不受影响；失效订阅会从服务端删除，命令状态和完成结果保持不变。 |
| iOS PWA | iOS 16.4+ Safari 添加主屏幕后登录、提交命令、切后台并从 Push 打开。 | standalone 显示正常，安全区和底部导航不遮挡，iOS Safari 才显示“添加到主屏幕”指引。 |
| Android PWA 与弱网 | Android Chrome 安装 PWA，在慢速网络和离线导航下打开已有页面、恢复网络后操作。 | 应用壳和 `/offline` 可用；`/api/*` 从不被 Service Worker 缓存，恢复后命令快照和 SSE 重新同步。 |
| PC 回归 | 在 `client/web` 按原流程执行任务、批量任务、Git 与云同步。 | PC 代理、浏览器直连本地 bridge 和已有交付批次流程不受 `app-api`、CORS 或 PWA 变更影响。 |

## 清理

删除测试命令及附件、测试 Push 订阅和 OSS 测试对象；停止额外 Worker。保留事件表记录直到测试报告归档完成，以便核对领取、续租、取消和终态的时序。
