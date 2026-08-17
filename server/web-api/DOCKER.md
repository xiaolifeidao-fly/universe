# web-api Docker 镜像

从仓库任意目录构建本地镜像：

```bash
server/web-api/build-image.sh
```

该脚本等价于在 `server/` 目录执行：

```bash
docker build -f web-api/Dockerfile -t universe-web-api:local .
```

可用首个位置参数指定标签，或通过 `IMAGE_NAME`、`IMAGE_TAG` 指定镜像名和标签。`--platform`、`--no-cache` 等非敏感 `docker build` 参数可以继续传递；脚本拒绝 `--build-arg`，避免运行时秘密写入镜像层。

## 运行

`WEB_API_SQLCONN` 和 `WEB_API_AUTH_TOKEN_SECRET` 为必填运行时秘密。入口脚本在启动时将它们写入仅容器内可读的 `/app/configs/application.properties`，随后以前台 PID 1 方式启动服务：

```bash
docker run --rm -p 10001:10001 \
  -e WEB_API_SQLCONN='user:password@tcp(mysql:3306)/universe?charset=utf8&parseTime=True&loc=Local' \
  -e WEB_API_AUTH_TOKEN_SECRET='replace-with-a-long-random-secret' \
  universe-web-api:local
```

可选变量：

- `WEB_API_AUTH_TOKEN_TTL_SECONDS`：Token 有效期秒数，默认 `604800`，必须为正整数。
- `TZ`：容器时区，默认 `UTC`；镜像包含 `tzdata`，可设为例如 `Asia/Shanghai`。
- `WEB_API_ADDR`：默认 `:10001`。如改变容器内监听端口，必须同步覆盖 Docker `HEALTHCHECK` 并调整端口映射；建议保持容器内 `10001`，仅修改宿主端口映射。

数据库必须已完成迁移并可从容器网络访问。镜像和入口脚本不会执行 SQL 迁移、数据导入或默认管理员初始化；这些是独立部署步骤。服务在数据库连接成功后才会提供 `GET /healthz`。
