#!/bin/sh
set -eu

# 在**服务器**上解包 portal 的发布包。把 tar.gz 和这个脚本放同一个目录，
# 直接跑 ./unpack-release.sh 就行。
export LC_ALL=C
export LANG=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
  echo "Usage: $0 [archive.tar.gz] [deploy_parent_dir]" >&2
  echo "Example: $0" >&2
  echo "Example: $0 portal-linux-x64.tar.gz $SCRIPT_DIR" >&2
}

ARCHIVE="${1:-}"
DEPLOY_PARENT_DIR="${2:-$SCRIPT_DIR}"

if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(find "$SCRIPT_DIR" -maxdepth 1 -type f -name 'portal-*.tar.gz' | sort | sed -n '1p')"
  if [ -z "$ARCHIVE" ]; then
    usage
    exit 1
  fi
fi

if [ ! -f "$ARCHIVE" ]; then
  echo "archive not found: $ARCHIVE" >&2
  exit 1
fi

case "$ARCHIVE" in
  *.tar.gz|*.tgz) ;;
  *)
    echo "unsupported archive type, expected .tar.gz or .tgz: $ARCHIVE" >&2
    exit 1
    ;;
esac

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/galaxy-webview-release.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$DEPLOY_PARENT_DIR"

tar -xzf "$ARCHIVE" -C "$TMP_DIR"

ROOT_COUNT="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [ "$ROOT_COUNT" != "1" ]; then
  echo "archive must contain exactly one top-level directory" >&2
  exit 1
fi

SRC_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | sed -n '1p')"
RELEASE_NAME="$(basename "$SRC_DIR")"
case "$RELEASE_NAME" in
  ''|.|..|/*|*/*)
    echo "refusing to deploy a suspicious release name: $RELEASE_NAME" >&2
    exit 1
    ;;
esac
RELEASE_DIR="$DEPLOY_PARENT_DIR/$RELEASE_NAME"

# 整个目录换掉，不做覆盖式解包。
#
# tar 只会写包里有的文件，上一次留下的多余文件它一个都不删 —— 踩过的那次是
# 有人在包里跑了 npm install，npm 按清单把「多余的」依赖裁了（包括 next，
# 它是 Next 自己追踪进来的、清单里没写），再解一次也回不来，最后表现成
# server.js 报 Cannot find module 'next'，看上去像包坏了。
#
# 只有两样是这台机器自己的，接过来：runtime.json（本机配置）和 logs/。
KEEP_DIR=""
if [ -d "$RELEASE_DIR" ]; then
  # 还在跑就别拆。run/*.pid 一起被删掉的话，老进程就成了没人管的孤儿，
  # 还占着端口，新的怎么都起不来。
  for pid_file in "$RELEASE_DIR"/run/*.pid; do
    [ -f "$pid_file" ] || continue
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$RELEASE_DIR 里的服务还在跑（pid $pid）。先 $RELEASE_DIR/stop.sh 再解包。" >&2
      exit 1
    fi
  done
  KEEP_DIR="$TMP_DIR/keep"
  mkdir -p "$KEEP_DIR"
  if [ -f "$RELEASE_DIR/runtime.json" ]; then
    cp "$RELEASE_DIR/runtime.json" "$KEEP_DIR/runtime.json"
  fi
  if [ -d "$RELEASE_DIR/logs" ]; then
    cp -R "$RELEASE_DIR/logs" "$KEEP_DIR/logs"
  fi
  rm -rf "$RELEASE_DIR"
fi

tar -xzf "$ARCHIVE" -C "$DEPLOY_PARENT_DIR"

if [ -n "$KEEP_DIR" ] && [ -f "$KEEP_DIR/runtime.json" ]; then
  cp "$KEEP_DIR/runtime.json" "$RELEASE_DIR/runtime.json"
fi
if [ -n "$KEEP_DIR" ] && [ -d "$KEEP_DIR/logs" ]; then
  cp -R "$KEEP_DIR/logs" "$RELEASE_DIR/logs"
fi

for name in start.sh stop.sh; do
  if [ -f "$RELEASE_DIR/$name" ]; then
    chmod +x "$RELEASE_DIR/$name"
  fi
done

echo "release unpacked: $ARCHIVE -> $RELEASE_DIR"
# 踩过一次：包根原先带着工作区的 package.json，看见它就会想 npm install，
# 结果 postinstall 找不到 scripts/ 直接崩，还把随包发的依赖裁了。
echo "依赖已经随包发好，不要在这个目录跑 npm install —— 解包完直接 ./start.sh"

if [ ! -f "$RELEASE_DIR/runtime.json" ]; then
  cp "$RELEASE_DIR/runtime.example.json" "$RELEASE_DIR/runtime.json"
  echo "首次部署：已从 runtime.example.json 生成 runtime.json"
  echo "启动前确认里面的 SERVER_TARGET 指向这台机器要打的 Galaxy API：$RELEASE_DIR/runtime.json"
fi
