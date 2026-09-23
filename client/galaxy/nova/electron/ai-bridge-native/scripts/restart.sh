#!/bin/sh
# 重启 ai-bridge：先停掉旧进程，再在后台启动。用法：sh /data/app/ai-bridge/restart.sh
set -u
BIN=/usr/local/bin/ai-bridge
LOG="$(cd "$(dirname "$0")" && pwd)/ai-bridge.log"

# 当前用户下起不来，就别动正在跑的那个（配置和节点身份在执行脚本的这个用户家目录里）
STATUS=$("$BIN" status --json 2>&1)
if ! printf '%s\n' "$STATUS" | grep -q '"joined": true' ||
   ! printf '%s\n' "$STATUS" | grep -qE '"(registered|accessKeySaved)": true'; then
  echo "用户 $(whoami) 下没有注册过的配置，没动旧进程。ai-bridge status 的输出："
  printf '%s\n' "$STATUS"
  echo "正在跑的 ai-bridge（用户 pid 命令）："
  ps -C ai-bridge -o user=,pid=,args=
  exit 1
fi

# 停旧进程：先发 TERM，让它把在跑的活报给平台改派；30 秒还没退再强杀
if pgrep -x ai-bridge >/dev/null; then
  echo "停止旧进程：$(pgrep -d ' ' -x ai-bridge)"
  pkill -TERM -x ai-bridge
  for _ in $(seq 30); do pgrep -x ai-bridge >/dev/null || break; sleep 1; done
  if pgrep -x ai-bridge >/dev/null; then echo "30 秒没退出，强杀"; pkill -KILL -x ai-bridge; sleep 1; fi
fi

# 后台启动，断开 SSH 也不会停
echo "==== $(date '+%F %T') restart ====" >>"$LOG"
nohup "$BIN" run >>"$LOG" 2>&1 &
PID=$!
echo "已启动 pid=$PID，日志：$LOG"
sleep 5
tail -n 20 "$LOG"
if ! kill -0 "$PID" 2>/dev/null; then echo "进程已经退出了，原因看上面的日志"; exit 1; fi
