# Galaxy 三服务部署

Galaxy 拆为三个独立 Go 模块、二进制和进程。三个 API 模块各自持有接口、路由装配和启动入口，不互相依赖。公共代码放在 `galaxy-common`，领域实现保留在 `service/galaxy`。三者共享原有 MySQL 数据和 Redis 控制面，无需搬表。

| 服务 | 默认端口 | 职责与路由 |
| --- | --- | --- |
| galaxy-api | 10004 | Nova 提供端控制台、提供端账号：`/api/galaxy/provider/*` |
| galaxy-consumer-api | 10005 | Orbit 使用端控制台与账号：`/api/galaxy/consumer/*`；门户：`/api/galaxy/portal/*`；支付回调：`/galaxy/payments/*` |
| galaxy-hub-api | 10006 | 消费者 SDK：`/v1/*`；bridge 注册、配对、心跳、领任务、回传、升级：`/agent/v1/*`；bridge 安装下载：`/agent/v1/bridge/*`。对外这两段都挂在 `/hub-api` 前缀下，由 nginx 剥掉，服务自己不认前缀 |

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

三份示例配置只列本服务真正读取的键，各自末尾有一段「故意不在这里的配置」说明哪些键归别的服务，不要互相拷贝补全。

公共段（三份必须填成同一份）：`sqlconn`、`redis.*`、`galaxy.redis_namespace`、`galaxy.adapters`。`server.address` 分别为 `:10004`、`:10005`、`:10006`。

只在部分服务里出现、但取值必须一致的键：

| 键 | 在哪几份配置里 | 不一致的后果 |
| --- | --- | --- |
| `galaxy.auth.token_secret` / `token_ttl_seconds` | galaxy-api、galaxy-consumer-api | 两端控制台各自登录，Hub 不认账号令牌 |
| `galaxy.key_cipher_secret` | galaxy-consumer-api、galaxy-hub-api（manager-api 同值） | 有的密钥取得回明文、有的取不回 |
| `galaxy.models` | galaxy-consumer-api、galaxy-hub-api | 控制台能选的模型 SDK 拿不到 |
| `galaxy.provider_hub_url` | galaxy-api、galaxy-hub-api | 接入页展示的地址与节点实际该打的地址不一致 |
| `galaxy.provider_terms_version` | galaxy-api、galaxy-hub-api | 同意记录版本对不上，节点反复被要求重新同意 |
| `galaxy.consumer_notice_version` | galaxy-consumer-api、galaxy-hub-api | 同上，发生在签发新密钥时 |
| `galaxy.key_ttl_days` / `key_freeze_days` | galaxy-consumer-api、galaxy-hub-api | 控制台签发与 SDK 换发算出不同有效期 |
| `galaxy.bind_idle_ttl_ms` / `heartbeat_timeout_ms` | galaxy-api、galaxy-hub-api | 控制台的座位与在线灯和派单结果对不上 |
| `galaxy.reputation_recovery_per_day` | galaxy-api、galaxy-hub-api | 页面显示的回血速度不是实际的 |
| `galaxy.referral.rate` / `.days` | galaxy-api、galaxy-hub-api | 页面写着返现比例，结算时按另一个值发 |
| `oss.*` | galaxy-consumer-api、galaxy-hub-api | 一边传上去、另一边签不出下载地址 |

各服务独有的键：galaxy-api 有 `galaxy.platform_seat_limit`、`galaxy.payout_*`、`galaxy.referral.register_url`；galaxy-consumer-api 有 `galaxy.consumer_base_url`、`galaxy.portal.*`、`galaxy.payment.*`（Hub 的 `/v1/orders` 只建待支付订单，验签与到账都在使用端服务，Hub 不需要支付配置）；galaxy-hub-api 有 `galaxy.instance`、`galaxy.contract_version`、`galaxy.redis_pool_size`、派单与超时参数、`galaxy.audit.*`、`galaxy.bridge_release.download_base_url`。

### 三个「对外地址」必须和 nginx 上那条 location 对齐

`galaxy.provider_hub_url`（节点打哪儿）、`galaxy.consumer_base_url`（SDK 打哪儿）、
`galaxy.instance`（上行打哪儿）都是**发给别人机器**的地址。填错不会让本服务启动失败，
只会让对面拿着一个打不通的 URL —— 所以它们和 nginx 是一对，只改一边必然出事。

线上这三个值都带 `/hub-api` 前缀：

```properties
galaxy.provider_hub_url  = https://www.galaxy.rodeo/hub-api        # galaxy-api 与 galaxy-hub-api，必须同值
galaxy.consumer_base_url = https://www.galaxy.rodeo/hub-api/v1     # galaxy-consumer-api
galaxy.instance          = https://www.galaxy.rodeo/hub-api        # galaxy-hub-api，单实例部署就填这个
```

而 Go 服务注册的路由是 `/v1/...` 与 `/agent/v1/...`，**没有**这段前缀 —— 前缀由 nginx 在
转发前剥掉（[nginx/www.galaxy.rodeo.conf](nginx/www.galaxy.rodeo.conf) 里 Hub 那条 location，
全文唯一一条会改写路径的 `proxy_pass`）。也就是说前缀纯粹是「对外怎么摆」，加一段、换一段、
去掉一段都只需要同时改这两处，Go 侧一行都不用动。

踩过的两次都在这条缝上：

- **配置带前缀、nginx 上没有那条 location。** `/hub-api/agent/v1/pair` 顺着 `location /`
  掉进门户站，门户回自己的 404 **HTML**，而节点是把响应体当错误信息抛出来的：Nova 的
  「加入共享池」弹出一整页 HTML 源码，看上去像前端坏了，跟配置一点关系都看不出来。
  改前缀之前先确认 nginx 转不转 —— 反过来也一样，先改 nginx 再改配置，中间那一刻是断的。
- **`galaxy.instance` 留着开发用的 `http://127.0.0.1:10006`。** 节点跑在**用户自己的电脑**上，
  streamURL 拼出来是 `http://127.0.0.1:10006/agent/v1/units/.../stream`，指回用户那台机器自己。
  配对能过，派单之后才炸，所以这一项很容易在联调时被漏掉。

nginx 侧只放行 Hub 真正对外的 `/v1/` 与 `/agent/v1/` 两段，**不是**把 `/hub-api/` 整段代理过去：
后者会让 `/hub-api/metrics`、`/healthz`、`/readyz` 一起漏到公网。给 Hub 加对外路由时要顺手改
那条正则，否则新路由带前缀访问就是 404。

改配置要重启对应服务（配置在进程启动时读一次）；只改 nginx 的话 `nginx -t && systemctl reload nginx`
就够，Go 进程不用动。

`galaxy.instance` 是多实例部署里**唯一必须逐个实例配不同值**的键。派单时它被写进 `req:{rid}.instance`，节点领活拿到的 `streamURL` 由它拼成，而消费者的连接活在某个进程的内存里（响应字节不进 Redis），上行必须打回同一个进程。**填负载均衡入口会让上行随机落到别的实例**，表现为概率性的节点掉线与 `no_capacity`，两边日志都正常；`ip_hash` 之类的粘滞也救不了 —— 要钉住的是「哪条请求」，而消费者和节点是两个不同的客户端、两个不同的 IP。其余接口（`/v1/*`、节点的 register / hello / heartbeat / next）落到哪个实例都行，照常走统一入口。

推荐的多实例写法是**统一域名 + 一段实例标识**，让 nginx 按那一段精确转发，而不是给每台机器各开一个域名：

```properties
galaxy.instance = https://www.example.com/instance/{hostname}
```

`{hostname}` 由 Hub 启动时替换成本机主机名的短名，所以这一行三台照抄即可，配置文件不必逐台修改；也可以用环境变量 `GALAXY_INSTANCE` 覆盖这一项（优先级高于配置文件），容器与编排直接注入。nginx 侧是一条 `map` + 一条正则 `location`，加机器就是表里加一行，见 [nginx/www.galaxy.rodeo.conf](nginx/www.galaxy.rodeo.conf) 的「实例定向路由」段。

注意这条路由**只能是精确映射，不能是哈希**。`hash ... consistent` 由 nginx 自己的算法挑 peer，而这里需要的是「送到 Hub 指定的那一台」；而且 unitId 是消费者请求落到某台之后才生成的，拿它去哈希和当初的选择没有任何关系。路由信息必须由 Hub 写进 URL，nginx 只负责照着送。

监听地址环境变量依次为 `GALAXY_API_ADDR`、`GALAXY_CONSUMER_API_ADDR`、`GALAXY_HUB_API_ADDR`，优先于 `server.address`。

## 构建与启动

每个目录都有独立的 `build.sh`、`start.sh`、`stop.sh`、`redev.sh`、`package.sh`、`unpack-release.sh`。构建和打包使用 `GOWORK=off`，不依赖整个工作区构建。先启动 Hub，再启动两个控制台服务。

```sh
cd server/galaxy-hub-api
./build.sh
./start.sh
```

另外两个服务在各自目录执行相同命令。`package.sh` 生成独立 Linux 发布包，只包含示例配置，不覆盖部署机密钥。

## 进程生命周期与发版

三个服务都接管 SIGTERM / SIGINT，收到之后按固定顺序收尾，不再是「收到信号当场死」：

1. **翻就绪、停止领新活**。`/readyz` 立刻返回 503；Hub 的 `/agent/v1/next` 当场回 204，已经挂在长轮询上的那些也会被叫醒（同样回 204，节点换一台再来）。这一步必须在关监听之前 —— 否则节点会在最后一刻领到一个单元，回头却发现推不回来。
2. **等上游摘流量**（`galaxy.shutdown.drain_delay_ms`，默认 5 秒）。nginx reload 和 K8s 更新 Endpoints 都不是瞬时的。
3. **关监听，等在途请求跑完**（`galaxy.shutdown.timeout_ms`，Hub 默认 630 秒，两个控制台 30 秒）。
4. **退出**。

时限只为**不可中断**的连接而设 —— relay 的消费者请求和它对应的节点上行，那上面已经有字节流出去了，掐掉就是一次收不回的失败。可中断的连接在第 1 步就各自收线：节点长轮询回 204；session / job 的 SSE 订阅主动发一个 `end`（事件先落库后广播，客户端按 seq 重连能补齐）。所以平时退出是秒级的，630 秒只是上限。

再按一次 Ctrl-C（或编排升级信号强度）会跳过等待直接关闭。

### /healthz 与 /readyz 是两件事

| 端点 | 含义 | 退出期间 |
| --- | --- | --- |
| `/healthz` | 存活，进程还在就 200 | **仍是 200** |
| `/readyz` | 就绪，能不能接新请求 | 503 |

别把存活探针接到 `/readyz` 上：优雅退出期间进程是健康的（它正在把在途请求送完），接错了编排会在收尾中途把它重启掉，等于没有优雅退出。

### systemd（非 K8s）

单元文件在 [systemd/](systemd/)，三个服务各一份，`Restart=always` 负责自愈 —— 在这之前进程是 `nohup` 裸跑的，panic 挂掉没人拉。装之前改 `User` 与 `WorkingDirectory`（配置加载器按**工作目录**读 `configs/application.properties`，这一条不能省）。

`TimeoutStopSec` 必须大于 `galaxy.shutdown.timeout_ms + drain_delay_ms`，否则 systemd 会在收尾到一半时补一刀 SIGKILL。各服务的 `stop.sh` 同理，等待时长可用 `GALAXY_STOP_WAIT_SECONDS` 覆盖。

多实例发版用 [systemd/galaxy-drain.sh](systemd/galaxy-drain.sh)：`./galaxy-drain.sh restart hub-1` 会摘出轮转 → 停 → 起 → 放回。注意它摘的是**轮转入口**（`upstream galaxy_hub` 里那台的 server 行），**不动** `/instance/<名>` 那条定向路由——在途单元的 streamURL 指向的就是这台，节点还要回来把字节推完。

单实例部署用不上这个脚本：没有别的机器接管，摘出去就是停服，直接 `systemctl stop` 即可。优雅退出在单实例下**仍然有价值**——它保证的是「正在跑的请求跑完再退出」，只是停机窗口里的新请求没人接。

### K8s

示例在 [k8s/galaxy-hub-api.yaml](k8s/galaxy-hub-api.yaml)：`livenessProbe` 接 `/healthz`、`readinessProbe` 接 `/readyz`、`terminationGracePeriodSeconds` 设到 700。**不需要 preStop sleep**——通常加它是为了等 Endpoints 收敛，而进程自己用 `drain_delay_ms` 做了同一件事，两边都睡只会让每次滚动白等一轮。

Hub 上 K8s 要用 StatefulSet：节点的上行必须回到持有消费者连接的那个 pod，而 Deployment 的 pod 名每次滚动都变，没法稳定寻址。

上多 pod 之前还有两件事没做完：`sweep` / `audit` 两个后台循环每个 pod 各跑一份（缺 leader election，抽检的每日配额在 Redis 里是准的，但重放取样没有原子占用，会重复重放同一批）；export 接入的派单器要求消费者连接就在本 pod 上，多 pod 下过半请求会失败。只用长轮询接入、且能接受巡检重复跑的话，可以先上。

## 从旧聚合服务迁移

1. 准备三份配置及二进制，保留原有数据库、Redis namespace、密钥和业务配置。
2. 启动新的 Hub 与使用端服务；将 Nova 的 `SERVER_TARGET` 指向 galaxy-api，Orbit 和门户的 `SERVER_TARGET` 指向 galaxy-consumer-api。已有 `.env` 需要显式更新，示例文件不会覆盖部署配置。
3. 将 SDK 的 base URL 和 bridge 的 `pool.hubURL` 更新为 Hub 地址；旧 bridge 安装下载链接也改为 Hub。若保留统一外部域名，在现有部署网关按上表将路径直接路由到所属服务。
4. 排空旧聚合进程中的请求，再将 galaxy-api 更新为仅提供端控制台的版本。新 galaxy-api 不再接受 `/v1/*`、`/agent/v1/*` 和使用端路由，旧客户端继续打旧端口会得到 404。
5. 检查三个健康接口，分别验证两端登录、bridge 注册与心跳、真实 SDK 流式调用及支付回调。

代码验证包括三个模块的独立编译、路由隔离测试以及已有 agent、bridge、auth、consumer 和适配器测试。真实数据库、Redis、已登录客户端和支付渠道联调需要在部署环境执行。
