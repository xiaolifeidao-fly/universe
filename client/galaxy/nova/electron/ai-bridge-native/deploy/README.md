# ai-bridge 独立部署

把一台机器上的 Claude Code / Codex 订阅算力接入 Galaxy 共享池，用命令行、无人值守地跑。

它和 Nova 客户端里内置的 bridge 是**同一份实现**，差别只在入口：

|          | Nova 客户端                  | 独立部署（本文）                          |
|----------|------------------------------|-------------------------------------------|
| 适合     | 普通用户，自己的电脑         | 专业用户，服务器 / 常开的机器             |
| 身份     | 一次性配对码（10 分钟有效）  | 长期接入密钥 `gpk-…`                      |
| 接入方式 | 只有 poll                    | poll 或 export                            |
| 运行     | Nova 里点「启动」            | 前台命令，或配成系统服务                  |
| 升级     | 随 Nova 应用更新             | 控制台里点「升级」，或 `ai-bridge upgrade` |

注册时用的是谁的接入密钥，这台机器就属于谁：别人用它产生的积分记在这个账号上。
两种接入方式的计量、结算、收益完全一样。

## 两种接入方式

**poll（默认）** —— 机器主动向平台领活。只要能访问平台地址就行：不需要公网 IP，不开任何端口。

**export** —— 机器在一个地址上监听，平台主动把活推过来，结果在同一条连接里回去。
需要一个平台访问得到的地址（公网 IP 或域名）和开放的端口；换来的是派单不经过长轮询。

## 安装

下面的 `https://hub.example.com` 换成你的平台地址（控制台「账户 → 接入密钥」里给出）。

### Linux / macOS：一行安装

```bash
curl -fsSL https://hub.example.com/agent/v1/bridge/install.sh | sh
```

装完顺手注册（`--name`、`--dir`、`--user` 都可以不给）：

```bash
curl -fsSL https://hub.example.com/agent/v1/bridge/install.sh | sh -s -- --key gpk-XXXX [--name 机器名] [--dir 目录] [--user 用户]
```

按 export 接入的，把接入参数一起给（见「两种接入方式」）：

```bash
curl -fsSL https://hub.example.com/agent/v1/bridge/install.sh | sh -s -- --key gpk-XXXX \
    --mode export --public-url http://203.0.113.7:8788 [--host 0.0.0.0] [--port 8788]
```

- 装到哪：root 执行时是 `/opt/ai-bridge/ai-bridge`，并建软链 `/usr/local/bin/ai-bridge`；
  普通用户执行时是 `~/.local/share/ai-bridge/ai-bridge`，软链 `~/.local/bin/ai-bridge`。
  部署说明和服务模板在安装目录的 `deploy/` 下。
- `--user <用户>`（root 执行时）：把安装目录交给这个用户。**服务以这个用户运行，就必须带它** ——
  否则远程升级换不了文件，见下面「远程升级的前提」。
- `--key`：装完执行 `ai-bridge register --hub <平台地址> --key <密钥>`；root 加 `--user` 时以那个用户执行。
- `--mode` / `--public-url` / `--host` / `--port`：脚本不解释它们，原样转交给上面那条 register。
  `--mode export` 没给 `--public-url` 时，脚本在下载之前就拒掉。
- 脚本用 `<平台地址>/agent/v1/bridge/checksum/<平台>` 校验下载的包。
- **重复执行就是原地升级**，配置和节点身份都不动。

### Windows：一行安装

```powershell
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://hub.example.com/agent/v1/bridge/install.ps1))) -Key gpk-XXXX"
```

装到 `%LOCALAPPDATA%\ai-bridge\ai-bridge.exe`（当前用户可写，远程升级才换得了文件），并把这个目录加进用户 PATH。
参数：`-Key`、`-Name`、`-Dir`，以及接入方式那一组 `-Mode`、`-PublicUrl`、`-BindHost`、`-Port`
（监听地址那个参数叫 `-BindHost` 不叫 `-Host`：`$Host` 在 PowerShell 里是只读的自动变量）。
配成开机自启见下面「长期运行 → Windows」。

### 手动安装

平台上的包按平台名区分：`linux-x64` `linux-arm64` `darwin-arm64` `darwin-x64` `windows-x64` `windows-arm64`。

```bash
PLATFORM=linux-x64
curl -fL -o ai-bridge.tar.gz https://hub.example.com/agent/v1/bridge/download/$PLATFORM
# checksum 端点返回 sha256sum 格式（<sha256>  <文件名>），取前一段对本地文件校验。macOS 上把 sha256sum 换成 shasum -a 256
EXPECTED=$(curl -fsSL https://hub.example.com/agent/v1/bridge/checksum/$PLATFORM | cut -d' ' -f1)
echo "$EXPECTED  ai-bridge.tar.gz" | sha256sum -c -

tar -xzf ai-bridge.tar.gz                                   # 解出 ai-bridge-<版本>-<平台>/
sudo mkdir -p /opt/ai-bridge
sudo cp -R ai-bridge-*-$PLATFORM/. /opt/ai-bridge/          # 可执行文件 + deploy/ + README.md
sudo ln -sf /opt/ai-bridge/ai-bridge /usr/local/bin/ai-bridge
sudo chown -R alice /opt/ai-bridge                          # alice 换成要运行服务的那个用户
```

`download` 地址是稳定的（平台 302 到对象存储），可以写进自己的脚本；要装指定版本加 `?version=0.2.0`。
Windows 的包是 `.zip`。

## 快速开始

1. 在这台机器上登录要共享的上游（用哪个登哪个）：

   ```bash
   claude auth login
   codex login
   ```

2. 在控制台「账户 → 接入密钥」签发一把密钥。**明文只显示一次**，当场复制走。

3. 安装（见上一节），注册：

   ```bash
   # poll
   ai-bridge register --hub https://hub.example.com --key gpk-XXXX

   # export
   ai-bridge register --hub https://hub.example.com --key gpk-XXXX \
     --mode export --public-url http://203.0.113.7:8788 --port 8788
   ```

   `--public-url` 写的是**平台访问你的地址**，协议按那个地址上实际跑的填：直接暴露
   ai-bridge 自己的端口就是 `http`，前面架了 TLS 反代才是 `https`（见「export 的网络要求」）。

   不带 `--key` 时会在终端里问你；也可以用环境变量 `AI_BRIDGE_ACCESS_KEY` 传。
   一行安装时带了 `--key` 的，这一步已经做过了。

4. 运行：`ai-bridge run`

5. 到控制台「共享设置」打开要共享的能力、给上额度。**默认什么都不共享** ——
   「机器上装了」和「我愿意共享」是两件事，中间要你点一下头。

随时可以用 `ai-bridge status` 看本机配置、节点身份、探测到的能力，以及这台机器能不能远程升级
（`--json` 给机器读）。

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

模板都在 `deploy/` 下（一行安装的在安装目录的 `deploy/` 里）。三个平台有一个共同点：
**必须用登录过 claude / codex 的那个用户跑** —— 订阅登录态在他的家目录（macOS 上是他的钥匙串）里。

### Linux（systemd）

```bash
# 一行安装时用 root 加 --user alice，装好之后：
sudo cp /opt/ai-bridge/deploy/linux/ai-bridge@.service /etc/systemd/system/
sudo systemctl enable --now ai-bridge@alice      # alice 换成那个用户
journalctl -u ai-bridge@alice -f
```

模板里的 `ExecStart=/usr/local/bin/ai-bridge run` 走的是软链，真正的文件在 `/opt/ai-bridge`，
那个目录属于 alice —— 远程升级换的是它，`/usr/local/bin` 一个字节都不用动。

用 zig 交叉编译的包按 glibc 2.17 链接，CentOS 7、Ubuntu 18.04 这类老系统也能跑；CI 在 Ubuntu 22.04 上编的包要求 glibc ≥ 2.35。

### macOS（launchd）

```bash
# 用自己（登录 claude 的那个用户）执行一行安装，不要 sudo：装到 ~/.local/share/ai-bridge
cp ~/.local/share/ai-bridge/deploy/macos/com.galaxy.ai-bridge.plist ~/Library/LaunchAgents/
# 模板里写的是 /usr/local/bin/ai-bridge，改成实际的路径（launchd 不认 ~，要写绝对路径）：
sed -i '' "s#/usr/local/bin/ai-bridge#$HOME/.local/bin/ai-bridge#" ~/Library/LaunchAgents/com.galaxy.ai-bridge.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.galaxy.ai-bridge.plist
tail -f /tmp/ai-bridge.log
```

用 LaunchAgent 而不是 LaunchDaemon：Claude 的登录态在用户钥匙串里，只有用户会话读得到。
用 sudo 装到了 `/opt/ai-bridge` 的，要带 `--user <你的用户名>`，模板里的路径就不用改。

### Windows（计划任务）

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\ai-bridge\deploy\windows\install-task.ps1" -Exe "$env:LOCALAPPDATA\ai-bridge\ai-bridge.exe"
```

用计划任务而不是 Windows 服务，原因写在脚本开头。

## 升级

### 远程升级的前提：安装目录对运行服务的用户可写

升级要把正在用的可执行文件换掉：在它**所在的目录**里放进新文件、把旧的改名成 `ai-bridge.old`。
所以那个目录必须对**运行 ai-bridge 的用户**可写 —— 不是对你，也不是对 root。
不满足时控制台上的「升级」按钮不亮，并显示原因；`ai-bridge status` 的「远程升级」一行也会说。
检查时用服务的那个用户执行：

```bash
sudo -u alice ai-bridge status     # 「远程升级  可以」才行
```

推荐的布局就是一行安装给的那个：

| 服务怎么跑 | 可执行文件 | 目录属于 |
|---|---|---|
| systemd `User=alice` | `/opt/ai-bridge/ai-bridge`，软链 `/usr/local/bin/ai-bridge` | alice（安装脚本 `--user alice`） |
| launchd LaunchAgent | `~/.local/share/ai-bridge/ai-bridge`，软链 `~/.local/bin/ai-bridge` | 你自己 |
| Windows 计划任务 | `%LOCALAPPDATA%\ai-bridge\ai-bridge.exe` | 你自己 |

软链没关系：节点启动时就把软链解开，换的是链接指向的那个文件。

**之前按老文档 `sudo install … /usr/local/bin/ai-bridge` 装的**，文件属于 root，远程升级换不了。
别去 `chown /usr/local/bin` —— 那个目录里还有别的程序，交给服务用户等于让它能替换它们。
把 ai-bridge 挪到自己的目录里：

```bash
sudo mkdir -p /opt/ai-bridge
sudo mv /usr/local/bin/ai-bridge /opt/ai-bridge/ai-bridge
sudo ln -s /opt/ai-bridge/ai-bridge /usr/local/bin/ai-bridge
sudo chown -R alice /opt/ai-bridge
sudo systemctl restart ai-bridge@alice
```

或者直接用一行安装加 `--user alice` 重装一次（配置和节点身份都在 alice 的家目录里，不受影响）。

### 在控制台远程升级

机器列表里有新版本时会显示「升级」。点下去之后，节点在下一次心跳（默认 15 秒内）收到指令：

1. **先验发布签名**，再下载：包的版本、平台、sha256 都在签名里，签名用的是离线保管的发布私钥，
   节点只认编进自己的那几把公钥。平台下发的地址和校验值不单独可信。
2. 下载（上限 256 MB）→ 比对 sha256 → 用系统的 `tar` 解包 → **在本机试跑一次** `ai-bridge version`。
   新包在这台机器上跑不起来（架构、glibc、系统拦截），就停在这一步，旧文件原封不动。
3. 替换：新文件换进去，旧的留在 `ai-bridge.old`；换失败会自动还原。
4. **排空**：不再领新活（控制台上通道显示暂停），等在跑的单元跑完，**最多 120 秒**；
   到点还没跑完的，按节点下线报给平台，平台立刻改派给别的机器。
5. **原地重启**：Linux / macOS 上 exec 新文件，参数不变、PID 不变，systemd / launchd 看到的
   还是同一个进程；Windows 上先起新进程再退出（计划任务里会显示这个任务已结束，但节点在跑；
   要停它用 `Stop-Process -Name ai-bridge`）。
6. 新版本 hello 上来，控制台显示升级成功。

控制台上会依次看到「正在下载 → 正在安装 → 正在重启」。任何一步失败都会显示原因（签名不对、
sha256 对不上、试跑不过、目录不可写……），临时文件清理干净，**节点照常干活**，修好之后再点一次就行。

### 手动升级：`ai-bridge upgrade`

```bash
ai-bridge upgrade --check      # 只看有没有新版本
ai-bridge upgrade              # 下载、验签、验 sha256、试跑、替换
sudo -u alice ai-bridge upgrade --hub https://hub.example.com   # 用服务用户执行；没有配置文件时用 --hub 指定平台
```

它和远程升级走同一套校验，但**不重启**正在运行的服务 —— 它不知道服务是怎么托管的，也不该替你
决定什么时候打断在跑的单元。换完按提示重启：

```bash
sudo systemctl restart ai-bridge@alice                              # systemd
launchctl kickstart -k gui/$(id -u)/com.galaxy.ai-bridge            # launchd
```

或者去控制台点一次「升级」：那条路会等在跑的单元结束，再自己原地重启。

### 退回上一个版本

上一个版本就在旁边：

```bash
mv /opt/ai-bridge/ai-bridge.old /opt/ai-bridge/ai-bridge
sudo systemctl restart ai-bridge@alice
```

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

## 发布与签名（给发版的人）

节点只安装用发布私钥签过名的包，管理后台也只收验得过签名的包。私钥**离线保管**，不进仓库、不上服务器。

1. **生成一次钥匙**（已经有了就跳过）：

   ```bash
   node scripts/release-sign.cjs keygen      # 默认写到 ~/.config/ai-bridge-release/release-signing-key.pem（0600）
   ```

   它打印的公钥加到两处，缺一处都不行：
   - `ai-bridge-native/release-keys.txt` 加一行 —— 编进节点，节点靠它验包；
   - manager-api 配置 `galaxy.bridge_release.public_keys`（多把用逗号分隔）—— 管理后台上传时靠它验包。

   `release-keys.txt` 里一把公钥都没有的构建，不能远程升级（节点在 hello 里报原因）。

2. **出包并签名**（每个平台一个包）：

   ```bash
   # 一条命令出一版：抬版本号、重编 .node、出各平台包、签名、写 SHA256SUMS。
   sh scripts/release.sh                       # 默认：抬 patch、出 linux-x64（zig）
   node scripts/release.cjs --bump patch --target <triple> [--zig]

   # 只出包、不动版本号：
   node scripts/build-cli.cjs [--target <triple>] [--zig]
   # 产出 ai-bridge-<版本>-<平台>.tar.gz（Windows 是 .zip）和同名的 .sig
   # 私钥不在 ~/.config/ai-bridge-release/release-signing-key.pem 时，用 AI_BRIDGE_RELEASE_KEY 指路径

   # 在 CI 上出的包拿回来再签：
   node scripts/release-sign.cjs sign --key <私钥> ai-bridge-0.2.0-linux-x64.tar.gz ai-bridge-0.2.0-windows-x64.zip
   node scripts/release-sign.cjs verify ai-bridge-0.2.0-*.tar.gz ai-bridge-0.2.0-*.zip   # 用 release-keys.txt 验一遍
   ```

   版本和平台从文件名里读，**别改包名**：签名覆盖的就是「哪个版本、哪个平台、哪个 sha256」。

3. **上传**：在管理后台上传安装包，连同它的签名（`.sig` 文件里那一行 base64）。后台会先用
   `galaxy.bridge_release.public_keys` 验一遍，验不过不收。同一个版本 + 平台已经发布过时要先下架再传。
   发布之后，控制台上对应平台、版本更旧的独立部署机器就会显示「升级」。

换钥匙的步骤写在 `release-keys.txt` 开头：新旧两把并存发一版，等机器都升上来再删旧的。
