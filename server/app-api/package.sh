#!/usr/bin/env bash
set -euo pipefail

APP_NAME="app-api"
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

echo "building $APP_NAME for $TARGET_OS/$TARGET_ARCH..."
GOWORK=off GOOS="$TARGET_OS" GOARCH="$TARGET_ARCH" CGO_ENABLED="${CGO_ENABLED:-0}" \
  go build -trimpath -ldflags="-s -w" -o "$DIST_DIR/bin/$APP_NAME" .

cp -R configs "$DIST_DIR/configs"
cp start.sh stop.sh "$DIST_DIR/"

chmod +x "$DIST_DIR/bin/$APP_NAME" "$DIST_DIR/start.sh" "$DIST_DIR/stop.sh"

tar -czf "$ARCHIVE" -C "$PACKAGE_ROOT" "$PACKAGE_NAME"

echo "package created: $ARCHIVE"
