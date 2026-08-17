# Docker Compose 部署

本仓库通过根目录的 `compose.yaml` 统一运行 `client/web` 和 `server/web-api`。它使用两个服务的生产镜像：前端仅对宿主机开放，后端仅在 Compose 内部 `application` 网络通过 `web-api:10001` 提供服务。

## 前置条件

- Docker Engine 已启动，且可运行 `docker info`。
- 已安装 Docker Compose v2。
- `client/web/Dockerfile` 与 `server/web-api/Dockerfile` 可在当前仓库构建。
- 准备了容器可访问、已初始化的 MySQL。初始化资料见 `server/SCHEMA.md`、`server/delivery.sql` 和适用的 `server/migrations/` 文件；本编排不会执行 SQL、迁移、创建管理员或管理数据库生命周期。

## 首次部署

```bash
cp .env.example .env
chmod 600 .env
# 编辑 .env：至少填写 WEB_API_SQLCONN 与 WEB_API_AUTH_TOKEN_SECRET
./scripts/docker-stack.sh config
./scripts/docker-stack.sh build
./scripts/docker-stack.sh up
./scripts/docker-stack.sh check
```

`up` 会构建镜像、后台启动服务、等待 `web-api` 健康并检查前端首页及 `/api/healthz`。如果 MySQL 不可达、环境变量缺失或镜像启动失败，命令会以非零状态返回并输出服务状态与最近日志。

`.env` 是唯一的运行环境文件位置，已被 `.gitignore` 忽略。不要提交或在工单、终端共享日志和聊天记录中粘贴其内容。Compose 会把最终 DSN 和令牌秘密传入容器环境，因此拥有 Docker daemon 或 `docker inspect` 访问权限的人员应被视为可读取敏感配置。包含 `$` 的复杂秘密应按 Docker Compose 的 env-file 转义规则处理；在 CI 或部署平台中优先使用受控的 Secret 注入，且不要通过脚本 `eval` 配置文件。

MySQL DSN 中的主机名必须从容器可路由。`127.0.0.1` 指向容器自身，不能代表宿主机；Docker Desktop 本地环境可按实际情况使用 `host.docker.internal`，Linux 和生产环境应使用真实 DNS 名称或路由 IP。

## 日常操作

```bash
./scripts/docker-stack.sh status
./scripts/docker-stack.sh logs -f client-web
./scripts/docker-stack.sh logs web-api
./scripts/docker-stack.sh restart web-api
./scripts/docker-stack.sh down
```

`down` 仅停止本项目的容器并删除其默认网络；不会删除镜像、卷或外部 MySQL，也不会执行 `docker system prune`。使用 `build web-api`、`build client-web` 可单独重建镜像。

修改 `.env` 中的运行时变量后，无需重建相同镜像；执行 `./scripts/docker-stack.sh up` 会重新创建有变更的容器。镜像名称/标签变更或源代码变更时，再运行对应的 `build`。`depends_on` 仅控制首次启动顺序，不能替代运行期故障恢复；后端故障后请用 `status`、`check` 和日志持续观测。

## 端口与网络

- 默认对外地址为 `http://127.0.0.1:7893`，由 `CLIENT_WEB_BIND` 与 `CLIENT_WEB_PORT` 控制。将绑定改为 `0.0.0.0` 会暴露给网络，部署方需自行配置访问控制。
- 后端默认不发布宿主端口，前端通过 Docker DNS `http://web-api:10001` 访问它。
- 如需本机直连后端排障，使用 `./scripts/docker-stack.sh --debug-api up`。该模式加载 `compose.debug.yaml`，默认仅映射 `127.0.0.1:${WEB_API_PORT:-10001}`；完成后以同一选项执行 `down`。
- 当 `CLIENT_WEB_BIND` 不是回环地址且检查机需通过另一个地址访问时，在 `.env` 设置 `CLIENT_WEB_CHECK_HOST`，再运行 `check`。

## 故障排查

| 现象 | 排查方式 |
| --- | --- |
| Docker daemon 未启动 | 启动 Docker Desktop 或 Docker Engine，再运行 `docker info`。 |
| `WEB_API_SQLCONN` 或秘密缺失 | 填写 `.env` 的必填值，再执行 `config`。 |
| `web-api` 为 `unhealthy` | 用 `logs web-api` 检查 DSN、MySQL 网络连通性及数据库是否已初始化。 |
| 前端首页正常但 `/api/healthz` 失败 | 确认 `web-api` 健康，检查前端日志；Compose 会固定传入 `SERVER_TARGET=http://web-api:10001` 和 `APP_URL_PREFIX=/api`。 |
| 端口已被占用 | 修改 `CLIENT_WEB_PORT`，或释放占用 `CLIENT_WEB_BIND:CLIENT_WEB_PORT` 的进程。 |
| 需要查看展开后的配置 | 使用 `./scripts/docker-stack.sh config`；它只运行 `docker compose config --quiet`，避免将已插值秘密输出到共享日志。 |

所有管理命令均可从任意工作目录运行，脚本会定位到仓库根目录并固定 Compose 项目目录和 `.env` 路径。
