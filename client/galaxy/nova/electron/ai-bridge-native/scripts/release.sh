#!/bin/sh
# 出一版 ai-bridge。不带参数就是最常走的那条路：
#
#   sh scripts/release.sh                          抬一格 patch，重编 .node，出 linux-x64 包并签名
#   sh scripts/release.sh --note "这一版做了什么"    同上，顺带在 Cargo.toml 里留一行说明
#   sh scripts/release.sh 1.0.0                    指定版本号（等于 --version 1.0.0）
#   sh scripts/release.sh minor                    抬小版本（等于 --bump minor）
#   sh scripts/release.sh 1.0.0 --note "……" --no-node
#   sh scripts/release.sh --keep-version            按 Cargo.toml 现在的号重打一遍，不抬号
#   sh scripts/release.sh --target aarch64-apple-darwin      只出这个平台（不再自动加 linux）
#
# 参数原样透传给 scripts/release.cjs（`sh scripts/release.sh --help` 看全部）。
# 这层壳只做三件 release.cjs 不该管的事：
#   1. 找 node 和 cargo —— 它们常常不在 PATH 里（nvm 装的 node、rustup 装的 cargo）；
#   2. 补两个默认值：没给 --bump / --version 就抬 patch，没给 --target 就出 linux-x64（--zig）；
#   3. 交叉编译要的 cargo-zigbuild 不在时，先说清楚怎么装，别等编到一半报个看不懂的错。
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname -- "$here")

# node 的找法：先看 PATH，再看 nvm 装的（取版本号排最后那个）。
# 写死一个绝对路径的下场见 LaunchAgent 那几个 daemon —— 换一次 node 版本就静默失效。
node_bin=$(command -v node 2>/dev/null || true)
if [ -z "$node_bin" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$candidate" ] && node_bin=$candidate
  done
fi
if [ -z "$node_bin" ]; then
  echo "release.sh: 找不到 node（PATH 里没有，~/.nvm/versions/node/ 下也没有）" >&2
  exit 1
fi

# cargo：rustup 装在 ~/.cargo/bin，非登录 shell 里常常没加进 PATH。
[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
export PATH
if ! command -v cargo >/dev/null 2>&1; then
  echo "release.sh: 找不到 cargo（~/.cargo/bin 里也没有），装好 Rust 再来" >&2
  exit 1
fi

# 第一个参数直接写版本号或 patch / minor / major 时，当成 --version / --bump 的简写。
# 只认第一个参数，且必须以数字开头 —— 这样不会和任何 --开头的参数抢。
case ${1:-} in
  [0-9]*.[0-9]*.[0-9]*) set -- --version "$@" ;;
  patch|minor|major) set -- --bump "$@" ;;
esac

# --keep-version 是这层壳自己的参数，不往下传：它只是让下面别补 --bump patch，
# release.cjs 收不到抬版本的参数就会按 Cargo.toml 里现在的号重打一遍。
keep_version=0
remaining=$#
while [ "$remaining" -gt 0 ]; do
  arg=$1
  shift
  if [ "$arg" = "--keep-version" ]; then keep_version=1; else set -- "$@" "$arg"; fi
  remaining=$((remaining - 1))
done

# 参数里已经给了的，就不再补默认值。
want_bump=1
want_target=1
for arg in "$@"; do
  case $arg in
    --bump|--bump=*|--version|--version=*) want_bump=0 ;;
    --target|--target=*) want_target=0 ;;
    --help|-h) exec "$node_bin" "$here/release.cjs" --help ;;
  esac
done
if [ "$keep_version" = 1 ] && [ "$want_bump" = 0 ]; then
  echo "release.sh: --keep-version 和 --bump / --version 是两回事，只能给一个" >&2
  exit 1
fi

if [ "$want_target" = 1 ]; then
  # 默认平台是服务器节点那台：linux-x64，用 zig 按 glibc 2.17 链，老发行版也能跑。
  if ! command -v cargo-zigbuild >/dev/null 2>&1; then
    echo "release.sh: 要出 linux-x64 包得先装 cargo-zigbuild：" >&2
    echo "  cargo install cargo-zigbuild        # zig 本身用 pip 装的 ziglang 也行，它自己会找" >&2
    echo "  （只想出本机的包就加 --target $(uname -m | sed 's/arm64/aarch64/')-apple-darwin）" >&2
    exit 1
  fi
  set -- --target x86_64-unknown-linux-gnu --zig "$@"
fi
[ "$want_bump" = 1 ] && [ "$keep_version" = 0 ] && set -- --bump patch "$@"

cd "$root"
echo "release.sh: node $node_bin"
echo "release.sh: release.cjs $*"
echo ""
exec "$node_bin" "$here/release.cjs" "$@"
