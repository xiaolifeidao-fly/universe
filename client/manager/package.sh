#!/usr/bin/env bash
set -euo pipefail

# 打包名不用 package.json 里的 name：client/web 的 name 也叫 manager，
# 两个包同名会在部署机上互相覆盖。
APP_NAME="manager-console"
export LC_ALL=C
export LANG=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_NAME="$APP_NAME-linux-x64"
PACKAGE_ROOT="${PACKAGE_ROOT:-$SCRIPT_DIR/package}"
DIST_DIR="$PACKAGE_ROOT/$PACKAGE_NAME"
ARCHIVE="${ARCHIVE:-$SCRIPT_DIR/$PACKAGE_NAME.tar.gz}"

cd "$SCRIPT_DIR"

echo "building $APP_NAME..."
npm run build

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

cp -R .next "$DIST_DIR/.next"
rm -rf "$DIST_DIR/.next/cache"
# next.config.mjs 里开了 output: "standalone"，但这个包按 `next start` 部署
# （见下面生成的 start.sh），.next/standalone 里那份 node_modules 副本只会让
# tar 白白大出二三十兆。
rm -rf "$DIST_DIR/.next/standalone"
[ -d public ] && cp -R public "$DIST_DIR/"

# .env 必须进包：src/pages/api/[...all].ts 是**运行期**读 SERVER_TARGET 转发给后端的，
# 不像 NEXT_PUBLIC_* 那样在构建时就编进产物。少了它前端所有请求都会 502。
for file in package.json package-lock.json next.config.mjs .env .env.production .env.example; do
  [ -f "$file" ] && cp "$file" "$DIST_DIR/"
done

# 包里既没有 scripts/link-shared.js 也没有 client/shared，postinstall 留着会让部署机上
# 的 npm ci 直接失败。那个软链只在源码编译时有用，shared/** 的代码这时已经编进 .next 了。
node -e '
const fs = require("fs");
const file = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
if (pkg.scripts) {
  delete pkg.scripts.postinstall;
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$DIST_DIR/package.json"

cat > "$DIST_DIR/start.sh" <<'EOF'
#!/bin/sh
set -eu

APP_NAME="manager-console"
PORT="${PORT:-7895}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/$APP_NAME.pid"
LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/logs}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/$APP_NAME.log}"

cd "$SCRIPT_DIR"
mkdir -p "$LOG_DIR"

if [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
fi

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "$APP_NAME is already running, pid: $PID"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if command -v lsof >/dev/null 2>&1; then
  PORT_PID="$(lsof -ti ":$PORT" || true)"
  if [ -n "$PORT_PID" ]; then
    echo "port $PORT is already in use by pid: $PORT_PID"
    exit 1
  fi
fi

NEXT_TELEMETRY_DISABLED=1 nohup ./node_modules/.bin/next start -p "$PORT" > "$LOG_FILE" 2>&1 &
PID="$!"
echo "$PID" > "$PID_FILE"

sleep 1
if kill -0 "$PID" 2>/dev/null; then
  echo "$APP_NAME started, pid: $PID, port: $PORT, log: $LOG_FILE"
else
  rm -f "$PID_FILE"
  echo "$APP_NAME failed to start, see log: $LOG_FILE" >&2
  exit 1
fi
EOF

cat > "$DIST_DIR/stop.sh" <<'EOF'
#!/bin/sh
set -eu

APP_NAME="manager-console"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/$APP_NAME.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "$APP_NAME is not running"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "$APP_NAME stopped, pid: $PID"
else
  echo "$APP_NAME pid file exists, but process is not running"
fi

rm -f "$PID_FILE"
EOF

chmod +x "$DIST_DIR/start.sh" "$DIST_DIR/stop.sh"

tar -czf "$ARCHIVE" -C "$PACKAGE_ROOT" "$PACKAGE_NAME"

echo "package created: $ARCHIVE"
