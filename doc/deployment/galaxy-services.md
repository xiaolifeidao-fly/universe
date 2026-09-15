# Galaxy 三服务部署

Galaxy 拆为三个独立 Go 模块、二进制和进程。三个 API 模块各自持有接口、路由装配和启动入口，不互相依赖。公共代码放在 `galaxy-common`，领域实现保留在 `service/galaxy`。三者共享原有 MySQL 数据和 Redis 控制面，无需搬表。

| 服务 | 默认端口 | 职责与路由 |
| --- | --- | --- |
| galaxy-api | 10004 | Nova 提供端控制台、提供端账号：`/api/galaxy/provider/*` |
| galaxy-consumer-api | 10005 | Orbit 使用端控制台与账号：`/api/galaxy/consumer/*`；门户：`/api/galaxy/portal/*`；支付回调：`/galaxy/payments/*` |
| galaxy-hub-api | 10006 | 消费者 SDK：`/v1/*`；bridge 注册、配对、心跳、领任务、回传、升级：`/agent/v1/*`；bridge 安装下载：`/agent/v1/bridge/*` |

每个服务保留 `/healthz` 和 `/metrics`。运营接口仍归 manager-api。

## 代码归属

- `galaxy-api/pkg/{auth,providers}`：提供端登录入口和控制台 Handler。
- `galaxy-consumer-api/pkg/{auth,consumers,portal}`：使用端登录入口、控制台、支付回调和门户 Handler。
- `galaxy-hub-api/pkg/{agent,bridge,native,exportdispatch,local}`：节点与安装下载 Handler、SDK 原生 Handler、派单器、抽检重放；`adapters/{core,relay,delivery,videofarm}` 为 Hub 模块内的传输与业务适配器。
- `galaxy-common/{auth,bootstrap,kinds,local,metrics,payments}`：共用鉴权实现、领域服务初始化与配置、能力契约、对象存储签名、指标和支付验签。它不依赖任何 API 模块，也不集中注册业务路由。
- 各服务的 `routers` 只装配本服务接口。Hub 的 `runtime` 独占后台任务；两个控制台不会创建 Exchange、Journal、传输适配器或后台派单器。

各模块均可 `GOWORK=off go build .`。适配器原来的四个嵌套 Go 模块已并入 `galaxy-hub-api`，执行 Hub 的 `go test ./...` 即包含它们。

bridge 直接连接 Hub，galaxy-api 不代理机器协议。SDK 请求和 bridge 流式回传在 Hub 内的同一个 Exchange 交汇，响应体不经过控制台服务。export 派单器、分钟巡检和抽检循环只在 Hub 启动。多 Hub 实例的 `galaxy.instance` 必须分别指向可被节点访问的具体实例，不能把实例地址配置成随机负载均衡入口。

## 配置

分别将各服务的 `configs/application.example.properties` 复制为同目录的 `application.properties`，填入部署环境配置。三个进程必须从各自服务目录启动，配置加载器按工作目录读取配置。

- 三份配置使用同一 MySQL、Redis 地址和 `galaxy.redis_namespace`，以及一致的 `galaxy.adapters`、`galaxy.models`、计费与额度配置。
- 保持 `galaxy.auth.token_secret`、`galaxy.key_cipher_secret` 一致；manager-api 中有关 Galaxy 密钥的配置也需要一致。
- `server.address` 分别为 `:10004`、`:10005`、`:10006`。
- `galaxy.consumer_base_url`：SDK 访问 Hub 的地址，例如 `https://hub.example.com/v1`。
- `galaxy.provider_hub_url`：bridge 直连 Hub 的地址，例如 `https://hub.example.com`。三份配置都应明确填写，提供端页面由此展示正确的安装、配对和接入地址。
- `galaxy.instance`：Hub 的具体实例地址。Hub 创建的任务会将此地址写入 `streamURL`，必须能从 bridge 所在机器访问。
- Hub 配置对象存储、bridge 发布下载与抽检账号；使用端服务配置支付渠道和回调验签。SDK 自助订单也使用支付配置，需要在 Hub 保持一致。

监听地址环境变量依次为 `GALAXY_API_ADDR`、`GALAXY_CONSUMER_API_ADDR`、`GALAXY_HUB_API_ADDR`，优先于 `server.address`。

## 构建与启动

每个目录都有独立的 `build.sh`、`start.sh`、`stop.sh`、`redev.sh`、`package.sh`、`unpack-release.sh`。构建和打包使用 `GOWORK=off`，不依赖整个工作区构建。先启动 Hub，再启动两个控制台服务。

```sh
cd server/galaxy-hub-api
./build.sh
./start.sh
```

另外两个服务在各自目录执行相同命令。`package.sh` 生成独立 Linux 发布包，只包含示例配置，不覆盖部署机密钥。

## 从旧聚合服务迁移

1. 准备三份配置及二进制，保留原有数据库、Redis namespace、密钥和业务配置。
2. 启动新的 Hub 与使用端服务；将 Nova 的 `SERVER_TARGET` 指向 galaxy-api，Orbit 和门户的 `SERVER_TARGET` 指向 galaxy-consumer-api。已有 `.env` 需要显式更新，示例文件不会覆盖部署配置。
3. 将 SDK 的 base URL 和 bridge 的 `pool.hubURL` 更新为 Hub 地址；旧 bridge 安装下载链接也改为 Hub。若保留统一外部域名，在现有部署网关按上表将路径直接路由到所属服务。
4. 排空旧聚合进程中的请求，再将 galaxy-api 更新为仅提供端控制台的版本。新 galaxy-api 不再接受 `/v1/*`、`/agent/v1/*` 和使用端路由，旧客户端继续打旧端口会得到 404。
5. 检查三个健康接口，分别验证两端登录、bridge 注册与心跳、真实 SDK 流式调用及支付回调。

代码验证包括三个模块的独立编译、路由隔离测试以及已有 agent、bridge、auth、consumer 和适配器测试。真实数据库、Redis、已登录客户端和支付渠道联调需要在部署环境执行。
