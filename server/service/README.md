# service —— 领域实现层

与 `common/` 同级的独立 module。所有领域实现放这里；6 个可部署单元
（见 `SERVICES.md`）只做 main / router / wire / config，不放业务逻辑。

## 分层与包

| 层 | 包 | 职责 | 表前缀 |
| --- | --- | --- | --- |
| 0 业务线 | `bizline` | 业务线注册与能力集；其余六层都带 `biz_line` 关联 | `zt_bizline_` |
| 1 资源服务 | `resource` | 设备 · IP · 号 · 四元绑定的维护，**唯一写入方** | `zt_resource_` |
| 2 指令与任务模板 | `task` | 指令定义 · 模板配置 · 任务下发 / 指定下发 · 端侧拉取 | `zt_task_` |
| 3 风控 | `risk` | 封控归因 · 账号评分 · 投产反馈 · 策略反哺分析 | `zt_risk_` |
| 4 策略决策配置 | `strategy` | 策略配置维护与版本发布 | `zt_strategy_` |
| 5 AI 调度 | `aisched` | Agent 注册与执行调度，输出场景 ID + 内容槽 | `zt_aisched_` |
| 6 业务编排 | `orchestration` | 时间线引擎 · 远控设备 · 串联所有业务动作 | `zt_orch_` |

## 四条约束

1. **`internal/repository` 隔离。** 每个包的 gorm model 与 repository 都放在
   `<包>/internal/repository`，Go 的 internal 规则保证只有该包自己的目录树能引用。
   资源绑定单写不是约定，是编译期事实。

2. **领域包之间不许互相 import。** 需要别的领域的数据时，由**消费者**在自己的
   `ports.go` 里声明所需的最小接口（见 `orchestration/ports.go`），实现在各
   API 的 main 里注入。依赖方向由装配决定，不由 import 决定 —— 也正因如此，
   同一个接口既可以注入本地实现，也可以注入 `client` 的 HTTP 实现。

3. **表前缀 = 包名。** 一个包只碰自己前缀的表，跨前缀查询走接口。

4. **可部署单元里没有业务逻辑。** 二进制目录只有 main / router / wire / config。

## 跨领域数据

跨包传递的数据形状统一放在 `contract` module（零依赖），领域包各自的
`dto/` 只放本领域对外的请求 / 响应形状。
