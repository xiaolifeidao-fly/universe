#!/bin/sh
# ai-bridge 安装脚本（Linux / macOS）。平台地址已经填好了。
#
#   curl -fsSL <平台地址>/agent/v1/bridge/install.sh | sh
#   curl -fsSL <平台地址>/agent/v1/bridge/install.sh | sh -s -- --key gpk-XXXX [--name 机器名] [--dir 目录] [--user 用户]
#   curl -fsSL <平台地址>/agent/v1/bridge/install.sh | sh -s -- --key gpk-XXXX \
#       --mode export --public-url http://203.0.113.7:8788
#
# 接入方式（--mode）：poll 主动向平台领活，不需要公网 IP；export 平台主动回连，
# 要一个平台够得着的地址（--public-url）和放行的端口。这两个参数只是原样交给
# `ai-bridge register` —— 安装脚本不认识它们的含义，认识的是 ai-bridge 自己。
#
# 装到哪：root 执行是 /opt/ai-bridge，并建软链 /usr/local/bin/ai-bridge；
# 普通用户执行是 ~/.local/share/ai-bridge，软链 ~/.local/bin/ai-bridge。
# 重复执行就是原地升级，配置和节点身份都不动。
#
# 为什么不装进 /usr/local/bin 本身：远程升级要替换可执行文件，也就要求**运行服务的
# 那个用户**对它所在的目录可写。/usr/local/bin 属于 root，把它交给服务用户等于让
# 那个用户能替换系统里的别的程序。所以单独一个目录，用 --user 交给它。
#
# 整个脚本包在一个函数里，最后一行才调用：从网络上边下边执行时，下载被截断
# 也不会执行到一半的逻辑。
set -eu

ai_bridge_install() {
  HUB="__HUB_URL__"
  KEY=""
  NAME=""
  DIR=""
  RUN_USER=""
  MODE=""
  PUBLIC_URL=""
  BIND_HOST=""
  PORT=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --hub) HUB="${2:-}"; shift 2 ;;
      --key) KEY="${2:-}"; shift 2 ;;
      --name) NAME="${2:-}"; shift 2 ;;
      --dir) DIR="${2:-}"; shift 2 ;;
      --user) RUN_USER="${2:-}"; shift 2 ;;
      --mode) MODE="${2:-}"; shift 2 ;;
      --public-url) PUBLIC_URL="${2:-}"; shift 2 ;;
      --host) BIND_HOST="${2:-}"; shift 2 ;;
      --port) PORT="${2:-}"; shift 2 ;;
      -h|--help)
        echo "用法：install.sh [--key gpk-XXXX] [--name 机器名] [--dir 安装目录] [--user 运行用户] [--hub 平台地址]"
        echo "      [--mode poll|export] [--public-url 地址] [--host 监听地址] [--port 监听端口]"
        return 0 ;;
      *) echo "ai-bridge: 不认识的参数 $1" >&2; return 2 ;;
    esac
  done

  [ -n "$HUB" ] || { echo "ai-bridge: 缺少平台地址（--hub）" >&2; return 2; }

  # 接入参数在下载之前就核一遍：填错时主人还没等完一次下载，报错也还在屏幕上。
  case "$MODE" in
    ""|poll|export) ;;
    *) echo "ai-bridge: --mode 只能是 poll 或 export，收到 $MODE" >&2; return 2 ;;
  esac
  if [ "$MODE" = "export" ] && [ -z "$PUBLIC_URL" ]; then
    echo "ai-bridge: --mode export 需要 --public-url：平台要靠这个地址回连这台机器" >&2
    return 2
  fi

  # ---- 认平台 ----
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux) os_name=linux ;;
    Darwin) os_name=darwin ;;
    *) echo "ai-bridge: 不支持的系统 $os（只有 Linux 与 macOS 有包，Windows 用 install.ps1）" >&2; return 1 ;;
  esac
  case "$arch" in
    x86_64|amd64) arch_name=x64 ;;
    aarch64|arm64) arch_name=arm64 ;;
    *) echo "ai-bridge: 不支持的架构 $arch" >&2; return 1 ;;
  esac
  platform="$os_name-$arch_name"

  # ---- 下载工具与校验工具 ----
  if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL "$1" -o "$2"; }
    fetch_text() { curl -fsSL "$1"; }
  elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -qO "$2" "$1"; }
    fetch_text() { wget -qO- "$1"; }
  else
    echo "ai-bridge: 机器上既没有 curl 也没有 wget" >&2; return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sum() { sha256sum "$1" | awk '{print $1}'; }
  elif command -v shasum >/dev/null 2>&1; then
    sum() { shasum -a 256 "$1" | awk '{print $1}'; }
  else
    echo "ai-bridge: 机器上没有 sha256sum / shasum，无法校验安装包" >&2; return 1
  fi

  work=$(mktemp -d 2>/dev/null || mktemp -d -t ai-bridge)
  # 失败也要清干净：留一个装了一半的临时目录，下次排查时会以为它是有用的。
  trap 'rm -rf "$work"' EXIT INT TERM

  echo "ai-bridge: 平台 $platform，从 $HUB 下载"
  archive="$work/ai-bridge.tar.gz"
  fetch "$HUB/agent/v1/bridge/download/$platform" "$archive" ||
    { echo "ai-bridge: 下载失败（这个平台可能还没有发布安装包）" >&2; return 1; }

  expected=$(fetch_text "$HUB/agent/v1/bridge/checksum/$platform" | awk '{print $1}') || expected=""
  [ -n "$expected" ] || { echo "ai-bridge: 取不到校验值，装不下去" >&2; return 1; }
  actual=$(sum "$archive")
  if [ "$expected" != "$actual" ]; then
    echo "ai-bridge: 校验值对不上（期望 $expected，实际 $actual），不装" >&2
    return 1
  fi

  tar -xzf "$archive" -C "$work" || { echo "ai-bridge: 解包失败" >&2; return 1; }
  src=$(find "$work" -maxdepth 1 -type d -name "ai-bridge-*-$platform" | head -n 1)
  [ -n "$src" ] && [ -x "$src/ai-bridge" ] || { echo "ai-bridge: 包里没有可执行文件" >&2; return 1; }

  # ---- 装到哪 ----
  root=0
  [ "$(id -u)" = "0" ] && root=1
  if [ -z "$DIR" ]; then
    if [ "$root" = "1" ]; then DIR="/opt/ai-bridge"; else DIR="$HOME/.local/share/ai-bridge"; fi
  fi
  mkdir -p "$DIR"
  # 同目录临时文件 + mv：正在跑的那个进程用的是旧文件的 inode，替换不会把它打断。
  cp "$src/ai-bridge" "$DIR/.ai-bridge.new"
  chmod 0755 "$DIR/.ai-bridge.new"
  mv -f "$DIR/.ai-bridge.new" "$DIR/ai-bridge"
  # 部署说明与服务模板跟着走：拿到机器的人手边往往没有这个仓库。
  rm -rf "$DIR/deploy"
  cp -R "$src/deploy" "$DIR/deploy" 2>/dev/null || true
  cp "$src/README.md" "$DIR/README.md" 2>/dev/null || true

  if [ "$root" = "1" ]; then
    ln -sf "$DIR/ai-bridge" /usr/local/bin/ai-bridge
    bin=/usr/local/bin/ai-bridge
  else
    mkdir -p "$HOME/.local/bin"
    ln -sf "$DIR/ai-bridge" "$HOME/.local/bin/ai-bridge"
    bin="$HOME/.local/bin/ai-bridge"
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) ;;
      *) echo "ai-bridge: $HOME/.local/bin 不在 PATH 里，先把它加进去再用 ai-bridge 这个名字" ;;
    esac
  fi

  # 服务以别的用户跑时，安装目录要交给它 —— 否则远程升级换不了文件。
  if [ -n "$RUN_USER" ]; then
    if [ "$root" != "1" ]; then
      echo "ai-bridge: --user 只有 root 执行时有意义，已忽略" >&2
    else
      chown -R "$RUN_USER" "$DIR"
      echo "ai-bridge: 安装目录已交给 $RUN_USER（远程升级要替换这里的文件）"
    fi
  fi

  version=$("$DIR/ai-bridge" version 2>/dev/null || echo "ai-bridge")
  echo "ai-bridge: 已安装 $version → $DIR/ai-bridge（软链 $bin）"

  # ---- 顺手注册 ----
  # 下面几处提示里要重复的接入参数，先拼成一段。
  access_hint=""
  [ -n "$MODE" ] && access_hint="$access_hint --mode $MODE"
  [ -n "$PUBLIC_URL" ] && access_hint="$access_hint --public-url $PUBLIC_URL"
  [ -n "$BIND_HOST" ] && access_hint="$access_hint --host $BIND_HOST"
  [ -n "$PORT" ] && access_hint="$access_hint --port $PORT"

  if [ -n "$KEY" ]; then
    set -- register --hub "$HUB" --key "$KEY"
    [ -n "$NAME" ] && set -- "$@" --name "$NAME"
    # 接入方式原样转交：认不认得这些值是 ai-bridge 的事，脚本只负责不把它们弄丢。
    [ -n "$MODE" ] && set -- "$@" --mode "$MODE"
    [ -n "$PUBLIC_URL" ] && set -- "$@" --public-url "$PUBLIC_URL"
    [ -n "$BIND_HOST" ] && set -- "$@" --host "$BIND_HOST"
    [ -n "$PORT" ] && set -- "$@" --port "$PORT"
    if [ "$root" = "1" ] && [ -n "$RUN_USER" ]; then
      # 注册要写的是**那个用户**的家目录（配置与节点身份都在那儿），所以换用户执行。
      quoted=""
      for arg in "$@"; do
        escaped=$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")
        quoted="$quoted '$escaped'"
      done
      su -s /bin/sh "$RUN_USER" -c "'$bin'$quoted" || {
        echo "ai-bridge: 注册失败，修好之后以 $RUN_USER 执行：$bin register --hub $HUB --key <密钥>$access_hint" >&2
        return 1
      }
    else
      "$bin" "$@" || { echo "ai-bridge: 注册失败" >&2; return 1; }
    fi
  fi

  echo ""
  echo "下一步："
  if [ -z "$KEY" ]; then
    echo "  1) 注册：$bin register --hub $HUB --key <接入密钥>$access_hint"
    echo "     接入密钥在控制台「账户 → 接入密钥」里签发。"
    echo "  2) 运行：$bin run"
  else
    echo "  1) 运行：$bin run"
  fi
  if [ "$MODE" = "export" ]; then
    echo "  这台机器按 export 接入：平台会回连 $PUBLIC_URL，确认防火墙和安全组放行了那个端口。"
  fi
  echo "  长期运行请配成系统服务，模板和说明在 $DIR/deploy/（systemd / launchd / 计划任务）。"
  echo "  之后的升级可以在控制台的机器列表里点「升级」，或者在这台机器上跑 $bin upgrade。"
}

ai_bridge_install "$@"
