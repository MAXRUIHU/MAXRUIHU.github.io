/* ============================================================
   app.js — 私募量化周刊看板（SPA，hash 路由，动态加载数据）
   视图：总览 / 策略 / 管理人详情 / A股市场 / 数据质量
   ============================================================ */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const { LineChart, BarChart, Sparkline, fmtPct } = window.Charts;

  /* ---------- 工具 ---------- */
  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const pctCls = v => v == null ? "flat" : (v > 0 ? "up" : (v < 0 ? "down" : "flat"));
  const pctStr = (v, d) => {
    if (v == null) return "—";
    const nd = d == null ? 2 : d;
    return (v > 0 ? "+" : "") + (v * 100).toFixed(nd) + "%";
  };
  const pctSpan = (v, d) => `<span class="pct ${pctCls(v)}">${pctStr(v, d)}</span>`;
  const numStr = (v, d) => v == null ? "—" : Number(v).toFixed(d == null ? 2 : d);

  const WEEK_LABELS = D => (D.meta.weeks || []).map(w => w.label);

  /* ---------- 密码门禁 ---------- */
  const GATE_PASSWORD = "5101";
  const GATE_SESSION_KEY = "pe-gate-unlocked";

  /* ---------- 全局状态 ---------- */
  let DATA = null;        // dashboard_data.json
  let state = { view: "overview", params: {} };

  /* ---------- 数据加载 ---------- */
  async function loadData(force) {
    const url = "data/dashboard_data.json" + (force ? `?t=${Date.now()}` : "");
    const res = await fetch(url);
    if (!res.ok) throw new Error("数据加载失败 " + res.status);
    return await res.json();
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function renderUpdateChip() {
    if (!DATA) return;
    $("#update-text").textContent = "数据更新于 " + (DATA.meta.generated_at || "").slice(0, 16);
    $("#footer-meta").textContent =
      `${DATA.qa.source_files} 期周报 · ${DATA.qa.weeks} 个交易周 · ${DATA.qa.fund_series} 条管理人序列 · ` +
      `${DATA.qa.fund_rows.toLocaleString()} 条记录 · 生成 ${DATA.meta.generated_at}`;
  }

  /* ---------- 路由 ---------- */
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, "");
    const parts = h.split("/").filter(Boolean);
    if (!parts.length) return { view: "overview", params: {} };
    const view = parts[0];
    if (view === "strategy") return { view, params: { name: decodeURIComponent(parts[1] || "") } };
    if (view === "fund") return { view, params: { id: decodeURIComponent(parts[1] || "") } };
    if (view === "market" || view === "qa") return { view, params: {} };
    return { view: "overview", params: {} };
  }

  async function router() {
    state = parseHash();
    $$("#nav-links a").forEach(a => a.classList.toggle("active",
      a.dataset.nav === state.view));
    const app = $("#app");
    app.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
    try {
      if (!DATA) DATA = await loadData(false);
      renderUpdateChip();
      switch (state.view) {
        case "strategy": return renderStrategy(app, state.params.name);
        case "fund": return renderFund(app, state.params.id);
        case "market": return renderMarket(app);
        case "qa": return renderQA(app);
        default: return renderOverview(app);
      }
    } catch (e) {
      console.error(e);
      app.innerHTML = `<div class="empty">数据加载失败：${esc(e.message)}<br><br>
        <button class="icon-btn" style="width:auto;padding:8px 18px;border-radius:10px" onclick="location.reload()">重试</button></div>`;
    }
  }

  /* ============================================================
     总览
     ============================================================ */
  function renderOverview(app) {
    const meta = DATA.meta, qa = DATA.qa;
    const weeks = meta.weeks;
    const last = weeks[weeks.length - 1];
    const bm = DATA.benchmarks;

    // 本周指数快照
    const idxCards = Object.entries(bm).map(([k, b]) => {
      const wk = b.weekly[b.weekly.length - 1];
      const nav = b.nav;
      const spark = nav.slice(-16);
      const id = `spark-${k}`;
      return `<div class="card idx-card" onclick="location.hash='#/market'">
        <div class="name">${esc(b.name)}</div>
        <div class="val ${pctCls(wk)}">${pctStr(wk)}</div>
        <div class="chg ${pctCls(b.ytd_latest)}">今年 ${pctStr(b.ytd_latest)}</div>
        <div class="spark" id="${id}"></div>
      </div>`;
    }).join("");

    // 策略卡
    const stratCards = meta.strategies.map(s => {
      const info = DATA.strategy_summary[s];
      if (!info) return "";
      const benchKey = meta.bench_strategies[s];
      const benchName = benchKey ? (bm[benchKey] ? bm[benchKey].name : "") : "—";
      const lastNav = info.nav_equal_weight[info.nav_equal_weight.length - 1];
      const ytd = lastNav != null ? lastNav - 1 : null;
      const medianW = info.median_weekly[info.median_weekly.length - 1];
      return `<a class="card strategy-card" href="#/strategy/${encodeURIComponent(s)}">
        <span class="arrow">→</span>
        <div class="name">${esc(s)}</div>
        <div class="bench">基准 ${esc(benchName)}</div>
        <div class="big ${pctCls(ytd)}">${pctStr(ytd)}</div>
        <div class="meta">
          <span>本周中位 ${pctStr(medianW)}</span>
          <span>${info.fund_count} 家管理人</span>
        </div>
        <div class="spark" id="spark-strat-${esc(s)}"></div>
      </a>`;
    }).join("");

    // 本周涨跌榜
    const leaders = topWeekly(12);

    app.innerHTML = `
      <section class="page">
        <div class="hero">
          <h1>私募量化策略 · 业绩周刊看板</h1>
          <p class="sub">从 ${qa.source_files} 期《量化策略业绩周刊》中清洗出的连贯面板数据，
            覆盖 ${qa.weeks} 个交易周（已剔除休市周/非交易日），与 A 股大盘指数同口径对比。</p>
          <div class="tag-row">
            <span class="tag">最新一期 ${last.label}</span>
            <span class="tag">${qa.fund_series} 条管理人序列</span>
            <span class="tag">8 大策略</span>
            <span class="tag">6 大指数基准</span>
          </div>
        </div>

        <div class="section-title"><h2>市场快照</h2><span class="muted">周度涨跌幅 · 2026 今年以来</span></div>
        <div class="grid grid-6" id="idx-grid">${idxCards}</div>

        <div class="section-title" style="margin-top:34px"><h2>策略表现</h2><span class="muted">等权净值今年以来 · 点击进入</span></div>
        <div class="grid grid-4" id="strat-grid">${stratCards}</div>

        <div class="grid grid-2" style="margin-top:16px">
          <div class="card card-pad">
            <div class="card-head">
              <div><h3>本周涨幅榜</h3><div class="card-sub">最新一期（${last.label}）当周收益 Top 12</div></div>
            </div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>管理人</th><th>策略</th><th>本周</th><th>今年</th></tr></thead>
                <tbody>${leaders.map(l => `
                  <tr onclick="location.hash='#/fund/${encodeURIComponent(l.id)}'">
                    <td>${esc(l.name)}</td><td>${esc(l.strategy)}</td>
                    <td>${pctSpan(l.latest.weekly)}</td><td>${pctSpan(l.latest.ytd)}</td>
                  </tr>`).join("")}</tbody>
              </table>
            </div>
          </div>
          <div class="card card-pad">
            <div class="card-head">
              <div><h3>本周跌幅榜</h3><div class="card-sub">最新一期当周收益 Bottom 12</div></div>
            </div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>管理人</th><th>策略</th><th>本周</th><th>今年</th></tr></thead>
                <tbody>${leaders.slice(-12).reverse().map(l => `
                  <tr onclick="location.hash='#/fund/${encodeURIComponent(l.id)}'">
                    <td>${esc(l.name)}</td><td>${esc(l.strategy)}</td>
                    <td>${pctSpan(l.latest.weekly)}</td><td>${pctSpan(l.latest.ytd)}</td>
                  </tr>`).join("")}</tbody>
              </table>
            </div>
          </div>
        </div>
      </section>`;

    // 渲染 sparkline
    requestAnimationFrame(() => {
      Object.entries(bm).forEach(([k, b]) => {
        const el = $(`#spark-${k}`);
        if (el) Sparkline(el, b.nav.slice(-16), upDownColor(b.weekly[b.weekly.length - 1]));
      });
      meta.strategies.forEach(s => {
        const el = $(`#spark-strat-${esc(s)}`);
        const info = DATA.strategy_summary[s];
        if (el && info) Sparkline(el, info.nav_equal_weight.slice(-16), "var(--accent)");
      });
    });
  }

  function upDownColor(v) { return v != null && v < 0 ? "var(--down)" : "var(--up)"; }

  function topWeekly(n) {
    const fs = DATA.funds.filter(f => f.latest.weekly != null);
    return fs.slice().sort((a, b) => b.latest.weekly - a.latest.weekly).slice(0, n);
  }

  /* ============================================================
     策略页
     ============================================================ */
  function renderStrategy(app, name) {
    const info = DATA.strategy_summary[name];
    if (!info) return notFound(app, "未找到该策略");
    const meta = DATA.meta;
    const labels = WEEK_LABELS(DATA);
    const benchKey = meta.bench_strategies[name];
    const bench = benchKey ? DATA.benchmarks[benchKey] : null;
    const fs = DATA.funds.filter(f => f.strategy === name);
    const lastNav = info.nav_equal_weight[info.nav_equal_weight.length - 1];
    const ytd = lastNav != null ? lastNav - 1 : null;
    const weekChg = info.mean_weekly[info.mean_weekly.length - 1];

    app.innerHTML = `
      <section class="page">
        <div class="crumb"><a href="#/">总览</a> / <span>策略</span> / <b>${esc(name)}</b></div>
        <div class="detail-head">
          <div>
            <div class="detail-title">${esc(name)}</div>
            <div class="crumb" style="margin-top:6px">
              ${bench ? `基准 <b>${esc(bench.name)}</b> · ${esc(bench.source)}` : "无固定基准（可自行叠加指数）"}
            </div>
          </div>
        </div>

        <div class="kpi-grid" style="margin-bottom:16px">
          <div class="card kpi"><div class="label">管理人数量</div><div class="value">${info.fund_count}</div></div>
          <div class="card kpi"><div class="label">今年等权净值</div><div class="value ${pctCls(ytd)}">${pctStr(ytd)}</div></div>
          <div class="card kpi"><div class="label">本周等权收益</div><div class="value ${pctCls(weekChg)}">${pctStr(weekChg)}</div></div>
          <div class="card kpi"><div class="label">基准今年以来</div><div class="value ${pctCls(bench ? bench.ytd_latest : null)}">${bench ? pctStr(bench.ytd_latest) : "—"}</div></div>
        </div>

        <div class="grid grid-2" style="margin-bottom:16px">
          <div class="card card-pad">
            <div class="card-head">
              <div><h3>等权净值 vs 基准</h3><div class="card-sub">以 2026-01-05 为 1.000</div></div>
            </div>
            <div id="chart-eq"></div>
          </div>
          <div class="card card-pad">
            <div class="card-head">
              <div><h3>周度中位收益</h3><div class="card-sub">管理人当周收益中位数 ${bench ? "vs " + esc(bench.name) : ""}</div></div>
            </div>
            <div id="chart-median"></div>
          </div>
        </div>

        <div class="card" id="fund-table-card">
          <div class="card-pad" style="padding-bottom:0">
            <div class="card-head">
              <div><h3>管理人明细</h3><div class="card-sub">共 ${fs.length} 家 · 点击任意行进入详情</div></div>
            </div>
            <div class="toolbar">
              <label class="search">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
                <input id="fund-search" placeholder="搜索管理人…" />
              </label>
              <select id="scale-filter" class="filter">
                <option value="">全部规模</option><option value="百亿">百亿</option><option value="未百亿">未百亿</option>
              </select>
              <select id="sort-key" class="filter">
                <option value="ytd">按今年收益</option><option value="weekly">按本周收益</option>
                <option value="excess_bench_ytd">按今年超额</option>
                <option value="vol_ann">按年化波动</option><option value="maxdd_chained">按最大回撤</option>
                <option value="sharpe">按夏普</option><option value="win_rate">按胜率</option>
              </select>
            </div>
          </div>
          <div class="table-wrap" style="border-radius:0 0 var(--radius) var(--radius)">
            <table class="data-table" id="fund-table">
              <thead><tr>
                <th data-k="name">管理人</th><th data-k="scale">规模</th>
                <th data-k="weekly">本周</th><th data-k="ytd">今年</th>
                <th data-k="excess_bench_ytd">超额</th><th data-k="ret_1y">近一年</th>
                <th data-k="vol_ann">年化波动</th><th data-k="maxdd_chained">最大回撤</th>
                <th data-k="sharpe">夏普</th><th data-k="calmar">卡玛</th>
                <th data-k="win_rate">胜率</th><th data-k="weeks_present">周数</th>
              </tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </section>`;

    const eqSeries = [
      { name: `${name} 等权`, values: info.nav_equal_weight, color: "#0071e3", area: true },
    ];
    if (bench) eqSeries.push({ name: bench.name, values: bench.nav, color: "#ff9f0a", dash: true });
    new LineChart($("#chart-eq"), { series: eqSeries, labels, height: 300, base: 1 });

    const medSeries = [{ name: "中位收益", values: info.median_weekly, color: "#0071e3" }];
    if (bench) medSeries.push({ name: bench.name + " 周收益", values: bench.weekly, color: "#ff9f0a", dash: true, width: 1.8 });
    new LineChart($("#chart-median"), { series: medSeries, labels, height: 300 });

    // 表格
    const tbody = $("#fund-table tbody");
    let sortKey = "ytd", sortDir = -1, q = "", scale = "";
    const rows = fs.map(f => {
      const st = f.stats, lt = f.latest;
      return {
        id: f.id, name: f.name, strategy: f.strategy,
        scale: f.scale || "", weekly: lt.weekly, ytd: lt.ytd,
        excess_bench_ytd: lt.excess_bench_ytd, ret_1y: lt.ret_1y,
        vol_ann: st.vol_ann, maxdd_chained: st.maxdd_chained,
        sharpe: lt.sharpe != null ? lt.sharpe : st.sharpe_est,
        calmar: lt.calmar, win_rate: st.win_rate, weeks_present: f.weeks_present,
      };
    });
    function drawTable() {
      const fq = q.trim().toLowerCase();
      const list = rows.filter(r =>
        (!fq || r.name.toLowerCase().includes(fq)) &&
        (!scale || r.scale === scale));
      const sk = sortKey === "name" ? "name" : sortKey;
      list.sort((a, b) => {
        const av = a[sk], bv = b[sk];
        if (sk === "name") return av.localeCompare(bv, "zh") * sortDir;
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return (av - bv) * sortDir;
      });
      tbody.innerHTML = list.map(r => `
        <tr onclick="location.hash='#/fund/${encodeURIComponent(r.id)}'">
          <td>${esc(r.name)}</td>
          <td>${r.scale ? `<span class="pill pill-scale">${esc(r.scale)}</span>` : "—"}</td>
          <td>${pctSpan(r.weekly)}</td>
          <td>${pctSpan(r.ytd)}</td>
          <td>${pctSpan(r.excess_bench_ytd)}</td>
          <td>${pctSpan(r.ret_1y)}</td>
          <td>${numStr(r.vol_ann != null ? r.vol_ann * 100 : null, 1) + (r.vol_ann != null ? "%" : "")}</td>
          <td>${pctSpan(r.maxdd_chained)}</td>
          <td>${numStr(r.sharpe)}</td>
          <td>${numStr(r.calmar)}</td>
          <td>${r.win_rate != null ? (r.win_rate * 100).toFixed(0) + "%" : "—"}</td>
          <td>${r.weeks_present}</td>
        </tr>`).join("") ||
        `<tr><td colspan="12" class="empty" style="padding:30px">无匹配管理人</td></tr>`;
      const rowsCount = $(".table-wrap", $("#fund-table-card")).querySelector("tbody tr td") ?
        (tbody.querySelector("tr td.empty") ? 0 : list.length) : list.length;
      $(".card-sub", $("#fund-table-card")).textContent =
        `共 ${fs.length} 家 · 筛选 ${list.length} 家 · 点击任意行进入详情`;
    }
    $("#fund-search").addEventListener("input", e => { q = e.target.value; drawTable(); });
    $("#scale-filter").addEventListener("change", e => { scale = e.target.value; drawTable(); });
    $("#sort-key").addEventListener("change", e => {
      const k = e.target.value; if (k === sortKey) sortDir *= -1; else { sortKey = k; sortDir = k === "name" ? 1 : -1; }
      drawTable();
    });
    $$("#fund-table th").forEach(th => th.addEventListener("click", () => {
      const k = th.dataset.k; if (!k) return;
      if (k === sortKey) sortDir *= -1; else { sortKey = k; sortDir = k === "name" || k === "scale" ? 1 : -1; }
      drawTable();
    }));
    drawTable();
  }

  /* ============================================================
     管理人详情
     ============================================================ */
  function renderFund(app, id) {
    const f = DATA.funds.find(x => x.id === decodeURIComponent(id));
    if (!f) return notFound(app, "未找到该管理人");
    const labels = WEEK_LABELS(DATA);
    const meta = DATA.meta;
    const benchKey = meta.bench_strategies[f.strategy];
    const defaultBench = f.bench_key || (benchKey && DATA.benchmarks[benchKey] ? benchKey : Object.keys(DATA.benchmarks)[0]);
    const st = f.stats, lt = f.latest;

    app.innerHTML = `
      <section class="page">
        <div class="crumb">
          <a href="#/">总览</a> / <a href="#/strategy/${encodeURIComponent(f.strategy)}">${esc(f.strategy)}</a> / <b>${esc(f.name)}</b>
        </div>
        <div class="detail-head">
          <div>
            <div class="detail-title">
              ${esc(f.name)}
              ${f.scale ? `<span class="pill pill-scale">${esc(f.scale)}</span>` : ""}
            </div>
            <div class="crumb" style="margin-top:8px">
              ${esc(f.strategy)} · 覆盖 ${f.weeks_present} 个交易周（第 ${f.first_week + 1}–${f.last_week + 1} 周）
            </div>
          </div>
        </div>

        <div class="kpi-grid" style="margin-bottom:16px">
          <div class="card kpi"><div class="label">今年收益</div><div class="value ${pctCls(lt.ytd)}">${pctStr(lt.ytd)}</div><div class="hint">官方口径</div></div>
          <div class="card kpi"><div class="label">本周收益</div><div class="value ${pctCls(lt.weekly)}">${pctStr(lt.weekly)}</div><div class="hint">最新一期</div></div>
          <div class="card kpi"><div class="label">今年超额</div><div class="value ${pctCls(lt.excess_bench_ytd)}">${pctStr(lt.excess_bench_ytd)}</div><div class="hint">vs 策略基准</div></div>
          <div class="card kpi"><div class="label">近一年收益</div><div class="value ${pctCls(lt.ret_1y)}">${pctStr(lt.ret_1y)}</div></div>
          <div class="card kpi"><div class="label">年化波动</div><div class="value">${numStr(st.vol_ann != null ? st.vol_ann * 100 : null, 1) + (st.vol_ann != null ? "%" : "")}</div><div class="hint">由周收益估算</div></div>
          <div class="card kpi"><div class="label">最大回撤</div><div class="value down">${pctStr(st.maxdd_chained)}</div><div class="hint">复利净值口径</div></div>
          <div class="card kpi"><div class="label">夏普 / 卡玛</div><div class="value">${numStr(lt.sharpe != null ? lt.sharpe : st.sharpe_est)} / ${numStr(lt.calmar)}</div></div>
          <div class="card kpi"><div class="label">周胜率</div><div class="value">${st.win_rate != null ? (st.win_rate * 100).toFixed(0) + "%" : "—"}</div><div class="hint">最佳 ${pctStr(st.best_week)} · 最差 ${pctStr(st.worst_week)}</div></div>
        </div>

        <div class="grid grid-2" style="margin-bottom:16px">
          <div class="card card-pad">
            <div class="card-head">
              <div><h3>累计净值</h3><div class="card-sub" id="nav-sub">官方今年收益口径 · 基期 1.000</div></div>
              <div class="seg" id="nav-mode">
                <button data-m="official" class="active">官方</button>
                <button data-m="chained">复利</button>
              </div>
            </div>
            <div class="toolbar" style="margin-bottom:0">
              <select id="bench-select" class="filter">
                ${Object.entries(DATA.benchmarks).map(([k, b]) =>
                  `<option value="${k}" ${k === defaultBench ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
                <option value="">不叠加基准</option>
              </select>
            </div>
            <div id="chart-nav" style="margin-top:6px"></div>
          </div>
          <div class="card card-pad">
            <div class="card-head"><div><h3>周度收益</h3><div class="card-sub">与所选基准对比</div></div></div>
            <div id="chart-weekly"></div>
          </div>
        </div>

        <div class="grid grid-2">
          <div class="card card-pad">
            <div class="card-head"><div><h3>相对基准累计超额</h3><div class="card-sub">净值 / 基准净值 − 1</div></div></div>
            <div id="chart-excess"></div>
          </div>
          <div class="card card-pad">
            <div class="card-head"><div><h3>相关性（报告口径）</h3><div class="card-sub">与各大指数周收益的相关性</div></div></div>
            <div id="corr-chart"></div>
          </div>
        </div>
      </section>`;

    const modeBtns = $$("#nav-mode button");
    let navMode = "official";
    function drawNav() {
      const benchKey2 = $("#bench-select").value;
      const bench = benchKey2 ? DATA.benchmarks[benchKey2] : null;
      const navVals = navMode === "official" ? f.series.nav_official : f.series.nav_chained;
      const series = [{ name: f.name + (navMode === "official" ? "（官方）" : "（复利）"), values: navVals, color: "#0071e3", area: true }];
      if (bench) series.push({ name: bench.name, values: bench.nav, color: "#ff9f0a", dash: true });
      new LineChart($("#chart-nav"), { series, labels, height: 310, base: 1 });
      $("#nav-sub").textContent = navMode === "official" ? "官方今年收益口径 · 基期 1.000" : "当周收益复利口径 · 基期 1.000";
    }
    modeBtns.forEach(b => b.addEventListener("click", () => {
      modeBtns.forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      navMode = b.dataset.m;
      drawNav();
    }));
    $("#bench-select").addEventListener("change", drawNav);
    drawNav();

    // 周度收益柱状
    const weeklySeries = [{ name: f.name + " 周收益", values: f.series.weekly, color: "#0071e3" }];
    new BarChart($("#chart-weekly"), { values: f.series.weekly, labels, height: 310 });

    // 超额
    const ex = f.series.nav_excess_bench || f.series.nav_excess;
    new LineChart($("#chart-excess"), {
      series: [{ name: "累计超额", values: ex, color: "#bf5af2", area: true }],
      labels, height: 300, base: 0,
    });

    // 相关性
    const corrLabels = ["300", "500", "1000", "2000", "最小市值"];
    const corrVals = lt.corr || [null, null, null, null, null];
    $("#corr-chart").innerHTML = `<div style="display:flex;flex-direction:column;gap:12px;padding-top:8px">
      ${corrLabels.map((cl, i) => {
        const v = corrVals[i];
        const pct = v == null ? 0 : Math.abs(v);
        const color = v == null ? "var(--border)" : (v >= 0 ? "var(--accent)" : "var(--down)");
        return `<div style="display:grid;grid-template-columns:64px 1fr 52px;align-items:center;gap:10px;font-size:12px">
          <span style="color:var(--text-2)">${cl}</span>
          <div style="height:8px;border-radius:4px;background:var(--border);overflow:hidden">
            <div style="width:${(pct * 100).toFixed(0)}%;height:100%;border-radius:4px;background:${color}"></div>
          </div>
          <span style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${v == null ? "—" : v.toFixed(2)}</span>
        </div>`;
      }).join("")}
    </div>`;
  }

  /* ============================================================
     A股市场页
     ============================================================ */
  function renderMarket(app) {
    const labels = WEEK_LABELS(DATA);
    const bm = DATA.benchmarks;
    app.innerHTML = `
      <section class="page">
        <div class="crumb"><a href="#/">总览</a> / <span>A股市场</span></div>
        <div class="hero" style="padding-bottom:14px">
          <h1>A 股大盘 · 周度对比</h1>
          <p class="sub">六大指数以 2026-01-05 为基期归一化，与私募策略同周网格对齐（剔除非交易日）。</p>
        </div>

        <div class="card card-pad" style="margin-bottom:16px">
          <div class="card-head"><div><h3>指数累计净值</h3><div class="card-sub">基期 1.000</div></div></div>
          <div id="chart-idx"></div>
        </div>

        <div class="grid grid-2" style="margin-bottom:16px">
          <div class="card card-pad">
            <div class="card-head"><div><h3>指数周度收益</h3><div class="card-sub">选择下方指数查看</div></div></div>
            <div class="toolbar" style="margin-bottom:0">
              <select id="idx-select" class="filter">
                ${Object.entries(bm).map(([k, b]) => `<option value="${k}">${esc(b.name)}</option>`).join("")}
              </select>
            </div>
            <div id="chart-idx-weekly" style="margin-top:6px"></div>
          </div>
          <div class="card card-pad">
            <div class="card-head"><div><h3>指数一览</h3><div class="card-sub">最新一期 & 今年以来</div></div></div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>指数</th><th>本周</th><th>今年</th><th>近4周</th><th>波动</th></tr></thead>
                <tbody>
                  ${Object.entries(bm).map(([k, b]) => {
                    const wk = b.weekly[b.weekly.length - 1];
                    const last4 = b.weekly.slice(-4).filter(x => x != null);
                    const vol = last4.length > 1 ? Math.sqrt(last4.reduce((s, x) => s + x * x, 0) / (last4.length - 1) - (last4.reduce((a, b2) => a + b2, 0) / last4.length) ** 2) * Math.sqrt(52) : null;
                    return `<tr onclick="$('#idx-select').value='${k}';renderMarketWeekly('${k}')">
                      <td>${esc(b.name)}</td><td>${pctSpan(wk)}</td><td>${pctSpan(b.ytd_latest)}</td>
                      <td>${pctSpan(last4.length === 4 ? last4.reduce((a, x) => a * (1 + x), 1) - 1 : null)}</td>
                      <td>${vol != null ? (vol * 100).toFixed(1) + "%" : "—"}</td>
                    </tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>`;

    const series = Object.entries(bm).map(([k, b], i) => ({
      name: b.name, values: b.nav, color: window.Charts.COLORS[i % window.Charts.COLORS.length], width: 2,
    }));
    new LineChart($("#chart-idx"), { series, labels, height: 360, base: 1 });

    window.renderMarketWeekly = function (k) {
      const b = bm[k];
      new BarChart($("#chart-idx-weekly"), { values: b.weekly, labels, height: 300 });
    };
    renderMarketWeekly(Object.keys(bm)[0]);
    $("#idx-select").addEventListener("change", e => renderMarketWeekly(e.target.value));
  }

  /* ============================================================
     数据质量页
     ============================================================ */
  function renderQA(app) {
    const qa = DATA.qa;
    const benchCount = Object.keys(DATA.benchmarks).length;
    const typeNames = {
      dropped_sheet: "剔除重复 sheet", unknown_sheet: "未知 sheet", no_period: "无法解析报告期",
      suffix_inferred: "补齐策略后缀", suffix_missing: "后缀缺失", extreme_weekly: "异常周收益",
      extreme_ytd: "异常今年收益", benchmark_empty: "基准无数据", benchmark_no_base: "基准无基期",
      benchmark_gap: "基准缺口",
    };
    app.innerHTML = `
      <section class="page">
        <div class="crumb"><a href="#/">总览</a> / <span>数据质量</span></div>
        <div class="hero" style="padding-bottom:14px">
          <h1>数据质量报告</h1>
          <p class="sub">每次运行清洗管线都会重新审计源数据：缺失值、错位列修复、身份补齐、净值重构识别等。</p>
        </div>

        <div class="kpi-grid" style="margin-bottom:16px">
          <div class="card kpi"><div class="label">源文件</div><div class="value">${qa.source_files}</div><div class="hint">xlsx 周刊</div></div>
          <div class="card kpi"><div class="label">交易周</div><div class="value">${qa.weeks}</div><div class="hint">剔除非交易日</div></div>
          <div class="card kpi"><div class="label">记录行</div><div class="value">${qa.fund_rows.toLocaleString()}</div></div>
          <div class="card kpi"><div class="label">管理人序列</div><div class="value">${qa.fund_series}</div></div>
          <div class="card kpi"><div class="label">缺失周收益</div><div class="value ${qa.missing_weekly_rows ? "down" : ""}">${qa.missing_weekly_rows}</div><div class="hint">已由官方YTD回填</div></div>
          <div class="card kpi"><div class="label">缺失今年收益</div><div class="value ${qa.missing_ytd_rows ? "down" : ""}">${qa.missing_ytd_rows}</div></div>
          <div class="card kpi"><div class="label">疑似重构</div><div class="value ${qa.restated_series.length ? "down" : ""}">${qa.restated_series.length}</div><div class="hint">官方YTD vs 复利偏差>2%</div></div>
          <div class="card kpi"><div class="label">基准指数</div><div class="value">${benchCount}</div></div>
        </div>

        <div class="grid grid-2">
          <div class="card card-pad qa-block">
            <div class="card-head"><div><h3>疑似净值重构 / 修正序列</h3><div class="card-sub">官方今年收益与当周收益复利差异较大，多为源数据中途修正或产品切换</div></div></div>
            <ul class="qa-list">
              ${qa.restated_series.slice(0, 30).map(r => `
                <li><span class="qa-tag">重构</span>
                  <span>${esc(r.strategy)} <b>${esc(r.fund)}</b></span>
                  <span style="margin-left:auto">官方 ${pctStr(r.official)} vs 复利 ${pctStr(r.chained)}</span>
                </li>`).join("") || "<li class='muted'>无</li>"}
              ${qa.restated_series.length > 30 ? `<li class="muted">…共 ${qa.restated_series.length} 条，完整列表见 DATA_QUALITY_REPORT.md</li>` : ""}
            </ul>
          </div>
          <div class="card card-pad qa-block">
            <div class="card-head"><div><h3>清洗处理记录</h3><div class="card-sub">${qa.notes.length} 条自动处理</div></div></div>
            <ul class="qa-list">
              ${qa.notes.slice(0, 40).map(n => `
                <li><span class="qa-tag">${esc(typeNames[n.type] || n.type)}</span>
                  <span>${esc(n.file || "")} ${esc(n.sheet || "")} ${esc(n.detail)}</span>
                </li>`).join("") || "<li class='muted'>无</li>"}
            </ul>
          </div>
        </div>
      </section>`;
  }

  function notFound(app, msg) {
    app.innerHTML = `<div class="empty">${esc(msg)}<br><br><a href="#/" style="color:var(--accent)">返回总览</a></div>`;
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $("#refresh-btn").addEventListener("click", async () => {
      try {
        DATA = await loadData(true);
        renderUpdateChip();
        router();
        toast("数据已刷新：" + DATA.meta.generated_at);
      } catch (e) {
        toast("刷新失败：" + e.message);
      }
    });
    $("#theme-btn").addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("pe-theme", next); } catch (e) {}
    });
    window.addEventListener("hashchange", router);
    // 自动刷新（每 10 分钟重新拉取 JSON，动态更新）
    setInterval(() => { if (document.visibilityState === "visible") loadData(true).then(d => { DATA = d; renderUpdateChip(); }).catch(() => {}); }, 10 * 60 * 1000);
  }

  function initGate() {
    const gate = $("#gate");
    if (!gate) return;
    // 若由服务端鉴权承载（serve.py 注入 <meta name="pe-auth">），跳过客户端弹窗
    if (document.querySelector('meta[name="pe-auth"]')) {
      gate.remove();
      return;
    }
    // 本会话已解锁则直接放行
    try {
      if (sessionStorage.getItem(GATE_SESSION_KEY) === "1") {
        gate.classList.add("hidden");
        return;
      }
    } catch (e) { /* 忽略 */ }

    const input = $("#gate-pwd");
    const btn = $("#gate-btn");
    const err = $("#gate-error");
    const qr = $("#gate-qr");

    function unlock() {
      try { sessionStorage.setItem(GATE_SESSION_KEY, "1"); } catch (e) {}
      gate.classList.add("hidden");
      input.value = "";
      setTimeout(() => gate.remove(), 600);
    }
    function deny() {
      gate.classList.remove("shake");
      void gate.offsetWidth;               // 重启动画
      gate.classList.add("shake");
      err.textContent = "密码错误，请重新输入";
      qr.hidden = false;                   // 弹出微信二维码
      input.value = "";
      input.focus();
    }
    function submit() {
      if (input.value.trim() === GATE_PASSWORD) unlock();
      else deny();
    }
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
    input.focus();
  }

  async function init() {
    try { const t = localStorage.getItem("pe-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
    initGate();
    bind();
    router();
  }

  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();
