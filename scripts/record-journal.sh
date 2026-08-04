#!/usr/bin/env bash
# 录一条 E2E journal。
#
# 接上哪个功能：会话录制。应用必须**干净退出**才封口 journal——`app.quit`
# 走最后一扇窗关闭的同一条收尾链。被信号杀掉的进程留不下结束标记，
# 回放会判 JournalTruncated。
#
# 用法：record-journal.sh <输出路径> <命令文件...>
set -euo pipefail

OUT="$1"; shift
cd "$(dirname "$0")/../apps/native"
D=.zig-cache/native-sdk-automation
rm -rf "$D"
mkdir -p "$(dirname "$OUT")"

DISPLAY=:100 NATIVE_SDK_SESSION_RECORD="$OUT" ./zig-out/bin/refrain > /tmp/record.log 2>&1 &
APP=$!
sleep 7

N=1
for CMD in "$@"; do
  printf '%s\n' "$CMD" > "$D/command-$N.txt"
  N=$((N + 1))
  sleep 2
done

printf 'shortcut app.quit\n' > "$D/command-$N.txt"
sleep 6

if kill -0 $APP 2>/dev/null; then
  kill -9 $APP 2>/dev/null || true
  echo "FAIL  app did not exit cleanly; journal is truncated"
  exit 1
fi

grep -a -o 'sealed.*' /tmp/record.log
