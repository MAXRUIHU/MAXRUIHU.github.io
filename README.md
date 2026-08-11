# 私募量化周刊 · 管理人业绩看板

一个「数据 → 清洗 → 可视化 → 动态更新」的全栈小项目：从每周发布的《量化策略业绩周刊》
Excel 中抽取私募管理人的周度涨跌幅，清洗为连贯的面板数据（自动剔除非交易日/休市周），
并以 Apple 式审美的网页动态呈现，支持与 A 股大盘指数（沪深300 / 中证500 / 中证1000 /
中证2000 / 红利 / 中证全指）同口径对比。

## 目录结构

```
pe-dashboard/
├── public/                    # 前端静态站点（可直接部署 GitHub Pages）
│   ├── index.html
│   ├── css/styles.css
│   ├── js/charts.js           # 零依赖 SVG 图表引擎
│   ├── js/app.js              # SPA（hash 路由）
│   └── data/dashboard_data.json   # 清洗后的最终数据（自动生成）
├── data/
│   └── benchmarks_raw.json    # 指数日线缓存（自动下载）
├── scripts/
│   ├── fetch_benchmarks.py    # 下载 A 股指数日线
│   ├── clean_data.py          # 清洗管线（核心）
│   └── serve.py               # 后端服务：真实鉴权(会话/Basic) + 动态更新 API
├── DATA_QUALITY_REPORT.md     # 每次清洗自动生成的质量报告
└── requirements.txt
```

## 数据清洗管线（scripts/clean_data.py）

针对 29 期周报的异构格式做了系统化处理：

1. **统一异构表头**：7~8 个策略 sheet 列顺序/数量不一，按表头语义 + 值域校验自动映射。
2. **修复错位列**：如 `20260209~0302 灵活对冲` 表头与数据整体错位一列，自动识别并重排。
3. **剔除脏数据**：跳过「均值：百亿 / 平均值:未百亿」汇总行、重复 sheet「市场中性1」、
   空行、极端异常值。
4. **统一管理人身份**：`进化论·500中性` / `进化论|500中性` / `千象混合中性` / `蒙玺·1000`
   等写法统一为 `机构·策略`，缺失后缀按同机构唯一后缀（或众数）补齐。
5. **剔除非交易日**：以报告期为交易周网格——春节等休市周天然缺失、不产生数据点；
   指数日线同样只取交易日，并按周收盘对齐。
6. **构造连贯净值**：官方「今年收益」为主口径，缺失时用「当周收益」复利回填；
   同时输出「复利净值」与「超额净值」供对照。
7. **质量审计**：自动识别疑似净值重构/修正的序列（官方 YTD vs 复利偏差 > 2%），
   输出 `DATA_QUALITY_REPORT.md`。

## 快速开始

```bash
cd pe-dashboard
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 1) 下载指数日线（需联网；已缓存可跳过）
python3 scripts/fetch_benchmarks.py

# 2) 清洗并生成 public/data/dashboard_data.json + DATA_QUALITY_REPORT.md
python3 scripts/clean_data.py

# 3) 本地预览（--watch 监听周报目录，新文件自动重建）
python3 scripts/serve.py --watch
# 打开 http://127.0.0.1:8000/
```

## 每周更新流程

1. 把新一期《量化策略业绩周刊_YYYYMMDD-*.xlsx》放入 `私募周报/`；
2. 运行 `python3 scripts/clean_data.py`（或 `serve.py --watch` 自动触发）；
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
