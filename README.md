# 私募量化周刊 · 管理人业绩看板

一个「数据 → 清洗 → 可视化 → 动态更新」的全栈小项目：从「无鱼内参」周报 Excel 中
抽取私募管理人的周度涨跌幅（24+ 策略分类，含 大厂/小厂 分档），清洗为连贯的面板数据，
并以 Apple 式审美的网页动态呈现。基准指数由源数据自带（沪深300/中证500/中证1000/
中证2000/中证全指/A500/南华商品/南华黄金等），无需外部下载。

## 目录结构

```
pe-dashboard/
├── public/                    # 前端静态站点（可直接部署 GitHub Pages）
│   ├── index.html
│   ├── css/styles.css
│   ├── js/charts.js           # 零依赖 SVG 图表引擎
│   ├── js/app.js              # SPA（hash 路由：时间/管理人筛选、对比、热力图）
│   └── data/dashboard_data.json   # 清洗后的最终数据（自动生成）
├── data/
│   └── dashboard_data.json     # 清洗后的最终数据（自动生成）
├── scripts/
│   ├── clean_wuyu.py          # 无鱼数据清洗管线（核心）
│   └── serve.py               # 后端服务：真实鉴权(会话/Basic) + 动态更新 API
├── public/data/dashboard_data.json   # 页面数据源（自动生成）
├── DATA_QUALITY_REPORT.md     # 每次清洗自动生成的质量报告
└── requirements.txt
```

## 数据清洗管线（scripts/clean_wuyu.py）

数据源为「无鱼内参」周报（`私募周报/无鱼/无鱼内参XXX-*.xlsx`，30 期，每期 24+ 策略 sheet），
针对其异构格式做了系统化处理：

1. **周序解析**：优先读取文件内日期 sheet（含 `2026.1.5-2026.1.9` 等变体），文件名兜底；
   自动得到 30 个交易周（01.05~01.09 → 08.03~08.07）。
2. **策略识别**：28 个策略分类（含 大厂/小厂/全部 分档；CTA/套利 等含「策略类型」子分类）。
3. **列语义定位**：行 0 混合「列名 + 统计值 + 基准」成对布局，按标签定位 区间收益/YTD收益/
   超额/回撤/统计块/基准。
4. **基准指数**：直接采用每期源数据自带的指数周收益（沪深300/中证500/中证1000/中证2000/
   中证全指/A500/南华商品/南华黄金），与真实行情一致，无需联网下载。
5. **去重合并**：同一管理人同周多产品（如 量化多头(小厂) 勤远）取均值合并并记录 QA。
6. **YTD 异常检测**：对连续在录周，若官方 YTD 隐含环比与「区间收益」偏差 >5pp，判定该周
   YTD 异常并剔除（官方口径回退复利），避免净值曲线出现荒谬跳变；受影响的序列打「YTD异常」标。
7. **净值构造**：默认「当周收益复利」口径（连贯、规避源数据 YTD 异常）；官方 YTD 可切换查看。
8. **质量审计**：自动输出 `DATA_QUALITY_REPORT.md`（缺失、重复、极端值、YTD 异常分布等）。

## 快速开始

```bash
cd pe-dashboard
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 1) 清洗无鱼周报，生成 public/data/dashboard_data.json + DATA_QUALITY_REPORT.md
python3 scripts/clean_wuyu.py

# 2) 本地预览（--watch 监听无鱼目录，新文件自动重建）
python3 scripts/serve.py --watch
# 打开 http://127.0.0.1:8000/
```

## 每周更新流程

1. 把新一期《无鱼内参XXX-*.xlsx》放入 `私募周报/无鱼/`；
2. 运行 `python3 scripts/clean_wuyu.py`（或 `serve.py --watch` 自动触发）；
3. 刷新网页即可看到最新一期数据（前端每 10 分钟自动重新拉取；
   也可点击导航栏刷新按钮，或 `POST /api/update`）。


## 真实登录鉴权（后端会话 / HTTP Basic Auth）

> GitHub Pages 是纯静态托管，**无法**在服务端鉴权；需要把站点跑在能执行代码的后端上
> （VPS、Render、Railway、Docker 等）。本项目后端 `scripts/serve.py` 内置真实鉴权，
> 且会在鉴权生效时自动让前端跳过客户端弹窗（避免双重输入）。

### 三种模式

| 模式 | 说明 |
|---|---|
| `session`（推荐） | 登录页 + 签名会话 Cookie（HttpOnly/SameSite=Lax，HTTPS 自动加 Secure）；未登录访问任意页面 → 302 到 `/login`；**密码错误展示微信二维码** |
| `basic` | HTTP Basic Auth（RFC 7617），浏览器原生弹窗；未认证返回 `401 + WWW-Authenticate` |
| `off` | 不鉴权，仅本地开发 |

### 本地启动（带鉴权）

```bash
PE_AUTH_MODE=session PE_AUTH_PASSWORD=你的密码 python3 scripts/serve.py --watch
# 打开 http://127.0.0.1:8000/ → 先登录，密码错误会弹出微信二维码
```

### 安全特性

- 密码不保存明文：启动时 PBKDF2-HMAC-SHA256 派生，常量时间比较
- 会话 Cookie 签名（HMAC-SHA256），12 小时过期（`PE_AUTH_TTL` 可调）
- 登录限流：同 IP 连续失败 5 次（`PE_AUTH_MAX_ATTEMPTS`）锁定 15 秒（`PE_AUTH_LOCKOUT`）
- 除登录页与二维码图片外，所有资源（含 `data/dashboard_data.json`）均需登录
- 环境变量配置：`PE_AUTH_MODE` / `PE_AUTH_PASSWORD` / `PE_AUTH_SECRET` / `PE_AUTH_TTL`
  / `PE_AUTH_MAX_ATTEMPTS` / `PE_AUTH_LOCKOUT` / `PE_AUTH_USERNAME` / `PE_FORCE_SECURE`


### 一键部署脚本（推荐）

仓库内已提供 `deploy.sh` / `update.sh` / `docker-compose.yml` / `.env.example` / `Caddyfile.example`：

```bash
# VPS 上执行一次
git clone git@github.com:MAXRUIHU/MAXRUIHU.github.io.git pe-dashboard
cd pe-dashboard
cp .env.example .env && chmod 600 .env
vi .env            # 设置 PE_AUTH_PASSWORD / PE_AUTH_SECRET
./deploy.sh        # 构建并启动（重复执行 = 拉取最新代码并重建）

# 每周更新（数据已由本地管线生成并推送到仓库后）
./update.sh        # git pull + docker compose restart
```

HTTPS：把 `Caddyfile.example` 里的 `hurui.space` 反向代理到 `127.0.0.1:8000`，
然后到 dnspod 把 `hurui.space` 的 CNAME 从 `maxruihu.github.io` 改为 VPS 地址即可。

### 部署到服务器 / PaaS

**Docker（任意 VPS）**
```bash
docker build -t pe-dashboard .
docker run -d -p 8000:8000 -e PE_AUTH_MODE=session -e PE_AUTH_PASSWORD=你的密码   -e PE_FORCE_SECURE=1 --name pe-dashboard pe-dashboard
```
建议在前面加一层 Nginx/Caddy 反向代理提供 HTTPS（Caddy 自动证书示例）：
```nginx
# Caddyfile
hurui.space {
    reverse_proxy 127.0.0.1:8000
}
```

**Render / Railway**
- 连接本仓库，启动命令 `python3 scripts/serve.py --host 0.0.0.0`（或直接使用 `Procfile`）
- 设置环境变量 `PE_AUTH_MODE=session`、`PE_AUTH_PASSWORD=...`、`PE_FORCE_SECURE=1`
- 平台会分配 HTTPS 域名，再把 `hurui.space`（或子域名如 `app.hurui.space`）CNAME 指过去

**域名切换**
- 到 dnspod（当前 NS）把 `hurui.space` 的 CNAME 从 `maxruihu.github.io` 改为后端地址；
- 或仅将 `app.hurui.space` 指向后端，主站仍保留 GitHub Pages。


## 部署到 GitHub Pages

```bash
git add public/data/dashboard_data.json DATA_QUALITY_REPORT.md
git commit -m "chore: 更新数据"
git push
```

然后在 GitHub 仓库 Settings → Pages 中选择 `main` 分支的 `/public` 目录即可。
页面数据以 `public/data/dashboard_data.json` 为唯一数据源，无需后端即可运行。

## 数据口径说明

- 收益均为**小数**（0.0504 = +5.04%）；网页统一显示为百分比。
- 颜色遵循 A 股习惯：**红涨绿跌**。
- 复利净值 = 以「当周收益」连乘（基期 1.000）；官方净值 = 1 + 报告期「今年收益」。
- 超额（vs 基准）= 净值 / 对应指数净值 − 1，其中
  300指增→沪深300、500指增→中证500、1000指增→中证1000、2000指增→中证2000、
  红利指增→红利指数、全市场选股→中证全指；市场中性/灵活对冲无固定基准，可手动叠加。
