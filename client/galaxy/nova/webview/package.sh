#!/usr/bin/env bash
set -euo pipefail

APP_NAME="nova-webview"
PRODUCT="nova"
export LC_ALL=C
export LANG=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PACKAGE_NAME="$APP_NAME-linux-x64"
PACKAGE_ROOT="${PACKAGE_ROOT:-$SCRIPT_DIR/package}"
DIST_DIR="$PACKAGE_ROOT/$PACKAGE_NAME"
ARCHIVE="${ARCHIVE:-$SCRIPT_DIR/$PACKAGE_NAME.tar.gz}"
BUILD_DIR="$WORKSPACE_DIR/.desktop/$PRODUCT"

bash "$SCRIPT_DIR/build.sh"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
# standalone 里 node_modules 和应用是按它们在仓库里的相对路径摆的，
# 挪一层就解析不到依赖了，所以整份原样搬过去。
cp -R "$BUILD_DIR/." "$DIST_DIR/"

# 只带模板，不带 runtime.json：那是部署机上的真配置（业务代理打哪台 Galaxy API），
# 跟着包发出去会在解包时把服务器上的那份改成打包机的值。首次部署由
# unpack-release.sh 从模板生成一份。
mv "$DIST_DIR/runtime.json" "$DIST_DIR/runtime.example.json"
cp "$SCRIPT_DIR/start.sh" "$SCRIPT_DIR/stop.sh" "$DIST_DIR/"

# 放一张最短的说明在包里。这一段是被现场问出来的：包里有 node_modules 和几份
# package.json，不写清楚就会有人先 npm install 一遍，然后卡在 @galaxy/common 上
# —— 那个包只存在于工作区，registry 上没有。
cat > "$DIST_DIR/README.txt" <<'NOTE'
Galaxy Nova 界面（共享端）

  ./start.sh                 起服务（默认 127.0.0.1:17898）
  ./stop.sh                  停服务
  logs/nova-webview.log     日志
  runtime.json               业务代理打哪台 Galaxy API（SERVER_TARGET）

依赖已经随包发好在 node_modules 里，不要在这个目录、webview/ 或 common/ 下
跑 npm install —— 装不动（@galaxy/common 只在工作区里有），还会把备好的
依赖当多余的裁掉（包括 next），之后 start.sh 就起不来了。

重新部署（在 tar.gz 旁边跑，不是在这个目录里）：
  ./deploy.sh                 stop -> 解包 -> start，一条命令
  ./unpack-release.sh --swap  先解到旁边再停，停机窗口更短
  ./unpack-release.sh --stage 只解包，线上照跑，晚点再 --swap 换过去
都只保留 runtime.json 和 logs/，上一版留在 <目录>.prev，回滚就是一条 mv。

监听地址用 PORT 和 WEBVIEW_HOST 改；默认那个正是 nginx 里 galaxy_nova 指着的地址。
NOTE
chmod +x "$DIST_DIR/start.sh" "$DIST_DIR/stop.sh"

tar -czf "$ARCHIVE" -C "$PACKAGE_ROOT" "$PACKAGE_NAME"

echo "package created: $ARCHIVE"
