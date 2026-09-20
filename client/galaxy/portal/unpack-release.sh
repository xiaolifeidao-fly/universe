#!/bin/sh
set -eu

# 在**服务器**上解包 portal 的发布包。把 tar.gz 和这个脚本放同一个目录，
# 直接跑 ./unpack-release.sh 就行。
#
# 三种用法，差别只在「什么时候动正在跑的那份」：
#
#   ./unpack-release.sh           服务停着的时候换版本；还在跑就拒绝动手
#   ./unpack-release.sh --stage   只把新版本解到旁边的暂存目录，不碰正在跑的那份
#   ./unpack-release.sh --swap    停老的 → 换目录 → 起新的；没提前 --stage 就现解一份
#
# --stage/--swap 是为了「不用先手工 stop」。解包这一步挪到服务还活着的时候做，
# 停机窗口里只剩 stop → mv → start，全是秒级动作。包传坏了、盘满了、归档里
# 不是一个顶层目录 —— 这些都在 --stage 那步就露馅，线上那份一根头发没动。
#
# 为什么不能直接「先解包再 stop」：解包是把整个目录换掉（见下面那段注释），
# run/*.pid 会跟着一起没，stop.sh 再跑就找不到进程了 —— 老进程成了孤儿还占着
# 端口，新的怎么都起不来。--swap 就是把这个顺序做对：先解到旁边，停下来之后
# 才换目录。
export LC_ALL=C
export LANG=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
  echo "Usage: $0 [--stage|--swap] [--no-start] [archive.tar.gz] [deploy_parent_dir]" >&2
  echo "Example: $0                 # 服务停着的时候换版本" >&2
  echo "Example: $0 --stage         # 先解到暂存目录，不碰正在跑的那份" >&2
  echo "Example: $0 --swap          # 停 → 换 → 起" >&2
  echo "Example: $0 portal-linux-x64.tar.gz $SCRIPT_DIR" >&2
}

MODE="replace"
AUTO_START=1
ARCHIVE=""
DEPLOY_PARENT_DIR=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --stage) MODE="stage" ;;
    --swap) MODE="swap" ;;
    --no-start) AUTO_START=0 ;;
    -h|--help) usage; exit 0 ;;
    --*)
      echo "unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [ -z "$ARCHIVE" ]; then
        ARCHIVE="$1"
      elif [ -z "$DEPLOY_PARENT_DIR" ]; then
        DEPLOY_PARENT_DIR="$1"
      else
        usage
        exit 1
      fi
      ;;
  esac
  shift
done

if [ -z "$DEPLOY_PARENT_DIR" ]; then
  DEPLOY_PARENT_DIR="$SCRIPT_DIR"
fi

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
DEPLOY_PARENT_DIR="$(cd "$DEPLOY_PARENT_DIR" && pwd)"

# 顶层目录名只读清单拿，不解出来。老版本是先整包解到 /tmp 再解一次到位 ——
# 白解一遍，/tmp 小的机器还会在这儿 ENOSPC。tar -tzf 一样把整条流解压校验过，
# 传坏的包照样在这一步就露馅。
LIST_FILE="$TMP_DIR/entries.txt"
tar -tzf "$ARCHIVE" | sed -e 's|^\./||' -e '/^$/d' >"$LIST_FILE"
if [ ! -s "$LIST_FILE" ]; then
  echo "读不出归档内容（传坏了？）: $ARCHIVE" >&2
  exit 1
fi

ROOT_NAMES="$(sed -e 's|/.*$||' "$LIST_FILE" | sort -u)"
ROOT_COUNT="$(printf '%s\n' "$ROOT_NAMES" | wc -l | tr -d ' ')"
if [ "$ROOT_COUNT" != "1" ]; then
  echo "archive must contain exactly one top-level directory" >&2
  exit 1
fi

RELEASE_NAME="$ROOT_NAMES"
case "$RELEASE_NAME" in
  ''|.|..|/*|*/*)
    echo "refusing to deploy a suspicious release name: $RELEASE_NAME" >&2
    exit 1
    ;;
esac
if ! grep -q "^$RELEASE_NAME/" "$LIST_FILE"; then
  echo "archive must contain exactly one top-level directory" >&2
  exit 1
fi

RELEASE_DIR="$DEPLOY_PARENT_DIR/$RELEASE_NAME"
PREV_DIR="$RELEASE_DIR.prev"
# 暂存目录放在部署目录旁边，不是 /tmp：换目录那步要的是同一个盘上的 mv
# （瞬间完成）。跨盘就成了拷贝，停机窗口里最不该做的就是拷贝。
STAGE_PARENT="$DEPLOY_PARENT_DIR/.staging-$RELEASE_NAME"
STAGE_DIR="$STAGE_PARENT/$RELEASE_NAME"
STAGE_MARK="$STAGE_PARENT/.source"
ARCHIVE_ID="$(basename "$ARCHIVE") $(wc -c <"$ARCHIVE" | tr -d ' ')"

# 还在跑的 pid，没有就回空。
running_pid() {
  for pid_file in "$1"/run/*.pid; do
    [ -f "$pid_file" ] || continue
    rp_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$rp_pid" ] && kill -0 "$rp_pid" 2>/dev/null; then
      echo "$rp_pid"
      return 0
    fi
  done
  return 0
}

mark_executable() {
  for name in start.sh stop.sh; do
    if [ -f "$1/$name" ]; then
      chmod +x "$1/$name"
    fi
  done
}

stage_release() {
  rm -rf "$STAGE_PARENT"
  mkdir -p "$STAGE_PARENT"
  tar -xzf "$ARCHIVE" -C "$STAGE_PARENT"
  if [ ! -d "$STAGE_DIR" ]; then
    echo "解包后没看到 $RELEASE_NAME/，归档结构不对：$ARCHIVE" >&2
    exit 1
  fi
  mark_executable "$STAGE_DIR"
  printf '%s\n' "$ARCHIVE_ID" >"$STAGE_MARK"
}

# 首次部署那份 runtime.json 是从打包机的值生成的，SERVER_TARGET 多半不对，
# 所以首次部署不自动起 —— 让人先看一眼。
note_runtime() {
  if [ ! -f "$1/runtime.json" ]; then
    cp "$1/runtime.example.json" "$1/runtime.json"
    echo "首次部署：已从 runtime.example.json 生成 runtime.json"
    echo "启动前确认里面的 SERVER_TARGET 指向这台机器要打的 Galaxy API：$1/runtime.json"
    return 1
  fi
  return 0
}

NO_NPM_INSTALL_HINT="依赖已经随包发好，不要在这个目录跑 npm install —— 解包完直接 ./start.sh"

if [ "$MODE" = "stage" ]; then
  stage_release
  echo "release staged: $ARCHIVE -> $STAGE_DIR"
  echo "线上那份没动。要换过去：$0 --swap"
  exit 0
fi

if [ "$MODE" = "swap" ]; then
  if [ -f "$STAGE_MARK" ] && [ -d "$STAGE_DIR" ] && [ "$(cat "$STAGE_MARK" 2>/dev/null || true)" = "$ARCHIVE_ID" ]; then
    echo "用已经解好的暂存目录：$STAGE_DIR"
  else
    if [ -d "$STAGE_PARENT" ]; then
      echo "暂存目录里不是这个包（或者上次没解完），重新解一份"
    fi
    stage_release
  fi

  FIRST_DEPLOY=1
  if [ -d "$RELEASE_DIR" ]; then
    FIRST_DEPLOY=0
    pid="$(running_pid "$RELEASE_DIR")"
    if [ -n "$pid" ]; then
      if [ ! -f "$RELEASE_DIR/stop.sh" ]; then
        echo "$RELEASE_DIR 里的服务在跑（pid $pid），但没有 stop.sh，停不了。" >&2
        echo "自己停掉它再跑一次；新版本已经解在 $STAGE_DIR" >&2
        exit 1
      fi
      sh "$RELEASE_DIR/stop.sh" || true
      pid="$(running_pid "$RELEASE_DIR")"
      if [ -n "$pid" ]; then
        echo "老进程没停下来（pid $pid），什么都没换。" >&2
        echo "新版本解在 $STAGE_DIR，停掉它之后再跑一次 $0 --swap" >&2
        exit 1
      fi
    fi

    # 只有两样是这台机器自己的：runtime.json（本机配置）和 logs/。
    # 同一个盘上 mv 是瞬间的，这会儿服务已经停了，搬走也不会漏日志。
    #
    # runtime.json 是**抄**不是搬：搬走的话 .prev 里就没配置了，回滚起来的那份
    # 读不到 SERVER_TARGET —— 页面照开，业务接口全 502，还不报错。
    if [ -f "$RELEASE_DIR/runtime.json" ]; then
      cp "$RELEASE_DIR/runtime.json" "$STAGE_DIR/runtime.json"
    fi
    if [ -d "$RELEASE_DIR/logs" ]; then
      rm -rf "$STAGE_DIR/logs"
      mv "$RELEASE_DIR/logs" "$STAGE_DIR/logs"
    fi

    # 上一版留一份，回滚就是一条 mv。只留一代，不然盘会被一直吃下去。
    rm -rf "$PREV_DIR"
    mv "$RELEASE_DIR" "$PREV_DIR"
  fi

  mv "$STAGE_DIR" "$RELEASE_DIR"
  rm -rf "$STAGE_PARENT"
  mark_executable "$RELEASE_DIR"

  echo "release swapped: $ARCHIVE -> $RELEASE_DIR"
  echo "$NO_NPM_INSTALL_HINT"
  if [ "$FIRST_DEPLOY" = "0" ]; then
    echo "上一版留在 $PREV_DIR（下次 --swap 会覆盖它）"
  fi

  RUNTIME_OK=0
  if note_runtime "$RELEASE_DIR"; then
    RUNTIME_OK=1
  fi

  if [ "$AUTO_START" = "0" ] || [ "$RUNTIME_OK" = "0" ]; then
    echo "没有自动启动，确认配置之后：$RELEASE_DIR/start.sh"
    exit 0
  fi

  if sh "$RELEASE_DIR/start.sh"; then
    exit 0
  fi
  echo "" >&2
  echo "新版本没起来。上一版还在 $PREV_DIR，回滚：" >&2
  echo "  rm -rf $RELEASE_DIR.failed && mv $RELEASE_DIR $RELEASE_DIR.failed \\" >&2
  echo "    && mv $PREV_DIR $RELEASE_DIR && $RELEASE_DIR/start.sh" >&2
  exit 1
fi

# 默认：整个目录换掉，不做覆盖式解包。
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
  pid="$(running_pid "$RELEASE_DIR")"
  if [ -n "$pid" ]; then
    echo "$RELEASE_DIR 里的服务还在跑（pid $pid）。" >&2
    echo "要么先 $RELEASE_DIR/stop.sh 再解包；" >&2
    echo "要么用 $0 --swap —— 先把新版本解到旁边，停下来之后才换目录，不用手工 stop。" >&2
    exit 1
  fi
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

mark_executable "$RELEASE_DIR"

echo "release unpacked: $ARCHIVE -> $RELEASE_DIR"
# 踩过一次：包根原先带着工作区的 package.json，看见它就会想 npm install，
# 结果 postinstall 找不到 scripts/ 直接崩，还把随包发的依赖裁了。
echo "$NO_NPM_INSTALL_HINT"

note_runtime "$RELEASE_DIR" || true
