/* ============================================================
   app.js — 私募量化周刊看板 v2
   特性：全局时间筛选 / 管理人筛选与对比 / 区间统计 / 数据质量标记
   ============================================================ */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
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

  /* ---------- 全局状态 ---------- */
  let DATA = null;
  const state = {
    view: "overview", params: {},
    period: { start: 0, end: 28 },     // 周索引区间（时间筛选）
    managers: new Set(),               // 机构名集合（管理人筛选）
    minWeeks: 4,                       // 最低在录周数（默认过滤过短期序列）
  };

  /* ---------- 数据加载 ---------- */
  async function loadData(force) {
    const res = await fetch("data/dashboard_data.json" + (force ? `?t=${Date.now()}` : ""));
    if (!res.ok) throw new Error("数据加载失败 " + res.status);
    return await res.json();
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove("show"), 2600);
  }

  const WEEK_LABELS = () => (DATA.meta.weeks || []).map(w => w.label);

  /* ---------- 区间计算 ---------- */
  const sl = (v, p) => v.slice(p.start, p.end + 1);
  const sLabels = () => sl(WEEK_LABELS(), state.period);
  const sIdx = () => Array.from({ length: state.period.end - state.period.start + 1 },
                                (_, i) => state.period.start + i);

  function chainReturn(weekly, p) {
    let cum = 1, n = 0;
    for (let i = p.start; i <= p.end; i++) if (weekly[i] != null) { cum *= (1 + weekly[i]); n++; }
    return n ? cum - 1 : null;
  }
  function periodVol(weekly, p) {
    const vals = [];
    for (let i = p.start; i <= p.end; i++) if (weekly[i] != null) vals.push(weekly[i]);
    if (vals.length < 2) return null;
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length - 1);
    return Math.sqrt(v * 52);
  }
  function periodMaxDD(nav, p) {
    let peak = -Infinity, mdd = 0;
    for (let i = p.start; i <= p.end; i++) {
      const x = nav[i];
      if (x == null) continue;
      peak = Math.max(peak, x);
      mdd = Math.min(mdd, x / peak - 1);
    }
    return isFinite(mdd) ? mdd : null;
  }
  function rebase(vals, p) {
    let base = null;
    for (let i = p.start; i <= p.end; i++) if (vals[i] != null) { base = vals[i]; break; }
    if (base == null) return [];
    return vals.map((v, i) => (i < p.start || i > p.end || v == null) ? null : v / base - 1);
  }
  function periodExcess(fund, p, benchKey) {
    // 优先用源数据「区间超额收益」复利口径；缺失时退回 净值/基准
    const wex = fund.series.weekly_ex;
    if (wex && wex.some(v => v != null)) return chainReturn(wex, p);
    const fnav = fund.series.nav_chained, b = DATA.benchmarks[benchKey];
    if (!b) return null;
    const bnav = b.nav;
    let fbase = null, bbase = null;
    for (let i = p.start; i <= p.end; i++) {
      if (fnav[i] != null && fbase == null) fbase = fnav[i];
      if (bnav[i] != null && bbase == null) bbase = bnav[i];
    }
    if (!fbase || !bbase) return null;
    let fe = null, be = null;
    for (let i = p.start; i <= p.end; i++) {
      if (fnav[i] != null) fe = fnav[i];
      if (bnav[i] != null) be = bnav[i];
    }
    return fe && be ? fe / fbase / (be / bbase) - 1 : null;
  }

  /* 管理人筛选 */
  const fundPass = f => (state.managers.size === 0 || state.managers.has(f.institution))
    && f.weeks_present >= state.minWeeks;

  /* ---------- 路由 ---------- */
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, "");
    const parts = h.split("/").filter(Boolean);
    if (!parts.length) return { view: "overview", params: {} };
    const v = parts[0];
    if (v === "strategy") return { view: v, params: { name: decodeURIComponent(parts[1] || "") } };
    if (v === "fund") return { view: v, params: { id: decodeURIComponent(parts[1] || "") } };
    if (["market", "qa", "compare"].includes(v)) return { view: v, params: {} };
    return { view: "overview", params: {} };
  }

  async function router() {
    Object.assign(state, parseHash());
    $$("#nav-links a").forEach(a => a.classList.toggle("active", a.dataset.nav === state.view));
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
        case "compare": return renderCompare(app);
        default: return renderOverview(app);
      }
    } catch (e) {
      console.error(e);
      app.innerHTML = `<div class="empty">数据加载失败：${esc(e.message)}<br><br>
        <button class="icon-btn" style="width:auto;padding:8px 18px;border-radius:10px" onclick="location.reload()">重试</button></div>`;
    }
  }

  /* ============================================================
     全局筛选栏（时间 / 管理人 / 最低周数）
     ============================================================ */
  function filterBar() {
    const p = state.period;
    const total = DATA.meta.weeks.length;
    const presets = [
      { label: "全部", s: 0, e: total - 1 },
      { label: "近4周", s: total - 4, e: total - 1 },
      { label: "近8周", s: total - 8, e: total - 1 },
      { label: "近12周", s: total - 12, e: total - 1 },
      { label: "近20周", s: total - 20, e: total - 1 },
    ];
    const activePreset = presets.find(x => x.s === p.start && x.e === p.end);

    const allInsts = [...new Set(DATA.funds.map(f => f.institution))].sort((a, b) => a.localeCompare(b, "zh"));
    const mgrChips = [...state.managers].map(m =>
      `<span class="chip">${esc(m)}<button class="chip-x" data-mgr="${esc(m)}" title="移除">×</button></span>`).join("");

    const html = `
      <div class="filterbar card">
        <div class="fb-group">
          <span class="fb-label">时间</span>
          <div class="seg fb-seg" id="fb-presets">
            ${presets.map(x => `<button data-s="${x.s}" data-e="${x.e}" class="${activePreset && activePreset.label === x.label ? "active" : ""}">${x.label}</button>`).join("")}
          </div>
          <select id="fb-start" class="filter">
            ${DATA.meta.weeks.map((w, i) => `<option value="${i}" ${i === p.start ? "selected" : ""}>${esc(w.label)} 起</option>`).join("")}
          </select>
          <span class="fb-sep">至</span>
          <select id="fb-end" class="filter">
            ${DATA.meta.weeks.map((w, i) => `<option value="${i}" ${i === p.end ? "selected" : ""}>${esc(w.label)} 止</option>`).join("")}
          </select>
        </div>
        <div class="fb-group">
          <span class="fb-label">管理人</span>
          <input id="fb-mgr" class="filter fb-input" list="fb-mgr-list" placeholder="输入机构名后回车添加…" />
          <datalist id="fb-mgr-list">${allInsts.map(x => `<option value="${esc(x)}">`).join("")}</datalist>
          <div class="fb-chips" id="fb-chips">${mgrChips}</div>
          ${state.managers.size ? `<button class="chip-x fb-clear" id="fb-clear">清除</button>` : ""}
          ${state.managers.size >= 2 ? `<a class="filter fb-compare" href="#/compare">对比所选 →</a>` : ""}
        </div>
        <div class="fb-group">
          <span class="fb-label">在录</span>
          <select id="fb-weeks" class="filter">
            <option value="0" ${state.minWeeks === 0 ? "selected" : ""}>全部</option>
            <option value="4" ${state.minWeeks === 4 ? "selected" : ""}>≥4周</option>
            <option value="12" ${state.minWeeks === 12 ? "selected" : ""}>≥12周</option>
            <option value="29" ${state.minWeeks === 29 ? "selected" : ""}>满29周</option>
          </select>
        </div>
      </div>`;
    return html;
  }

  function bindFilterBar(host) {
    const p = state.period;
    $$("#fb-presets button", host).forEach(b => b.addEventListener("click", () => {
      state.period = { start: +b.dataset.s, end: +b.dataset.e };
      router();
    }));
    const start = $("#fb-start", host), end = $("#fb-end", host);
    start.addEventListener("change", () => {
      state.period.start = Math.min(+start.value, state.period.end);
      router();
    });
    end.addEventListener("change", () => {
      state.period.end = Math.max(+end.value, state.period.start);
      router();
    });
    const mgr = $("#fb-mgr", host);
    mgr.addEventListener("keydown", e => {
      if (e.key === "Enter" && mgr.value.trim()) {
        state.managers.add(mgr.value.trim());
        mgr.value = "";
        router();
      }
    });
    const chips = $("#fb-chips", host);
    if (chips) chips.addEventListener("click", e => {
      const btn = e.target.closest(".chip-x");
      if (btn && btn.dataset.mgr) { state.managers.delete(btn.dataset.mgr); router(); }
    });
    const clear = $("#fb-clear", host);
    if (clear) clear.addEventListener("click", () => { state.managers.clear(); router(); });
    const wk = $("#fb-weeks", host);
    wk.addEventListener("change", () => { state.minWeeks = +wk.value; router(); });
  }

  /* ============================================================
     总览
     ============================================================ */
  function renderOverview(app) {
    const meta = DATA.meta, qa = DATA.qa;
    const p = state.period;
    const weeks = meta.weeks;
    const last = weeks[weeks.length - 1];
    const bm = DATA.benchmarks;
    const filtered = DATA.funds.filter(fundPass);
    const nManagers = new Set(filtered.map(f => f.institution)).size;

    const idxCards = Object.entries(bm).map(([k, b]) => {
      const ret = chainReturn(b.weekly, p);
      return `<div class="card idx-card" onclick="location.hash='#/market'">
        <div class="name">${esc(b.name)}</div>
        <div class="val ${pctCls(ret)}">${pctStr(ret)}</div>
        <div class="chg ${pctCls(b.ytd_latest)}">今年 ${pctStr(b.ytd_latest)}</div>
        <div class="spark" id="spark-${k}"></div>
      </div>`;
    }).join("");

    const stratCards = meta.strategies.map((s, si) => {
      const info = DATA.strategy_summary[s];
      if (!info) return "";
      const benchKey = meta.bench_strategies[s];
      const benchName = benchKey && bm[benchKey] ? bm[benchKey].name : "—";
      const fs = filtered.filter(f => f.strategy === s);
      const ret = chainReturn(info.mean_weekly, p);
      const fsRet = fs.length ? chainReturn(info.mean_weekly, p) : null;
      return `<a class="card strategy-card" href="#/strategy/${encodeURIComponent(s)}">
        <span class="arrow">→</span>
        <div class="name">${esc(s)}</div>
        <div class="bench">基准 ${esc(benchName)}</div>
        <div class="big ${pctCls(fsRet)}">${pctStr(fsRet)}</div>
        <div class="meta">
          <span>${pctStr(fs.length ? info.median_weekly[last_week_idx(info)] : null, 2)}</span>
          <span>${fs.length} 家${state.managers.size ? "（已筛）" : ""}</span>
        </div>
        <div class="spark" id="spark-strat-${si}"></div>
      </a>`;
    }).join("");

    function last_week_idx(info) { return Math.max(p.start, Math.min(p.end, info.mean_weekly.length - 1)); }

    app.innerHTML = `
      <section class="page">
        <div class="hero">
          <h1>私募量化策略 · 业绩周刊看板</h1>
          <p class="sub">${qa.source_files} 期周报 · ${qa.weeks} 个交易周（已剔除休市周）· ${qa.fund_series} 条管理人序列。
            ${state.managers.size ? `当前筛选 ${nManagers} 家管理人` : ""}</p>
          <div class="tag-row">
            <span class="tag">最新一期 ${last.label}</span>
            <span class="tag">区间 ${weeks[p.start].label} ~ ${weeks[p.end].label}</span>
            <span class="tag">${state.managers.size ? state.managers.size + " 家管理人" : qa.fund_series + " 条序列"}</span>
          </div>
        </div>

        ${filterBar()}

        <div class="section-title"><h2>市场快照</h2><span class="muted">区间涨跌幅 · 点击进入市场页</span></div>
        <div class="grid grid-4 idx-grid" style="margin-top:12px">${idxCards}</div>

        <div class="section-title" style="margin-top:34px"><h2>策略表现</h2><span class="muted">区间等权收益 · 点击进入</span></div>
        <div class="grid grid-4" style="margin-top:12px">${stratCards}</div>

      </section>`;

    bindFilterBar(app);
    requestAnimationFrame(() => {
      Object.entries(bm).forEach(([k, b]) => {
        const el = $(`#spark-${k}`);
        if (el) Sparkline(el, sl(b.nav, p), upDownColor(chainReturn(b.weekly, p)));
      });
      meta.strategies.forEach((s, si) => {
        const el = document.getElementById(`spark-strat-${si}`);
        const info = DATA.strategy_summary[s];
        if (el && info) Sparkline(el, sl(info.nav_equal_weight, p), "var(--accent)");
      });
    });
  }

  function emptyRow(n) { return `<tr><td colspan="${n}" class="empty" style="padding:26px">无数据</td></tr>`; }
  function upDownColor(v) { return v != null && v < 0 ? "var(--down)" : "var(--up)"; }
  function badge(f) {
    const n = DATA.meta.weeks.length;
    const parts = [];
    if (f.ytd_unreliable) parts.push(`<span class="pill pill-amber" title="源数据该序列存在 YTD 与区间收益不符的周（已自动剔除异常周，官方口径回退复利）">YTD异常</span>`);
    if (f.restated) parts.push(`<span class="pill pill-warn" title="官方 YTD 与复利偏差>2%">修正</span>`);
    if (f.incomplete) parts.push(`<span class="pill pill-soft" title="该序列存在缺周">${f.weeks_present}/${n}周</span>`);
    return parts.length ? " " + parts.join(" ") : "";
  }


  /* ============================================================
     策略页
     ============================================================ */
  function renderStrategy(app, name) {
    const info = DATA.strategy_summary[name];
    if (!info) return notFound(app, "未找到该策略");
    const meta = DATA.meta, p = state.period;
    const labels = sLabels();
    const benchKey = meta.bench_strategies[name];
    const bench = benchKey ? DATA.benchmarks[benchKey] : null;
    const fs = DATA.funds.filter(f => f.strategy === name && fundPass(f));
    const benchRet = bench ? chainReturn(bench.weekly, p) : null;
    const eqRet = chainReturn(info.mean_weekly, p);

    app.innerHTML = `
      <section class="page">
        <div class="crumb"><a href="#/">总览</a> / <span>策略</span> / <b>${esc(name)}</b></div>
        <div class="detail-head">
          <div>
            <div class="detail-title">${esc(name)}${state.managers.size ? ` <span class="pill pill-accent">已筛 ${state.managers.size} 家</span>` : ""}</div>
            <div class="crumb" style="margin-top:6px">${bench ? `基准 <b>${esc(bench.name)}</b> · ${esc(bench.source)}` : "无固定基准"}</div>
          </div>
        </div>

        ${filterBar()}

        <div class="kpi-grid" style="margin:14px 0 16px">
          <div class="card kpi"><div class="label">管理人数量</div><div class="value">${fs.length}<span class="hint" style="font-size:12px;margin-left:4px">/ ${info.fund_count}</span></div></div>
          <div class="card kpi"><div class="label">区间等权收益</div><div class="value ${pctCls(eqRet)}">${pctStr(eqRet)}</div><div class="hint">${meta.weeks[p.start].label}~${meta.weeks[p.end].label}</div></div>
          <div class="card kpi"><div class="label">本周等权收益</div><div class="value ${pctCls(info.mean_weekly[p.end])}">${pctStr(info.mean_weekly[p.end])}</div></div>
          <div class="card kpi"><div class="label">基准区间收益</div><div class="value ${pctCls(benchRet)}">${pctStr(benchRet)}</div></div>
        </div>

        <div class="grid grid-2" style="margin-bottom:16px">
          <div class="card card-pad">
            <div class="card-head"><div><h3>等权净值 vs 基准</h3><div class="card-sub">区间起点归一为 0% ${fs.length !== info.fund_count ? "（已按筛选管理人重算）" : ""}</div></div></div>
            <div id="chart-eq"></div>
          </div>
          <div class="card card-pad">
            <div class="card-head"><div><h3>周度中位收益</h3><div class="card-sub">管理人当周收益中位数 ${bench ? "vs " + esc(bench.name) : ""}</div></div></div>
            <div id="chart-median"></div>
          </div>
        </div>

        <div class="card" id="fund-table-card">
          <div class="card-pad" style="padding-bottom:0">
            <div class="card-head">
              <div><h3>管理人明细</h3><div class="card-sub" id="strategy-sub">共 ${fs.length} 家 · 点击行进入详情</div></div>
            </div>
            <div class="toolbar">
              <label class="search">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
                <input id="fund-search" placeholder="搜索管理人…" />
              </label>
              <select id="scale-filter" class="filter"><option value="">全部规模</option><option value="百亿">百亿</option><option value="未百亿">未百亿</option></select>
              <select id="sort-key" class="filter">
                <option value="ret">按区间收益</option><option value="ret_ann_geom">按年化收益</option><option value="ytd">按今年收益</option>
                <option value="weekly">按本周收益</option><option value="excess">按区间超额</option>
                <option value="vol">按区间波动</option><option value="mdd">按区间回撤</option>
                <option value="sharpe">按夏普</option><option value="win_rate">按胜率</option>
              </select>
            </div>
          </div>
          <div class="table-wrap" style="border-radius:0 0 var(--radius) var(--radius)">
            <table class="data-table" id="fund-table">
              <thead><tr>
                <th data-k="name">管理人</th><th data-k="scale">规模</th>
                <th data-k="ret">区间</th><th data-k="ret_ann_geom">年化</th><th data-k="ytd">今年</th><th data-k="weekly">本周</th>
                <th data-k="excess">区间超额</th><th data-k="ret_1y">近一年</th>
                <th data-k="vol">区间波动</th><th data-k="mdd">区间回撤</th>
                <th data-k="sharpe">夏普</th><th data-k="win_rate">胜率</th><th data-k="weeks_present">周数</th>
              </tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </section>`;

    bindFilterBar(app);
    drawStrategyCharts(name, info, bench, labels, fs);
    setupStrategyTable(fs, name, info);
  }

  function drawStrategyCharts(name, info, bench, labels, fs) {
    const p = state.period;
    // 等权净值：若筛选管理人，则用筛选集重算周均值
    let nav;
    if (fs.length && fs.length < info.fund_count) {
      const n = DATA.meta.weeks.length;
      nav = [];
      let cum = 1;
      for (let i = 0; i < n; i++) {
        const vals = [];
        for (const f of fs) { const v = f.series.weekly[i]; if (v != null) vals.push(v); }
        if (vals.length) cum *= (1 + vals.reduce((a, b) => a + b, 0) / vals.length);
        nav.push(cum);
      }
    } else {
      nav = info.nav_equal_weight;
    }
    const eqSeries = [{ name: `${name} 等权`, values: rebase(nav, p), color: "#0071e3", area: true }];
    if (bench) eqSeries.push({ name: bench.name, values: rebase(bench.nav, p), color: "#ff9f0a", dash: true });
    new LineChart($("#chart-eq"), { series: eqSeries, labels, height: 300, base: 0 });

    const medSeries = [{ name: "中位收益", values: sl(info.median_weekly, p), color: "#0071e3" }];
    if (bench) medSeries.push({ name: bench.name + " 周收益", values: sl(bench.weekly, p), color: "#ff9f0a", dash: true, width: 1.8 });
    new LineChart($("#chart-median"), { series: medSeries, labels, height: 300 });
  }

  function setupStrategyTable(fs, name, info) {
    const tbody = $("#fund-table tbody");
    const p = state.period;
    const benchKey = DATA.meta.bench_strategies[name];
    let sortKey = "ret", sortDir = -1, q = "", scale = "";

    const rows = fs.map(f => {
      const st = f.stats, lt = f.latest;
      return {
        id: f.id, name: f.name, scale: f.scale || "",
        ret: chainReturn(f.series.weekly, p),
        ret_ann_geom: st.ret_ann_geom,
        ytd: lt.ytd, weekly: lt.weekly,
        excess: benchKey ? periodExcess(f, p, benchKey) : null,
        ret_1y: lt.ret_1y,
        vol: periodVol(f.series.weekly, p),
        mdd: periodMaxDD(f.series.nav_chained, p),
        sharpe: lt.sharpe != null ? lt.sharpe : st.sharpe_est,
        win_rate: st.win_rate, weeks_present: f.weeks_present,
        restated: f.restated, incomplete: f.incomplete,
      };
    });

    function draw() {
      const fq = q.trim().toLowerCase();
      const list = rows.filter(r =>
        (!fq || r.name.toLowerCase().includes(fq)) && (!scale || r.scale === scale));
      list.sort((a, b) => {
        if (sortKey === "name") return a.name.localeCompare(b.name, "zh") * sortDir;
        const av = a[sortKey], bv = b[sortKey];
        if (av == null && bv == null) return 0;
        if (av == null) return 1; if (bv == null) return -1;
        return (av - bv) * sortDir;
      });
      tbody.innerHTML = list.map(r => `
        <tr onclick="location.hash='#/fund/${encodeURIComponent(r.id)}'">
          <td>${esc(r.name)}${badge({ restated: r.restated, incomplete: r.incomplete, weeks_present: r.weeks_present })}</td>
          <td>${r.scale ? `<span class="pill pill-scale">${esc(r.scale)}</span>` : "—"}</td>
          <td>${pctSpan(r.ret)}</td><td>${pctSpan(r.ret_ann_geom)}</td><td>${pctSpan(r.ytd)}</td><td>${pctSpan(r.weekly)}</td>
          <td>${pctSpan(r.excess)}</td><td>${pctSpan(r.ret_1y)}</td>
          <td>${r.vol != null ? (r.vol * 100).toFixed(1) + "%" : "—"}</td>
          <td>${pctSpan(r.mdd)}</td><td>${numStr(r.sharpe)}</td>
          <td>${r.win_rate != null ? (r.win_rate * 100).toFixed(0) + "%" : "—"}</td>
          <td>${r.weeks_present}</td>
        </tr>`).join("") || emptyRow(13);
      $("#strategy-sub").textContent = `共 ${fs.length} 家 · 筛选 ${list.length} 家 · 点击行进入详情`;
    }
    $("#fund-search").addEventListener("input", e => { q = e.target.value; draw(); });
    $("#scale-filter").addEventListener("change", e => { scale = e.target.value; draw(); });
    $("#sort-key").addEventListener("change", e => { const k = e.target.value; if (k === sortKey) sortDir *= -1; else { sortKey = k; sortDir = -1; } draw(); });
    $$("#fund-table th").forEach(th => th.addEventListener("click", () => {
      const k = th.dataset.k; if (!k) return;
      if (k === sortKey) sortDir *= -1; else { sortKey = k; sortDir = k === "name" || k === "scale" ? 1 : -1; }
      draw();
    }));
    draw();
  }

  /* ============================================================
     管理人详情
     ============================================================ */
  function renderFund(app, id) {
    const f = DATA.funds.find(x => x.id === decodeURIComponent(id));
    if (!f) return notFound(app, "未找到该管理人");
    const meta = DATA.meta, p = state.period;
    const labels = sLabels();
    const benchKey = f.bench_key || meta.bench_strategies[f.strategy];
    const bench = benchKey && DATA.benchmarks[benchKey] ? DATA.benchmarks[benchKey] : null;
    const st = f.stats, lt = f.latest;
    const ret = chainReturn(f.series.weekly, p);
    const vol = periodVol(f.series.weekly, p);
    const mdd = periodMaxDD(f.series.nav_chained, p);
    const excess = benchKey ? periodExcess(f, p, benchKey) : null;
    const benchRet = bench ? chainReturn(bench.weekly, p) : null;

    app.innerHTML = `
      <section class="page">
        <div class="crumb">
          <a href="#/">总览</a> / <a href="#/strategy/${encodeURIComponent(f.strategy)}">${esc(f.strategy)}</a> / <b>${esc(f.name)}</b>
        </div>
        <div class="detail-head">
          <div>
            <div class="detail-title">
              ${esc(f.name)}${f.scale ? ` <span class="pill pill-scale">${esc(f.scale)}</span>` : ""}${badge(f)}
            </div>
            <div class="crumb" style="margin-top:8px">
              ${esc(f.strategy)} · 在录 ${f.weeks_present}/${meta.weeks.length} 周
              ${bench ? ` · 基准 ${esc(bench.name)}` : ""}
            </div>
          </div>
        </div>

        <div class="kpi-grid" style="margin-bottom:16px">
          <div class="card kpi"><div class="label">区间收益</div><div class="value ${pctCls(ret)}">${pctStr(ret)}</div><div class="hint">${meta.weeks[p.start].label}~${meta.weeks[p.end].label}</div></div>
          <div class="card kpi"><div class="label">区间超额</div><div class="value ${pctCls(excess)}">${pctStr(excess)}</div><div class="hint">${bench ? "vs " + esc(bench.name) : "—"}</div></div>
          <div class="card kpi"><div class="label">今年收益</div><div class="value ${pctCls(lt.ytd)}">${pctStr(lt.ytd)}</div><div class="hint">官方口径</div></div>
          <div class="card kpi"><div class="label">本周收益</div><div class="value ${pctCls(lt.weekly)}">${pctStr(lt.weekly)}</div><div class="hint">最新一期</div></div>
          <div class="card kpi"><div class="label">区间年化波动</div><div class="value">${vol != null ? (vol * 100).toFixed(1) + "%" : "—"}</div><div class="hint">周收益估算</div></div>
          <div class="card kpi"><div class="label">年化收益（几何）</div><div class="value ${pctCls(st.ret_ann_geom)}">${pctStr(st.ret_ann_geom)}</div><div class="hint">${f.weeks_present >= 8 ? `几何口径 · ${f.weeks_present} 周样本` : "样本不足(<8周) 不计算"}</div></div>
          <div class="card kpi"><div class="label">区间最大回撤</div><div class="value down">${pctStr(mdd)}</div><div class="hint">复利净值口径</div></div>
          <div class="card kpi"><div class="label">夏普 / 卡玛</div><div class="value">${numStr(lt.sharpe != null ? lt.sharpe : st.sharpe_est)} / ${numStr(lt.calmar)}</div></div>
          <div class="card kpi"><div class="label">周胜率</div><div class="value">${st.win_rate != null ? (st.win_rate * 100).toFixed(0) + "%" : "—"}</div><div class="hint">最佳 ${pctStr(st.best_week)} · 最差 ${pctStr(st.worst_week)}</div></div>
        </div>

        <div class="filterbar card" style="margin-bottom:16px">
          <div class="fb-group"><span class="fb-label">时间</span>
            <div class="seg fb-seg" id="fb-presets">
              ${[["全部", 0, meta.weeks.length - 1], ["近4周", meta.weeks.length - 4, meta.weeks.length - 1], ["近8周", meta.weeks.length - 8, meta.weeks.length - 1]].map(x => `
                <button data-s="${x[1]}" data-e="${x[2]}" class="${p.start === x[1] && p.end === x[2] ? "active" : ""}">${x[0]}</button>`).join("")}
            </div>
          </div>
        </div>

        <div class="grid grid-2" style="margin-bottom:16px">
          <div class="card card-pad">
            <div class="card-head">
              <div><h3>累计净值</h3><div class="card-sub" id="nav-sub">官方今年收益口径 · 区间起点归一为 0%</div></div>
              <div class="seg" id="nav-mode"><button data-m="chained" class="active">复利</button><button data-m="official">官方</button></div>
            </div>
            <div class="toolbar" style="margin-bottom:0">
              <select id="bench-select" class="filter">
                ${Object.entries(DATA.benchmarks).map(([k, b]) => `<option value="${k}" ${k === benchKey ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
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

        <div class="grid grid-2" style="margin-bottom:16px">
          <div class="card card-pad">
            <div class="card-head"><div><h3>相对基准累计超额</h3><div class="card-sub">净值 / 基准净值 − 1</div></div></div>
            <div id="chart-excess"></div>
          </div>
          <div class="card card-pad">
            <div class="card-head"><div><h3>相关性（报告口径）</h3><div class="card-sub">与各大指数周收益的相关性</div></div></div>
            <div id="corr-chart"></div>
          </div>
        </div>

        <div class="card card-pad">
          <div class="card-head"><div><h3>周度明细</h3><div class="card-sub">所选区间的周收益 / 官方今年收益</div></div></div>
          <div class="table-wrap"><table class="data-table" id="week-detail">
            <thead><tr><th>周</th><th>报告期</th><th>当周收益</th><th>今年收益</th><th>复利净值</th><th>官方净值</th></tr></thead>
            <tbody></tbody>
          </table></div>
        </div>
      </section>`;

    // 时间筛选（仅本页预设）
    $$("#fb-presets button", app).forEach(b => b.addEventListener("click", () => {
      state.period = { start: +b.dataset.s, end: +b.dataset.e };
      router();
    }));

    // 净值图
    const modeBtns = $$("#nav-mode button");
    let navMode = "chained";
    function drawNav() {
      const bk = $("#bench-select").value;
      const b = bk ? DATA.benchmarks[bk] : null;
      const src = navMode === "official" ? f.series.nav_official : f.series.nav_chained;
      const series = [{ name: f.name + (navMode === "official" ? "（官方YTD）" : "（当周收益复利）"), values: rebase(src, p), color: "#0071e3", area: true }];
      if (b) series.push({ name: b.name, values: rebase(b.nav, p), color: "#ff9f0a", dash: true });
      new LineChart($("#chart-nav"), { series, labels, height: 310, base: 0 });
      $("#nav-sub").textContent = (navMode === "official" ? "官方今年收益口径（异常周已剔除）" : "当周收益复利口径（默认，规避源数据 YTD 异常）") + " · 区间起点归一为 0%";
    }
    modeBtns.forEach(b => b.addEventListener("click", () => {
      modeBtns.forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      navMode = b.dataset.m;
      drawNav();
    }));
    $("#bench-select").addEventListener("change", drawNav);
    drawNav();

    new BarChart($("#chart-weekly"), { values: sl(f.series.weekly, p), labels, height: 310 });
    const ex = (f.series.nav_excess_bench || f.series.nav_excess);
    new LineChart($("#chart-excess"), {
      series: [{ name: "累计超额", values: rebase(ex, p), color: "#bf5af2", area: true }],
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

    // 周度明细
    const wd = $("#week-detail tbody");
    wd.innerHTML = idxs().map(i => {
      const w = DATA.meta.weeks[i];
      return `<tr>
        <td>#${i + 1}</td><td>${esc(w.label)}</td>
        <td>${pctSpan(f.series.weekly[i])}</td><td>${pctSpan(f.series.ytd[i])}</td>
        <td>${f.series.nav_chained[i] != null ? f.series.nav_chained[i].toFixed(4) : "—"}</td>
        <td>${f.series.nav_official[i] != null ? f.series.nav_official[i].toFixed(4) : "—"}</td>
      </tr>`;
    }).join("");
    function idxs() { const a = []; for (let i = p.start; i <= p.end; i++) a.push(i); return a; }
  }

  /* ============================================================
     对比页
     ============================================================ */
  function renderCompare(app) {
    const meta = DATA.meta, p = state.period;
    const labels = sLabels();
    // 待对比列表：state.managers 里各机构在所选策略中的序列；若无则默认所有策略中的主序列
    let sel = DATA.funds.filter(f => state.managers.has(f.institution));
    if (!sel.length) sel = [];
    const strats = [...new Set(sel.map(f => f.strategy))];
    const benchKey = strats.length ? (meta.bench_strategies[strats[0]] || null) : "csi300";
    const bench = benchKey && DATA.benchmarks[benchKey] ? DATA.benchmarks[benchKey] : null;

    app.innerHTML = `
      <section class="page">
        <div class="crumb"><a href="#/">总览</a> / <span>管理人对比</span></div>
        <div class="hero" style="padding-bottom:14px">
          <h1>管理人对比</h1>
          <p class="sub">在顶部「管理人」筛选添加 2 家以上机构后进入本页，可叠加对比净值曲线与统计。</p>
        </div>
        ${filterBar()}
        <div class="card card-pad" style="margin:14px 0 16px">
          <div class="card-head"><div><h3>累计净值对比</h3><div class="card-sub">官方今年收益 · 区间起点归一为 0% ${bench ? "· 基准 " + esc(bench.name) : ""}</div></div></div>
          <div id="chart-cmp"></div>
        </div>
        <div class="card card-pad">
          <div class="card-head"><div><h3>统计对比</h3><div class="card-sub">点击行进入详情</div></div></div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>管理人</th><th>策略</th><th>区间</th><th>今年</th><th>本周</th><th>区间超额</th><th>区间波动</th><th>区间回撤</th><th>夏普</th><th>周数</th></tr></thead>
            <tbody>
              ${sel.map(f => {
                const st = f.stats, lt = f.latest;
                const bk = meta.bench_strategies[f.strategy];
                return `<tr onclick="location.hash='#/fund/${encodeURIComponent(f.id)}'">
                  <td>${esc(f.name)}${badge(f)}</td><td>${esc(f.strategy)}</td>
                  <td>${pctSpan(chainReturn(f.series.weekly, p))}</td><td>${pctSpan(lt.ytd)}</td><td>${pctSpan(lt.weekly)}</td>
                  <td>${pctSpan(bk ? periodExcess(f, p, bk) : null)}</td>
                  <td>${periodVol(f.series.weekly, p) != null ? (periodVol(f.series.weekly, p) * 100).toFixed(1) + "%" : "—"}</td>
                  <td>${pctSpan(periodMaxDD(f.series.nav_chained, p))}</td>
                  <td>${numStr(lt.sharpe != null ? lt.sharpe : st.sharpe_est)}</td><td>${f.weeks_present}</td>
                </tr>`;
              }).join("") || emptyRow(10)}
            </tbody>
          </table></div>
        </div>
      </section>`;

    bindFilterBar(app);
    const colors = window.Charts.COLORS;
    const series = sel.map((f, i) => ({
      name: f.name, values: rebase(f.series.nav_official, p),
      color: colors[i % colors.length], width: 2.2,
    }));
    if (bench) series.push({ name: bench.name, values: rebase(bench.nav, p), color: "#6e6e73", dash: true, width: 1.8 });
    new LineChart($("#chart-cmp"), { series, labels, height: 380, base: 0 });
  }

  /* ============================================================
     A股市场页
     ============================================================ */
  function renderMarket(app) {
    const meta = DATA.meta, p = state.period;
    const labels = sLabels();
    const bm = DATA.benchmarks;
    app.innerHTML = `
      <section class="page">
        <div class="crumb"><a href="#/">总览</a> / <span>A股市场</span></div>
        <div class="hero" style="padding-bottom:14px">
          <h1>A 股大盘 · 周度对比</h1>
          <p class="sub">六大指数区间起点归一，与私募策略同周网格对齐（剔除非交易日）。</p>
        </div>
        ${filterBar()}
        <div class="card card-pad" style="margin:14px 0 16px">
          <div class="card-head"><div><h3>指数累计净值</h3><div class="card-sub">区间起点归一为 0%</div></div></div>
          <div id="chart-idx"></div>
        </div>
        <div class="grid grid-2">
          <div class="card card-pad">
            <div class="card-head"><div><h3>指数周度收益</h3><div class="card-sub">选择下方指数查看</div></div></div>
            <div class="toolbar" style="margin-bottom:0">
              <select id="idx-select" class="filter">${Object.entries(bm).map(([k, b]) => `<option value="${k}">${esc(b.name)}</option>`).join("")}</select>
            </div>
            <div id="chart-idx-weekly" style="margin-top:6px"></div>
          </div>
          <div class="card card-pad">
            <div class="card-head"><div><h3>指数一览</h3><div class="card-sub">区间 & 今年以来</div></div></div>
            <div class="table-wrap"><table class="data-table">
              <thead><tr><th>指数</th><th>区间</th><th>今年</th><th>周数</th></tr></thead>
              <tbody>${Object.entries(bm).map(([k, b]) => `
                <tr><td>${esc(b.name)}</td><td>${pctSpan(chainReturn(b.weekly, p))}</td><td>${pctSpan(b.ytd_latest)}</td><td>${b.weekly.length}</td></tr>`).join("")}
              </tbody>
            </table></div>
          </div>
        </div>
      </section>`;

    bindFilterBar(app);
    const series = Object.entries(bm).map(([k, b], i) => ({
      name: b.name, values: rebase(b.nav, p), color: window.Charts.COLORS[i % 6], width: 2,
    }));
    new LineChart($("#chart-idx"), { series, labels, height: 360, base: 0 });

    window.renderMarketWeekly = function (k) {
      new BarChart($("#chart-idx-weekly"), { values: sl(bm[k].weekly, p), labels, height: 300 });
    };
    renderMarketWeekly(Object.keys(bm)[0]);
    $("#idx-select").addEventListener("change", e => renderMarketWeekly(e.target.value));
  }

  /* ============================================================
     数据质量页
     ============================================================ */
  function renderQA(app) {
    const qa = DATA.qa;
    const restated = DATA.funds.filter(f => f.restated).length;
    const incomplete = DATA.funds.filter(f => f.incomplete).length;
    const clean = DATA.funds.filter(f => !f.restated && !f.incomplete).length;
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
          <p class="sub">每次运行清洗管线自动审计：缺失值、错位列修复、身份补齐、净值重构识别。</p>
        </div>
        <div class="kpi-grid" style="margin-bottom:16px">
          <div class="card kpi"><div class="label">源文件</div><div class="value">${qa.source_files}</div></div>
          <div class="card kpi"><div class="label">交易周</div><div class="value">${qa.weeks}</div><div class="hint">剔除非交易日</div></div>
          <div class="card kpi"><div class="label">记录行</div><div class="value">${qa.fund_rows.toLocaleString()}</div></div>
          <div class="card kpi"><div class="label">管理人序列</div><div class="value">${qa.fund_series}</div></div>
          <div class="card kpi"><div class="label">完整一致</div><div class="value">${clean}</div><div class="hint">29周全勤且口径一致</div></div>
          <div class="card kpi"><div class="label">数据不连续</div><div class="value">${incomplete}</div><div class="hint">存在缺周</div></div>
          <div class="card kpi"><div class="label">疑似源数据修正</div><div class="value ${restated ? "down" : ""}">${restated}</div><div class="hint">完整但官方YTD≠复利</div></div>
          <div class="card kpi"><div class="label">基准指数</div><div class="value">${Object.keys(DATA.benchmarks).length}</div></div>
        </div>
        <div class="card card-pad qa-block">
          <div class="card-head"><div><h3>疑似源数据修正序列</h3><div class="card-sub">完整 29 周，但官方今年收益与当周收益复利偏差 > 2%</div></div></div>
          <ul class="qa-list">${qa.restated_series.slice(0, 20).map(r => `
            <li><span class="qa-tag">修正</span><span>${esc(r.strategy)} <b>${esc(r.fund)}</b></span>
            <span style="margin-left:auto">官方 ${pctStr(r.official)} vs 复利 ${pctStr(r.chained)}</span></li>`).join("") || "<li class='muted'>无</li>"}
          </ul>
        </div>
        <div class="card card-pad qa-block" style="margin-top:16px">
          <div class="card-head"><div><h3>清洗处理记录</h3><div class="card-sub">${qa.notes.length} 条自动处理</div></div></div>
          <ul class="qa-list">${qa.notes.slice(0, 40).map(n => `
            <li><span class="qa-tag">${esc(typeNames[n.type] || n.type)}</span><span>${esc(n.week || "")} ${esc(n.sheet || "")} ${esc(n.detail)}</span></li>`).join("") || "<li class='muted'>无</li>"}
          </ul>
        </div>
      </section>`;
  }

  function notFound(app, msg) {
    app.innerHTML = `<div class="empty">${esc(msg)}<br><br><a href="#/" style="color:var(--accent)">返回总览</a></div>`;
  }

  /* ---------- 通用 ---------- */
  function renderUpdateChip() {
    if (!DATA) return;
    $("#update-text").textContent = "数据更新于 " + (DATA.meta.generated_at || "").slice(0, 16);
    $("#footer-meta").textContent =
      `${DATA.qa.source_files} 期周报 · ${DATA.qa.weeks} 个交易周 · ${DATA.qa.fund_series} 条管理人序列 · ` +
      `生成 ${DATA.meta.generated_at}`;
  }

  function initGate() {
    const gate = $("#gate");
    if (!gate) return;
    if (document.querySelector('meta[name="pe-auth"]')) { gate.remove(); return; }
    try { if (sessionStorage.getItem("pe-gate-unlocked") === "1") { gate.classList.add("hidden"); return; } } catch (e) {}
    const input = $("#gate-pwd"), btn = $("#gate-btn"), err = $("#gate-error"), qr = $("#gate-qr");
    function unlock() {
      try { sessionStorage.setItem("pe-gate-unlocked", "1"); } catch (e) {}
      gate.classList.add("hidden"); input.value = "";
      setTimeout(() => gate.remove(), 600);
    }
    function deny() {
      gate.classList.remove("shake"); void gate.offsetWidth; gate.classList.add("shake");
      err.textContent = "密码错误，请重新输入"; qr.hidden = false; input.value = ""; input.focus();
    }
    function submit() { if (input.value.trim() === "5101") unlock(); else deny(); }
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
    input.focus();
  }

  function bind() {
    $("#refresh-btn").addEventListener("click", async () => {
      try { DATA = await loadData(true); renderUpdateChip(); router(); toast("数据已刷新：" + DATA.meta.generated_at); }
      catch (e) { toast("刷新失败：" + e.message); }
    });
    $("#theme-btn").addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("pe-theme", next); } catch (e) {}
    });
    window.addEventListener("hashchange", router);
    setInterval(() => {
      if (document.visibilityState === "visible") loadData(true).then(d => { DATA = d; renderUpdateChip(); }).catch(() => {});
    }, 10 * 60 * 1000);
  }

  async function init() {
    try { const t = localStorage.getItem("pe-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
    initGate();
    bind();
    router();
  }

  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();
