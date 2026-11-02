#!/usr/bin/env bash
# 升级线上数据库结构（不丢数据）。
#
# 本质就是调 scripts/upgrade-db.ts，只是把「线上库路径 / 服务启停 / 缺失库防护」
# 这些琐事包进来，省得每次手敲一长串。升级逻辑全在 ts 里，本脚本只负责接线。
#
#   bash scripts/upgrade-db.sh                 # 用默认路径升级
#   bash scripts/upgrade-db.sh --db /path/db   # 指定别的库
#   bash scripts/upgrade-db.sh --no-service    # 不碰 systemd（你已手动停好服务时用）
#
# 默认配置（环境变量也能改）：
#   APP=/opt/seiten-suikyou/current            代码根（unpack.sh 解到的地方）
#   DB=/var/lib/seiten-suikyou/gs.db           线上库路径（DEPLOY.md 约定）
#   SERVICE=seiten-suikyou                     systemd 单元名

set -euo pipefail

# ---- 可改的默认值（环境变量或参数覆盖） ----
APP=${APP:-/opt/seiten-suikyou/current}
DB=${DB:-/var/lib/seiten-suikyou/gs.db}
SERVICE=${SERVICE:-seiten-suikyou}
NO_SERVICE=0
INIT_DB=0

# ---- 解析参数 ----
while [ $# -gt 0 ]; do
  case "$1" in
    --db)          DB="$2"; shift 2 ;;
    --app)         APP="$2"; shift 2 ;;
    --service)     SERVICE="$2"; shift 2 ;;
    --no-service)  NO_SERVICE=1; shift ;;
    --init)        INIT_DB=1; shift ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0 ;;
    *) echo "✗ 不认识的参数：$1（用 -h 看用法）" >&2; exit 1 ;;
  esac
done

# ---- 前置检查 ----
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 找不到 node，确认一下 Node 22.18+ 在 PATH 里。" >&2
  exit 1
fi
if [ ! -d "$APP" ]; then
  echo "✗ 代码目录不存在：$APP" >&2
  exit 1
fi
if [ ! -f "$APP/scripts/upgrade-db.ts" ]; then
  echo "✗ 没找到升级脚本：$APP/scripts/upgrade-db.ts" >&2
  exit 1
fi
# 生产环境不该随手建个空库：路径不对就喊停，除非显式 --init
if [ ! -f "$DB" ] && [ "$INIT_DB" -eq 0 ]; then
  echo "✗ 线上库不存在：$DB（确认路径；真要新建空库加 --init）" >&2
  exit 1
fi

# ---- 迁移前先把服务停下（避免 WAL 写入和锁竞争，备份也才一致） ----
RESTART=0
if [ "$NO_SERVICE" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    echo "· 停服务 $SERVICE …"
    systemctl stop "$SERVICE"
    RESTART=1
  else
    echo "· 服务 $SERVICE 未运行，跳过停止。"
  fi
fi

# ---- 真正干活：调 ts 升级脚本 ----
# 从代码根跑，保证 ../src 相对引用能正确落到 src/ 上；
# node:sqlite 是实验特性，必须带 --disable-warning=ExperimentalWarning。
echo "· 升级库：$DB"
cd "$APP"
set +e
node --disable-warning=ExperimentalWarning scripts/upgrade-db.ts --db "$DB"
RC=$?
set -e

# ---- 恢复服务 ----
if [ "$RESTART" -eq 1 ]; then
  echo "· 起服务 $SERVICE …"
  if ! systemctl start "$SERVICE"; then
    echo "⚠ 服务没起来，请手动 'systemctl start $SERVICE' 检查。" >&2
  fi
fi

if [ "$RC" -ne 0 ]; then
  echo "✗ 升级脚本返回非零（$RC），上面日志里有原因。" >&2
  exit "$RC"
fi
echo "✓ 升级完成。"
