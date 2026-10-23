#!/usr/bin/env bash
# 把打好的 tgz 解到 releases/今天/，再把 current 软链指过去。
#
#   bash scripts/unpack.sh seiten-suikyou-0.1.0.tgz
#   bash scripts/unpack.sh seiten-suikyou-0.1.0.tgz -f     # 今天解过一次了，覆盖
#
# 解析到哪个目录只看今天是哪天：同一天发两次要么加 -f，要么把旧目录删了。

set -euo pipefail

APP=${APP:-/opt/seiten-suikyou}
TGZ=${1:-}
FORCE=${2:-}

if [ -z "$TGZ" ] || [ ! -f "$TGZ" ]; then
  echo "用法: bash scripts/unpack.sh <tgz 路径> [-f]" >&2
  exit 1
fi

DAY=$(date +%Y%m%d)
DEST="$APP/releases/$DAY"

if [ -e "$DEST" ]; then
  if [ "$FORCE" != "-f" ]; then
    echo "✗ $DEST 已经存在（今天解过一次）。加 -f 覆盖，或换个目录名。" >&2
    exit 1
  fi
  rm -rf "$DEST"
fi

mkdir -p "$DEST"
# 包内成员是 package/... 这一层，剥掉它才是干净的 src/ vendor/ package.json
tar -xzf "$TGZ" --strip-components=1 -C "$DEST"
ln -sfn "$DEST" "$APP/current"

# 软链建不起来必须当场喊停，否则 systemd 会去读一个不存在的目录
if [ ! -L "$APP/current" ]; then
  echo "✗ 软链没建起来：$APP/current（目录不可写，或者文件系统不支持软链）" >&2
  exit 1
fi

echo "✓ 代码  $DEST"
echo "✓ current -> $DEST"
echo
echo "下一步（依赖只在这台机器上用 npm 装）："
echo "  cd $DEST && pnpm install --prod"
echo "  systemctl restart seiten-suikyou"
