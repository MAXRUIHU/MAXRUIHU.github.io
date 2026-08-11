#!/usr/bin/env bash
# 每周更新：拉取新数据并重启容器
set -euo pipefail
cd "$(dirname "$0")/pe-dashboard"
git pull --ff-only
docker compose restart
echo ">>> 数据已更新并重启。"
