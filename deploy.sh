#!/usr/bin/env bash
# 一键部署/更新（在 VPS 上执行）
set -euo pipefail
REPO="git@github.com:MAXRUIHU/MAXRUIHU.github.io.git"
DIR="pe-dashboard"

if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO" "$DIR" && cd "$DIR"
else
  cd "$DIR" && git pull --ff-only
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo ">>> 首次部署：请先编辑 .env，设置 PE_AUTH_PASSWORD / PE_AUTH_SECRET，"
  echo ">>> 然后重新运行 ./deploy.sh"
  exit 0
fi

docker compose up -d --build
docker compose ps
echo
echo ">>> 站点已启动：http://<服务器IP>:8000"
echo ">>> 建议继续配置 HTTPS（Caddy/Nginx），见 Caddyfile.example 与 README"
