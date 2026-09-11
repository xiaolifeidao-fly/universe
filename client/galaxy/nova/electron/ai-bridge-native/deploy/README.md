# ai-bridge 独立部署

把一台机器上的 Claude Code / Codex 订阅算力接入 Galaxy 共享池，用命令行、无人值守地跑。

它和 Nova 客户端里内置的 bridge 是**同一份实现**，差别只在入口：

|          | Nova 客户端                  | 独立部署（本文）                     |
|----------|------------------------------|--------------------------------------|
| 适合     | 普通用户，自己的电脑         | 专业用户，服务器 / 常开的机器        |
| 身份     | 一次性配对码（10 分钟有效）  | 长期接入密钥 `gpk-…`                 |
| 接入方式 | 只有 poll                    | poll 或 export                       |
| 运行     | Nova 里点「启动」            | 前台命令，或配成系统服务             |

注册时用的是谁的接入密钥，这台机器就属于谁：别人用它产生的积分记在这个账号上。
两种接入方式的计量、结算、收益完全一样。

## 两种接入方式

**poll（默认）** —— 机器主动向平台领活。只要能访问平台地址就行：不需要公网 IP，不开任何端口。

**export** —— 机器在一个地址上监听，平台主动把活推过来，结果在同一条连接里回去。
需要一个平台访问得到的地址（公网 IP 或域名）和开放的端口；换来的是派单不经过长轮询。

## 快速开始

1. 在这台机器上登录要共享的上游（用哪个登哪个）：

   ```bash
   claude auth login
   codex login
   ```

2. 在控制台「账户 → 接入密钥」签发一把密钥。**明文只显示一次**，当场复制走。

3. 注册：

   ```bash
   # poll
   ai-bridge register --hub https://hub.example.com --key gpk-XXXX

   # export
   ai-bridge register --hub https://hub.example.com --key gpk-XXXX \
     --mode export --public-url https://203.0.113.7:8788 --port 8788
   ```

   不带 `--key` 时会在终端里问你；也可以用环境变量 `AI_BRIDGE_ACCESS_KEY` 传。

4. 运行：`ai-bridge run`

5. 到控制台「共享设置」打开要共享的能力、给上额度。**默认什么都不共享** ——
   「机器上装了」和「我愿意共享」是两件事，中间要你点一下头。

随时可以用 `ai-bridge status` 看本机配置、节点身份和探测到的能力（`--json` 给机器读）。

## 自动重新注册

接入密钥默认写进配置文件（`pool.accessKey`，文件权限 0600）。之后每次 `ai-bridge run`
启动都会先用它重新注册一次 —— 令牌被撤、平台库重建、公网地址换了，重启一次就自己回来了。

几条边界：

- 注册沿用本机上一次的节点身份，控制台上始终是**同一台机器**，不会越重启越多。
- 平台暂时连不上时，沿用本机已有的身份继续启动，平台恢复后自动接上。
- 在控制台**解绑**过的机器不会被自动接回来。确实要重新接入，在那台机器上执行
  `ai-bridge register --fresh`（当作一台新机器注册）。
- 不想把密钥留在机器上：注册时加 `--no-save-key`。代价是 run 时不再自动重新注册。

## export 的网络要求

- 平台会访问 `<publicURL>/node/v1/execute`、`/node/v1/health`、`/node/v1/cancel`，
  每个请求都带回连密钥（`Authorization: Bearer …`）。
- 回连密钥由**本机生成**（默认 `~/.local/state/ai-bridge/export-secret`，权限 0600），
  注册时交给平台。节点的每一条响应都带 `X-Galaxy-Node` 自证头，平台据此确认连到的
  确实是这台机器。
- **建议在前面加一层 TLS**（nginx / Caddy），`--public-url` 写 https 地址、
  `pool.export.host` 改成 `127.0.0.1`。直接暴露明文 HTTP 时，回连密钥会以明文在网络上传输。
- 控制台机器列表会显示回连状态：
  - 「回连失败 — 连不上 …」：多半是防火墙或端口映射；
  - 「这个地址后面不是本机节点」：publicURL 指向了别的服务或别的机器；
  - 「回连密钥被节点拒绝」：在那台机器上重新 register 一次。
- 本机校验不通过（没填 publicURL、填成 0.0.0.0 或链路本地地址）时自动回落成 poll，
  日志里有 `pool_export_fallback`。平台不接受回连信息时同样回落，日志是 `pool_export_downgraded`。
- 平台目前只支持**单实例** Hub 下的 export 回连。

## 长期运行

模板都在 `deploy/` 下。三个平台有一个共同点：**必须用登录过 claude / codex 的那个用户跑** ——
订阅登录态在他的家目录（macOS 上是他的钥匙串）里。

### Linux（systemd）

```bash
sudo install -m 0755 ai-bridge /usr/local/bin/ai-bridge
sudo cp deploy/linux/ai-bridge@.service /etc/systemd/system/
sudo systemctl enable --now ai-bridge@alice      # alice 换成那个用户
journalctl -u ai-bridge@alice -f
```

用 zig 交叉编译的包按 glibc 2.17 链接，CentOS 7、Ubuntu 18.04 这类老系统也能跑；CI 在 Ubuntu 22.04 上编的包要求 glibc ≥ 2.35。

### macOS（launchd）

```bash
sudo install -m 0755 ai-bridge /usr/local/bin/ai-bridge
cp deploy/macos/com.galaxy.ai-bridge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.galaxy.ai-bridge.plist
tail -f /tmp/ai-bridge.log
```

用 LaunchAgent 而不是 LaunchDaemon：Claude 的登录态在用户钥匙串里，只有用户会话读得到。

### Windows（计划任务）

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1 -Exe C:\ai-bridge\ai-bridge.exe
```

用计划任务而不是 Windows 服务，原因写在脚本开头。

## 停机

`Ctrl+C` / `SIGTERM` 会走完整的停机：在跑的请求报给平台，平台立刻改派给别的机器，
使用者那边无感。直接 `kill -9` 的话，他们要干等一个超时。

## 配置文件

默认 `~/.config/ai-bridge/config.yaml`，`--config` 或环境变量 `AI_BRIDGE_CONFIG` 可以换。
`ai-bridge init` 生成的模板里每一段都有注释。共享池那两段由 `register` 写入：

```yaml
mode: pool
pool:
  hubURL: https://hub.example.com
  accessKey: gpk-XXXX
  accessMode: export          # 或 poll
  export:
    host: 0.0.0.0
    port: 8788
    publicURL: https://203.0.113.7:8788
```

改完重启 `ai-bridge run` 生效。共享多少、共享哪几种、什么时段共享，不在这个文件里 ——
那些在控制台上定，平台下发，随时能改。
