#!/bin/sh
set -eu

APP_NAME="orbit-webview"
DEFAULT_PORT=17899

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/run/$APP_NAME.pid"
PORT="${PORT:-$DEFAULT_PORT}"

if [ ! -f "$PID_FILE" ]; then
  echo "$APP_NAME is not managed by this script (no $PID_FILE)."
  # 常见情况：跑的是 next dev，或者有人手工 node server.js 起的。
  # 这里不擅自 kill 一个不认识的进程，只把占端口的 pid 报出来 ——
  # 否则下一次 start.sh 只会说「端口被占」，谁占的还得再查一遍。
  if command -v lsof >/dev/null 2>&1; then
    holder="$(lsof -ti "TCP:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$holder" ]; then
      echo "Port $PORT is held by pid(s): $holder"
      echo "If that is your $APP_NAME, stop it with: kill $holder"
    fi
  fi
  exit 0
fi

pid="$(cat "$PID_FILE")"
# SIGTERM 之后等多久。Next 收到信号会先停止接新请求、等在途的跑完再退。
# 控制台没有长连接，在途请求都是秒级的，等一分钟绰绰有余。
wait_seconds="${GALAXY_STOP_WAIT_SECONDS:-60}"

if kill -0 "$pid" 2>/dev/null; then
  kill "$pid"
  echo "sent SIGTERM to $APP_NAME (pid $pid); waiting up to ${wait_seconds}s for in-flight requests"
  i=0
  while [ "$i" -lt "$wait_seconds" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
fi

if kill -0 "$pid" 2>/dev/null; then
  echo "$APP_NAME did not stop cleanly (pid $pid); escalate with: kill -9 $pid"
  exit 1
fi

rm -f "$PID_FILE"
echo "$APP_NAME stopped"
