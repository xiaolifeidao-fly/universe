#!/usr/bin/env bash
set -euo pipefail

APP_NAME="galaxy-api"
TARGET_OS="${TARGET_OS:-linux}"
TARGET_ARCH="${TARGET_ARCH:-amd64}"
export LC_ALL=C
export LANG=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_NAME="$APP_NAME-$TARGET_OS-$TARGET_ARCH"
PACKAGE_ROOT="${PACKAGE_ROOT:-$SCRIPT_DIR/package}"
DIST_DIR="$PACKAGE_ROOT/$PACKAGE_NAME"
ARCHIVE="${ARCHIVE:-$SCRIPT_DIR/$PACKAGE_NAME.tar.gz}"

cd "$SCRIPT_DIR"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/bin"

# GOWORK=off 和 build.sh 一致：go.work 会把整个仓库的模块拉进来，发布只编这一个模块，
# 依赖走 go.mod 里的 replace（../common、../contract、../service）。
echo "building $APP_NAME for $TARGET_OS/$TARGET_ARCH..."
GOWORK=off GOOS="$TARGET_OS" GOARCH="$TARGET_ARCH" CGO_ENABLED="${CGO_ENABLED:-0}" \
  go build -trimpath -ldflags="-s -w" -o "$DIST_DIR/bin/$APP_NAME" .

cp -R configs "$DIST_DIR/configs"
cp start.sh stop.sh "$DIST_DIR/"

chmod +x "$DIST_DIR/bin/$APP_NAME" "$DIST_DIR/start.sh" "$DIST_DIR/stop.sh"

tar -czf "$ARCHIVE" -C "$PACKAGE_ROOT" "$PACKAGE_NAME"

echo "package created: $ARCHIVE"
