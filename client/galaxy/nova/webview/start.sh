#!/bin/sh
set -eu

# 启动 Nova（共享端）的界面。跑的是 .desktop/nova 里那份 Next standalone ——
# 也就是真正要部署上服务器的东西，本机起它是为了「验的和发的是同一份」。
#
# 同一个文件在两处都能用：解包后的发布目录里，它和 standalone 并排；
# 源码树里，产物在 ../../.desktop/nova。下面先认自己身边的，再回落到源码树。
#
# 写成 POSIX sh 而不是 bash：部署机上顺手一个 `sh start.sh` 就会掉进 dash，
# bash 那套 [[ ]]、set -o pipefail 在那儿会直接报 Illegal option。
APP_NAME="nova-webview"
PRODUCT="nova"
# 和 common/index.js 里 nova 的端口一致：本机验的时候不用多记一个号。
DEFAULT_PORT=17898

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

# 业务代理打哪台 Galaxy API：runtime.json 给默认值，启动环境里的同名变量优先。
read_runtime() {
  [ -f "$RUNTIME_FILE" ] || return 0
  node -e 'const v = require(process.argv[1])[process.argv[2]]; if (v) process.stdout.write(String(v))' "$RUNTIME_FILE" "$1" 2>/dev/null || true
}
if [ -z "${SERVER_TARGET:-}" ]; then
  SERVER_TARGET="$(read_runtime SERVER_TARGET)"
  export SERVER_TARGET
fi
if [ -z "${APP_URL_PREFIX:-}" ]; then
  APP_URL_PREFIX="$(read_runtime APP_URL_PREFIX)"
  export APP_URL_PREFIX
fi
if [ -z "$SERVER_TARGET" ]; then
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
