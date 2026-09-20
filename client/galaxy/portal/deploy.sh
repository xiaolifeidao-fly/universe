#!/bin/sh
set -eu

# 在**服务器**上换一版 portal：stop → 解包 → start，一条命令。
# 把 tar.gz、unpack-release.sh 和这个脚本放同一个目录，直接跑 ./deploy.sh。
#
# 做的就是手工那三步，顺序一模一样，只是不用自己敲、也不会敲错顺序：
#   sh <包名>/stop.sh
#   sh unpack-release.sh
#   sh <包名>/start.sh
#
# 顺序不能反过来：解包是把整个目录换掉（不是覆盖式解包，理由见 unpack-release.sh），
# run/*.pid 会跟着一起没 —— 先解包的话 stop.sh 之后就找不到进程了，老进程占着端口
# 成了孤儿，新的怎么都起不来。
#
# 想让停机窗口只剩 stop+start（解包挪到服务还活着的时候做，上一版还留一份好回滚）：
#   ./unpack-release.sh --swap
export LC_ALL=C
export LANG=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ARCHIVE="${1:-}"

if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(find "$SCRIPT_DIR" -maxdepth 1 -type f -name 'portal-*.tar.gz' | sort | sed -n '1p')"
fi
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: $0 [archive.tar.gz]" >&2
  echo "把 tar.gz 放进 $SCRIPT_DIR，或者把路径当参数给我。" >&2
  exit 1
fi

if [ ! -f "$SCRIPT_DIR/unpack-release.sh" ]; then
  echo "同一个目录里没有 unpack-release.sh：$SCRIPT_DIR" >&2
  exit 1
fi

# 要停、要起的是哪个目录，从归档清单里读，不写死包名。
#
# 顺手把包验了：tar 的退出码得单独接住，不能写成 `tar | sed` —— 那样拿到的是
# sed 的退出码。半截的包 tar 会把读得到的那部分照常列出来再报错，吞掉退出码
# 就会带着一份「看着很正常」的清单往下走，等于为了一个坏包白停一次服务。
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/galaxy-webview-deploy.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

if ! tar -tzf "$ARCHIVE" >"$TMP_DIR/entries.txt" 2>"$TMP_DIR/tar-error.txt"; then
  echo "归档读不完整（传坏了？）：$ARCHIVE" >&2
  sed -n '1,3p' "$TMP_DIR/tar-error.txt" >&2
  echo "服务没动过，还在跑。" >&2
  exit 1
fi
RELEASE_NAME="$(sed -e 's|^\./||' -e '/^$/d' -e 's|/.*$||' "$TMP_DIR/entries.txt" | sort -u | sed -n '1p')"
if [ -z "$RELEASE_NAME" ]; then
  echo "归档是空的：$ARCHIVE" >&2
  exit 1
fi
RELEASE_DIR="$SCRIPT_DIR/$RELEASE_NAME"

# 是不是首次部署，只能在解包**之前**问：解完之后 runtime.json 一定在
# （没有就从模板生成了），那会儿再问就分不清了。
FIRST_DEPLOY=1
if [ -f "$RELEASE_DIR/runtime.json" ]; then
  FIRST_DEPLOY=0
fi

echo "==> 1/3 停服务"
if [ -f "$RELEASE_DIR/stop.sh" ]; then
  if ! sh "$RELEASE_DIR/stop.sh"; then
    echo "没停下来，什么都没动 —— 解包不能压着活着的进程做。" >&2
    exit 1
  fi
else
  echo "$RELEASE_DIR 还不存在，首次部署，跳过"
fi

echo "==> 2/3 解包"
if ! sh "$SCRIPT_DIR/unpack-release.sh" "$ARCHIVE"; then
  echo "" >&2
  echo "解包失败，服务现在是停着的。" >&2
  echo "unpack-release.sh 会把上一版原样放回去（它是改名不是删），所以要么换个好包" >&2
  echo "重跑 $0，要么确认目录没问题之后直接 $RELEASE_DIR/start.sh 把老版本起回来。" >&2
  exit 1
fi

echo "==> 3/3 起服务"
if [ "$FIRST_DEPLOY" = "1" ]; then
  echo "首次部署不自动起：runtime.json 刚从模板生成，SERVER_TARGET 还是打包机的值。"
  echo "改完再起：$RELEASE_DIR/start.sh"
  exit 0
fi
if ! sh "$RELEASE_DIR/start.sh"; then
  echo "" >&2
  echo "新版本没起来，日志在 $RELEASE_DIR/logs/" >&2
  exit 1
fi
