#!/usr/bin/env bash
# ai-bridge 重装：把上传上来的发布包换到安装目录，再按这台机器原来的方式把节点起回来。
#
#   ./reinstall.sh                                  用脚本所在目录里最新上传的那个包
#   ./reinstall.sh ai-bridge-0.2.0-linux-x64.tar.gz  指定包
#
# 顺序是有讲究的：**先换文件再停进程**。Linux 上 rename 换掉的是目录项，正在跑的进程
# 攥着的还是旧 inode，一个字节都不受影响 —— 所以停机窗口只有「停 + 起」那几秒，
# 而不是「停 + 解包 + 换 + 起」。换之前先把新二进制试跑一次（architecture、glibc、
# 系统拦截都在这一步暴露），跑不起来就原地打住，现有安装一动不动。
#
# 不碰的东西：配置（~/.config/ai-bridge/config.yaml）、节点身份和 export 回连密钥
# （~/.local/state/ai-bridge/）都在家目录，不在安装目录。重装之后控制台上还是同一台
# 机器，不会越装越多。唯一例外是在控制台解绑过的机器，那种要 `ai-bridge register --fresh`。
#
# 可以用环境变量改：
#   AI_BRIDGE_INSTALL_DIR  安装目录，默认 /opt/ai-bridge
#   AI_BRIDGE_LINK         软链，默认 /usr/local/bin/ai-bridge
#   AI_BRIDGE_LOG          日志；默认续用在跑的那个进程正在写的文件
#   AI_BRIDGE_STOP_WAIT    等优雅停机的秒数，默认 90
[ -n "${BASH_VERSION:-}" ] || { echo "请用 bash 跑：./reinstall.sh 或 bash reinstall.sh（sh/dash 不行）" >&2; exit 1; }
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${AI_BRIDGE_INSTALL_DIR:-/opt/ai-bridge}"
LINK="${AI_BRIDGE_LINK:-/usr/local/bin/ai-bridge}"
STOP_WAIT="${AI_BRIDGE_STOP_WAIT:-90}"
BIN="$INSTALL_DIR/ai-bridge"

die() { echo "错误：$*" >&2; exit 1; }
note() { echo "==> $*"; }

# ---------------------------------------------------------------- 找包并解开

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ]; then
  # 按修改时间取最新的一个：要装的通常就是刚传上来那个。
  ARCHIVE="$(ls -1t "$SCRIPT_DIR"/ai-bridge-*-linux-*.tar.gz 2>/dev/null | head -1 || true)"
  [ -n "$ARCHIVE" ] || die "没给包，$SCRIPT_DIR 里也没找到 ai-bridge-*-linux-*.tar.gz"
fi
[ -f "$ARCHIVE" ] || die "找不到 $ARCHIVE"
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"
note "安装包 $ARCHIVE"

# 包旁边有 SHA256SUMS 就顺手核一遍。没有不拦着 —— 手动传上来的包本来就没走平台那套校验。
SUMS="$(dirname "$ARCHIVE")/SHA256SUMS"
if [ -f "$SUMS" ] && command -v sha256sum >/dev/null; then
  if grep -q "  $(basename "$ARCHIVE")\$" "$SUMS"; then
    (cd "$(dirname "$ARCHIVE")" && grep "  $(basename "$ARCHIVE")\$" SHA256SUMS | sha256sum -c -) \
      || die "sha256 对不上，这个包传坏了或者被换过，别装"
  fi
else
  echo "    （旁边没有 SHA256SUMS，跳过校验和）"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP"
# -type d 顺手绕开 mac 打包带出来的 ._ 开头 AppleDouble 垃圾文件。
NEW_DIR="$(find "$TMP" -maxdepth 1 -mindepth 1 -type d -name 'ai-bridge-*' | head -1)"
[ -n "$NEW_DIR" ] && [ -x "$NEW_DIR/ai-bridge" ] || die "包里没找到 ai-bridge-<版本>-<平台>/ai-bridge"

# 试跑：架构不对、glibc 太老、被系统拦下来，都在这里暴露，而且现在还没动过任何东西。
NEW_VERSION="$("$NEW_DIR/ai-bridge" version 2>&1)" \
  || die "新二进制在这台机器上跑不起来，现有安装没动：$NEW_VERSION"
note "新版本 $NEW_VERSION"
# 包是按修改时间挑的，不是按版本号 —— 传个老包上来它照装不误。降级是合法操作
# （回滚就靠它），但得让人看见自己在往回走。
OLD_ON_DISK="$("$BIN" version 2>/dev/null | awk '{print $2}' || true)"
NEW_NUM="$(echo "$NEW_VERSION" | awk '{print $2}')"
if [ -n "$OLD_ON_DISK" ] && [ "$OLD_ON_DISK" != "$NEW_NUM" ] \
   && [ "$(printf '%s\n%s\n' "$OLD_ON_DISK" "$NEW_NUM" | sort -V | head -1)" = "$NEW_NUM" ]; then
  echo "    注意：这是降级 $OLD_ON_DISK → $NEW_NUM"
fi

# ------------------------------------------------- 摸清楚现在是怎么跑的

# 按「在跑的是不是我们这个安装」来认，不按进程名 —— `pgrep -x ai-bridge` 有两头漏：
# 哪天二进制改了名就永远找不到（于是装完再起一个，两个实例抢同一个节点身份，而且一声不吭），
# 别的目录装的另一份 ai-bridge 又会被误当成自己的。/proc 读不到时才退回 pgrep。
find_running() {
  local dir pid exe
  for dir in /proc/[0-9]*; do
    exe="$(readlink "$dir/exe" 2>/dev/null)" || continue
    # 二进制被换掉之后 readlink 会带 " (deleted)" 后缀，得剥掉再比
    case "${exe% (deleted)}" in "$BIN"|"$LINK") echo "${dir#/proc/}" ;; esac
  done
}
RUNNING="$(find_running)"
[ -n "$RUNNING" ] || RUNNING="$(pgrep -x ai-bridge || true)"
PID="$(echo "$RUNNING" | head -1)"
if [ "$(echo "$RUNNING" | grep -c . || true)" -gt 1 ]; then
  echo "    注意：有不止一个实例在跑（$(echo "$RUNNING" | tr '\n' ' ')），本脚本只处理 PID $PID"
fi
UNIT=""
LOG="${AI_BRIDGE_LOG:-}"
if [ -n "$PID" ]; then
  OLD_VERSION="$("$BIN" version 2>/dev/null || echo '未知')"
  note "在跑 PID $PID（磁盘上现有 $OLD_VERSION）"
  # systemd 管着的话，cgroup 里会写明是哪个 unit —— 那就交还给 systemd 重启，
  # 别自己 nohup 一个出来跟它抢。
  UNIT="$(sed -n 's#.*/\([^/]*\.service\)$#\1#p' "/proc/$PID/cgroup" 2>/dev/null | head -1 || true)"
  # 日志续用它正在写的那个文件，省得重启一次换一个地方、翻历史要翻好几个文件。
  if [ -z "$LOG" ]; then
    LOG="$(readlink "/proc/$PID/fd/1" 2>/dev/null || true)"
    case "$LOG" in /*) ;; *) LOG="" ;; esac   # 管道、/dev/null、socket 都不算
  fi
  [ -n "$UNIT" ] && note "由 systemd 管着：$UNIT" || true
else
  note "当前没有 ai-bridge 在跑，装完直接起一个"
fi
LOG="${LOG:-$INSTALL_DIR/ai-bridge.log}"

# --------------------------------------------------------------- 换文件

mkdir -p "$INSTALL_DIR"
[ -w "$INSTALL_DIR" ] || die "$INSTALL_DIR 不可写（用能写它的用户跑，或者 sudo）"

ROLLED_BACK=0
rollback() {
  [ "$ROLLED_BACK" = 0 ] || return 0
  ROLLED_BACK=1
  if [ -f "$BIN.old" ]; then
    echo "==> 回滚到上一版" >&2
    mv -f "$BIN.old" "$BIN"
  fi
}

if [ -f "$BIN" ]; then
  cp -f "$BIN" "$BIN.old"      # 留一份退路，见下面「退回上一版」
fi
# 同一个文件系统里 mv 是原子的 rename：不会出现「换到一半」的可执行文件。
cp -f "$NEW_DIR/ai-bridge" "$BIN.new"
chmod 755 "$BIN.new"
mv -f "$BIN.new" "$BIN"
# 部署说明和服务模板一起更新，免得下次照着旧文档操作。
rm -rf "$INSTALL_DIR/deploy"
cp -R "$NEW_DIR/deploy" "$INSTALL_DIR/deploy" 2>/dev/null || true
cp -f "$NEW_DIR/README.md" "$INSTALL_DIR/README.md" 2>/dev/null || true
ln -sfn "$BIN" "$LINK" 2>/dev/null || echo "    （建不了软链 $LINK，跳过）"
note "已换上 $BIN（上一版留在 $BIN.old）"

# ----------------------------------------------------------- 停 → 起

start_node() {
  if [ -n "$UNIT" ]; then
    systemctl start "$UNIT"
  else
    mkdir -p "$(dirname "$LOG")"
    # setsid：脱离当前终端，ssh 断开不会把节点带走。
    local launcher=""
    command -v setsid >/dev/null && launcher="setsid" || true
    # 子 shell 自己的三个标准流也要断干净：它继承着本脚本的 stdout，不断的话
    # `./reinstall.sh | tee 日志` 这种跑法里，管道那头会一直等不到 EOF，终端挂住。
    ( cd "$(dirname "$LOG")" && $launcher nohup "$LINK" run >>"$LOG" 2>&1 </dev/null & ) >/dev/null 2>&1 </dev/null
  fi
}

if [ -n "$PID" ]; then
  if [ -n "$UNIT" ]; then
    note "systemctl restart $UNIT"
    systemctl restart "$UNIT" || { rollback; die "重启失败"; }
  else
    # SIGTERM 走完整停机：在跑的请求会报给平台，平台立刻改派给别的机器，使用者无感。
    # kill -9 的话他们要干等一个超时，所以这里宁可等，也不升级信号。
    note "停 PID $PID（SIGTERM，最多等 ${STOP_WAIT}s）"
    kill -TERM "$PID" 2>/dev/null || true
    waited=0
    while kill -0 "$PID" 2>/dev/null; do
      [ "$waited" -lt "$STOP_WAIT" ] || {
        rollback
        die "等了 ${STOP_WAIT}s 还没退（PID $PID）。已回滚到旧版本，老进程还在正常干活。
     手动看一眼它卡在哪：tail -f $LOG；确实要强停再 kill -9 $PID，代价是在跑的请求会让使用者干等超时。"
      }
      sleep 1; waited=$((waited + 1))
    done
    note "已停（${waited}s）"
    start_node
  fi
else
  start_node
fi

# ------------------------------------------------------------------ 验

sleep 3
NEW_PID="$(pgrep -x ai-bridge | head -1 || true)"
if [ -z "$NEW_PID" ]; then
  echo "    新进程没起来，最后几行日志：" >&2
  tail -n 20 "$LOG" 2>/dev/null >&2 || true
  rollback
  start_node
  die "起不来，已回滚到上一版并重新拉起。"
fi

note "起来了 PID $NEW_PID"
echo
"$LINK" status || true
echo
echo "日志：tail -f $LOG"
echo "退回上一版：mv $BIN.old $BIN 然后重跑本脚本的停/起，或者直接再跑一次旧包"
