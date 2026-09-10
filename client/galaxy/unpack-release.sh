#!/bin/sh
set -eu

export LC_ALL=C
export LANG=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
  echo "Usage: $0 [archive.tar.gz] [deploy_parent_dir]" >&2
  echo "Example: $0" >&2
  echo "Example: $0 galaxy-console-linux-x64.tar.gz $SCRIPT_DIR" >&2
}

ARCHIVE="${1:-}"
DEPLOY_PARENT_DIR="${2:-$SCRIPT_DIR}"

if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(find "$SCRIPT_DIR" -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.tgz' \) | sort | sed -n '1p')"
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

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/universe-release.XXXXXX")"
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
RELEASE_DIR="$DEPLOY_PARENT_DIR/$RELEASE_NAME"

tar -xzf "$ARCHIVE" -C "$DEPLOY_PARENT_DIR"

# tar 本来就带权限位，这里是兜底：有些 sftp/网盘中转会把可执行位抹掉。
for name in start.sh stop.sh; do
  if [ -f "$RELEASE_DIR/$name" ]; then
    chmod +x "$RELEASE_DIR/$name"
  fi
done

echo "release unpacked: $ARCHIVE -> $RELEASE_DIR"

# 包里刻意不带 .env，免得覆盖服务器上的那份。但首次部署就没人给它建，
# 运行期读不到 SERVER_TARGET，页面能开、请求全 502，很难一眼看出是缺配置。
if [ ! -f "$RELEASE_DIR/.env" ]; then
  echo ""
  echo "缺少配置：$RELEASE_DIR/.env（包里不带，避免覆盖线上配置）"
  echo "首次部署请从模板复制后按需修改："
  echo "  cp $RELEASE_DIR/.env.example $RELEASE_DIR/.env"
fi
