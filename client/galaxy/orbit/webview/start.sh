#!/bin/sh
set -eu

# 启动 Orbit（使用端）的界面。跑的是 .desktop/orbit 里那份 Next standalone ——
# 也就是真正要部署上服务器的东西，本机起它是为了「验的和发的是同一份」。
#
# 同一个文件在两处都能用：解包后的发布目录里，它和 standalone 并排；
# 源码树里，产物在 ../../.desktop/orbit。下面先认自己身边的，再回落到源码树。
#
# 写成 POSIX sh 而不是 bash：部署机上顺手一个 `sh start.sh` 就会掉进 dash，
# bash 那套 [[ ]]、set -o pipefail 在那儿会直接报 Illegal option。
APP_NAME="orbit-webview"
PRODUCT="orbit"
# 和 common/index.js 里 orbit 的端口一致：本机验的时候不用多记一个号。
DEFAULT_PORT=17899

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_DIR="$SCRIPT_DIR"
if [ ! -f "$BUNDLE_DIR/webview/server.js" ]; then
  BUNDLE_DIR="$SCRIPT_DIR/../../.desktop/$PRODUCT"
fi
if [ ! -f "$BUNDLE_DIR/webview/server.js" ]; then
  echo "没有构建产物：先跑 $SCRIPT_DIR/build.sh" >&2
  exit 1
fi
BUNDLE_DIR="$(cd "$BUNDLE_DIR" && pwd)"
APP_ROOT="$BUNDLE_DIR/webview"
RUNTIME_FILE="$BUNDLE_DIR/runtime.json"

# 依赖是随包发的，不是装出来的。少了就说明这个目录不是一次干净的解包 ——
# 最常见的原因是有人在包里跑过 npm install：那份清单里没写 next（它是 Next
# 自己追踪进来的），npm 就把它当多余的裁掉了，然后 server.js 说找不到 next。
if [ ! -d "$BUNDLE_DIR/node_modules/next" ]; then
  echo "$BUNDLE_DIR/node_modules 里没有 next，这个目录不是一次干净的解包。" >&2
  echo "在包里跑过 npm install 的话，删掉整个目录用 unpack-release.sh 重新解一次；" >&2
  echo "依赖随包发好，部署机上不需要装任何东西。" >&2
  exit 1
fi

PID_FILE="$SCRIPT_DIR/run/$APP_NAME.pid"
LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/logs}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/$APP_NAME.log}"
PORT="${PORT:-$DEFAULT_PORT}"
# 监听地址不叫 HOSTNAME：bash 自己就有一个同名变量（机器名），被它顶掉
# 会变成「绑不上」。这里用自己的名字，最后一步再翻译成 Next 认的 HOSTNAME。
LISTEN_HOST="${WEBVIEW_HOST:-127.0.0.1}"
PROBE_HOST="$LISTEN_HOST"
if [ "$PROBE_HOST" = "0.0.0.0" ]; then PROBE_HOST="127.0.0.1"; fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "$APP_NAME is already running (pid $(cat "$PID_FILE"))"
  exit 0
fi

# 没有 lsof 的机器就跳过这步：端口真被占，下面的 node 会自己报 EADDRINUSE。
if command -v lsof >/dev/null 2>&1; then
  holder="$(lsof -ti "TCP:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$holder" ]; then
    echo "Port $PORT is already in use by pid(s) $holder; $APP_NAME was not started."
    echo "开发态的 next dev 占的也是这个端口，确认那不是你要的那个再 kill $holder"
    exit 1
  fi
fi

# runtime.json 里的每一项都当环境变量交给进程，**启动环境里已有的同名变量优先**。
# 逐个键名往下发，而不是这里写死一张表 —— 以后加一项只改 runtime.json，不用动这个脚本
# （门户的 start.sh 早就是这么做的，这里跟它对齐）。
#
# 这个端认的是：
#   SERVER_TARGET           业务代理打哪台 Galaxy API
#   APP_URL_PREFIX          代理前缀，默认 /api
#   GALAXY_UPDATE_FEED_URL  桌面壳去哪儿取更新清单（OSS 上那个公开读的目录前缀，
#                           两个端共用；/api/desktop-health 会补上自己那一段再回给壳）。
#                           不配就是这个部署的桌面端不检查更新。
if [ -f "$RUNTIME_FILE" ]; then
  runtime_exports="$(node -e 'const fs = require("node:fs");
const Q = String.fromCharCode(39);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
for (const [key, value] of Object.entries(cfg)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;   // 不是合法变量名，跳过
  if (process.env[key]) continue;                        // 启动环境里给了的优先
  const text = value == null ? "" : String(value);
  process.stdout.write("export " + key + "=" + Q + text.split(Q).join(Q + "\\" + Q + Q) + Q + "\n");
}' "$RUNTIME_FILE" 2>/dev/null || true)"
  eval "$runtime_exports"
fi
if [ -z "${SERVER_TARGET:-}" ]; then
  echo "没有 SERVER_TARGET：页面能开，业务接口会 502。写进 $RUNTIME_FILE 或用环境变量给。" >&2
fi

mkdir -p "$SCRIPT_DIR/run" "$LOG_DIR"
cd "$APP_ROOT"
nohup env HOSTNAME="$LISTEN_HOST" PORT="$PORT" NEXT_TELEMETRY_DISABLED=1 node server.js >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

# 探的是 <basePath>/api/desktop-health：它只回这份包是哪个端，不打后端 ——
# 后端没起的时候也应该能判断「界面自己活了」。控制台不挂在根上（门户占着根，
# 见 common/index.js 的 basePath），根路径探过去只会拿到 404。
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS "http://$PROBE_HOST:$PORT/$PRODUCT/api/desktop-health" 2>/dev/null | grep -q "\"$PRODUCT\""; then
    echo "$APP_NAME started on $LISTEN_HOST:$PORT/$PRODUCT (pid $(cat "$PID_FILE"))"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "$APP_NAME did not become ready; inspect $LOG_FILE" >&2
exit 1
