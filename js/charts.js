/* ============================================================
   charts.js — 轻量 SVG 图表引擎（零依赖）
   支持：多序列折线/面积、柱状、迷你 sparkline、悬停十字线与提示
   ============================================================ */
(function (global) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const W = 860, H = 340;           // 内部画布
  const M = { top: 18, right: 18, bottom: 30, left: 58 };
  const COLORS = ["#0071e3", "#ff9f0a", "#bf5af2", "#30d158", "#ff453a", "#64d2ff", "#ffd60a", "#5e5ce6"];

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function fmtPct(v, digits) {
    if (v == null || !isFinite(v)) return "—";
    const d = digits == null ? 2 : digits;
    const s = (v * 100).toFixed(d);
    return (v > 0 ? "+" : "") + s + "%";
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* ---------- 通用折线图 ---------- */
  class LineChart {
    /**
     * @param {HTMLElement} host
     * @param {object} opts
     *  opts.series: [{name, color, values, area?bool, dash?bool, width?number}]
     *  opts.labels: string[] x 轴标签
     *  opts.height, opts.fmt(v)->string, opts.yDomain:[min,max], opts.base?number
     */
    constructor(host, opts) {
      this.host = host;
      this.o = Object.assign({ height: 300, fmt: fmtPct, base: 0 }, opts);
      this.w = W; this.h = this.o.height || 300;
      this.iw = W - M.left - M.right;
      this.ih = this.h - M.top - M.bottom;
      this.series = this.o.series.filter(s => s.values.some(v => v != null));
      this.n = this.o.labels.length;
      this.domain = this.o.yDomain || this._domain();
      this.tipEl = null;
      this.legendEl = null;
      this.visible = this.series.map(() => true);
      this._build();
      this._bind();
    }
    _domain() {
      let mn = Infinity, mx = -Infinity;
      for (const s of this.series) for (const v of s.values) if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
      if (!isFinite(mn)) { mn = 0; mx = 1; }
      const pad = (mx - mn) * 0.12 || 1;
      const base = this.o.base;
      if (base != null) { mn = Math.min(mn, base); mx = Math.max(mx, base); }
      return [mn - pad, mx + pad];
    }
    _x(i) { return M.left + (this.n <= 1 ? this.iw / 2 : (i / (this.n - 1)) * this.iw); }
    _y(v) {
      const [lo, hi] = this.domain;
      return M.top + (1 - (v - lo) / (hi - lo)) * this.ih;
    }
    _niceTicks() {
      const [lo, hi] = this.domain;
      const span = hi - lo;
      const step = Math.pow(10, Math.floor(Math.log10(span / 4)));
      const ticks = [];
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
        if (ticks.length < 7) ticks.push(Math.round(v * 10000) / 10000);
      }
      return ticks.length ? ticks : [lo, hi];
    }
    _pathFor(values) {
      const segs = [];
      let cur = [];
      for (let i = 0; i < values.length; i++) {
        if (values[i] != null) cur.push([i, values[i]]);
        else if (cur.length) { segs.push(cur); cur = []; }
      }
      if (cur.length) segs.push(cur);
      return segs.map(seg => {
        let d = `M ${this._x(seg[0][0]).toFixed(1)} ${this._y(seg[0][1]).toFixed(1)}`;
        for (let k = 1; k < seg.length; k++) d += ` L ${this._x(seg[k][0]).toFixed(1)} ${this._y(seg[k][1]).toFixed(1)}`;
        return d;
      });
    }
    _areaPathFor(values) {
      const paths = this._pathFor(values);
      const [lo] = this.domain;
      const baseY = this._y(Math.max(lo, this.o.base != null ? this.o.base : lo)).toFixed(1);
      return paths.map(p => {
        const firstX = parseFloat(p.match(/M ([\d.]+)/)[1]);
        const lastX = parseFloat(p.match(/L ([\d.]+)/g).pop().split(" ")[1]);
        return `${p} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;
      });
    }
    _build() {
      this.host.innerHTML = "";
      this.host.classList.add("chart-box");
      const wrap = document.createElement("div");
      wrap.style.position = "relative";
      this.host.appendChild(wrap);

      // legend
      if (this.o.legend !== false && this.series.length > 1) {
        const lg = document.createElement("div");
        lg.className = "chart-legend";
        this.series.forEach((s, si) => {
          const item = document.createElement("span");
          item.className = "lg-item";
          item.innerHTML = `<span class="lg-dot" style="background:${s.color||COLORS[si%COLORS.length]}"></span>${s.name}`;
          item.addEventListener("click", () => {
            this.visible[si] = !this.visible[si];
            item.classList.toggle("off", !this.visible[si]);
            this._redraw();
          });
          lg.appendChild(item);
        });
        wrap.appendChild(lg);
        this.legendEl = lg;
      }

      const svg = el("svg", { viewBox: `0 0 ${this.w} ${this.h}`, role: "img" }, wrap);
      this.svg = svg;
      const g = el("g", {}, svg);
      this.g = g;
      // grid + y labels
      const [lo, hi] = this.domain;
      const ticks = this._niceTicks();
      const yGrid = el("g", {}, g);
      for (const t of ticks) {
        const y = this._y(t);
        el("line", { x1: M.left, x2: this.w - M.right, y1: y, y2: y, stroke: "var(--border)", "stroke-width": 1 }, yGrid);
        const lbl = el("text", { x: M.left - 8, y: y + 3.5, "text-anchor": "end", "font-size": 10.5, fill: "var(--text-3)" }, yGrid);
        lbl.textContent = this.o.fmt(t, 1);
      }
      // x labels (subset)
      const xGrid = el("g", {}, g);
      const step = Math.max(1, Math.ceil(this.n / 8));
      for (let i = 0; i < this.n; i += step) {
        const x = this._x(i);
        const lbl = el("text", { x, y: this.h - 8, "text-anchor": "middle", "font-size": 10.5, fill: "var(--text-3)" }, xGrid);
        lbl.textContent = this.o.labels[i] || "";
      }
      const lbl0 = el("text", { x: M.left, y: this.h - 8, "text-anchor": "start", "font-size": 10.5, fill: "var(--text-3)" }, xGrid);
      lbl0.textContent = this.o.labels[0] || "";
      if (this.n > 1) {
        const lblN = el("text", { x: this.w - M.right, y: this.h - 8, "text-anchor": "end", "font-size": 10.5, fill: "var(--text-3)" }, xGrid);
        lblN.textContent = this.o.labels[this.n - 1] || "";
      }
      // crosshair
      this.cross = el("line", { x1: 0, y1: M.top, x2: 0, y2: this.h - M.bottom, stroke: "var(--border-strong)", "stroke-width": 1, opacity: 0, "stroke-dasharray": "3 3" }, g);
      this.hoverDots = [];
      this._redraw();

      // tooltip
      const tip = document.createElement("div");
      tip.className = "chart-tip";
      wrap.appendChild(tip);
      this.tipEl = tip;
      this.wrapEl = wrap;
    }
    _redraw() {
      if (!this.g) return;
      const old = this.g.querySelectorAll(".series-g");
      old.forEach(n => n.remove());
      const [lo] = this.domain;
      const baseY = this._y(Math.max(lo, this.o.base != null ? this.o.base : lo));
      this.hoverDots = [];
      this.series.forEach((s, si) => {
        if (!this.visible[si]) return;
        const color = s.color || COLORS[si % COLORS.length];
        const sg = el("g", { class: "series-g" }, this.g);
        const paths = this._pathFor(s.values);
        paths.forEach(p => {
          const line = el("path", { d: p, fill: "none", stroke: color, "stroke-width": s.width || 2.2, "stroke-linejoin": "round", "stroke-linecap": "round" }, sg);
          if (s.dash) line.setAttribute("stroke-dasharray", "6 4");
          line.style.opacity = "0";
          requestAnimationFrame(() => {
            line.style.transition = "opacity .6s ease";
            line.style.opacity = "1";
          });
        });
        if (s.area) {
          this._areaPathFor(s.values).forEach(p => {
            const area = el("path", { d: p, fill: color, opacity: 0.08 }, sg);
            area.style.opacity = "0";
            requestAnimationFrame(() => { area.style.transition = "opacity .7s ease"; area.style.opacity = null; });
          });
        }
        if (s.values.length <= 60) {
          s.values.forEach((v, i) => {
            if (v == null) return;
            const dot = el("circle", { cx: this._x(i), cy: this._y(v), r: 2.6, fill: color, class: "hover-dot", "data-si": si }, sg);
            dot.style.opacity = "0";
            this.hoverDots.push(dot);
          });
        }
      });
    }
    _bind() {
      this.wrapEl.addEventListener("mousemove", e => {
        const rect = this.svg.getBoundingClientRect();
        const px = (e.clientX - rect.left) * (this.w / rect.width);
        const i = clamp(Math.round((px - M.left) / (this.iw / Math.max(1, this.n - 1))), 0, this.n - 1);
        this._showTip(i, e.clientX - rect.left, e.clientY - rect.top);
      });
      this.wrapEl.addEventListener("mouseleave", () => this._hideTip());
    }
    _showTip(i, mx, my) {
      const inChart = i >= 0 && i < this.n;
      if (!inChart) return this._hideTip();
      const x = this._x(i);
      this.cross.setAttribute("x1", x); this.cross.setAttribute("x2", x);
      this.cross.setAttribute("opacity", 1);
      this.hoverDots.forEach(d => {
        const si = +d.getAttribute("data-si");
        if (this.visible[si]) d.style.opacity = "1";
      });
      const html = [`<div class="tt-title">${this.o.labels[i]}</div>`];
      this.series.forEach((s, si) => {
        if (!this.visible[si]) return;
        const v = s.values[i];
        if (v == null) return;
        const color = s.color || COLORS[si % COLORS.length];
        html.push(`<div class="tt-row"><span class="tt-dot" style="background:${color}"></span><span>${s.name}</span><span class="tt-val">${this.o.fmt(v)}</span></div>`);
      });
      if (html.length === 1) return this._hideTip();
      this.tipEl.innerHTML = html.join("");
      this.tipEl.classList.add("show");
      const rect = this.svg.getBoundingClientRect();
      const scale = rect.width / this.w;
      const tx = clamp(mx + 14, 0, rect.width - 170);
      const ty = clamp(my - 10, 0, rect.height - 90);
      this.tipEl.style.left = tx + "px";
      this.tipEl.style.top = ty + "px";
    }
    _hideTip() {
      this.cross.setAttribute("opacity", 0);
      this.hoverDots.forEach(d => d.style.opacity = "0");
      this.tipEl.classList.remove("show");
    }
  }

  /* ---------- 柱状图 ---------- */
  class BarChart {
    constructor(host, opts) {
      this.host = host;
      this.o = Object.assign({ height: 280, fmt: fmtPct }, opts);
      this.values = this.o.values;
      this.n = this.values.length;
      this.w = W; this.h = this.o.height;
      this.iw = W - M.left - M.right;
      this.ih = this.h - M.top - M.bottom;
      this.domain = this._domain();
      this._build();
      this._bind();
    }
    _domain() {
      const vals = this.values.filter(v => v != null);
      let mx = vals.length ? Math.max(...vals) : 1;
      let mn = vals.length ? Math.min(...vals) : 0;
      const pad = (mx - mn) * 0.15 || 0.01;
      if (mn > 0) mn = 0; if (mx < 0) mx = 0;
      return [mn - pad, mx + pad];
    }
    _x(i) { return M.left + (i + 0.5) * (this.iw / this.n); }
    _y(v) { const [lo, hi] = this.domain; return M.top + (1 - (v - lo) / (hi - lo)) * this.ih; }
    _build() {
      this.host.innerHTML = "";
      this.host.classList.add("chart-box");
      const wrap = document.createElement("div");
      wrap.style.position = "relative";
      this.host.appendChild(wrap);
      const [lo, hi] = this.domain;
      const svg = el("svg", { viewBox: `0 0 ${this.w} ${this.h}` }, wrap);
      const g = el("g", {}, svg);
      const ticks = [];
      const span = hi - lo;
      const step = Math.pow(10, Math.floor(Math.log10(span / 4)));
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) if (ticks.length < 7) ticks.push(Math.round(v * 10000) / 10000);
      if (!ticks.length) ticks.push(lo, hi);
      for (const t of ticks) {
        const y = this._y(t);
        el("line", { x1: M.left, x2: this.w - M.right, y1: y, y2: y, stroke: "var(--border)", "stroke-width": 1 }, g);
        const lbl = el("text", { x: M.left - 8, y: y + 3.5, "text-anchor": "end", "font-size": 10.5, fill: "var(--text-3)" }, g);
        lbl.textContent = this.o.fmt(t, 1);
      }
      // zero line
      if (lo < 0 && hi > 0) {
        const zy = this._y(0);
        el("line", { x1: M.left, x2: this.w - M.right, y1: zy, y2: zy, stroke: "var(--border-strong)", "stroke-width": 1.4 }, g);
      }
      const bw = Math.max(2, this.iw / this.n * 0.62);
      this.bars = [];
      const zeroY = this._y(0);
      this.values.forEach((v, i) => {
        if (v == null) return;
        const x = this._x(i) - bw / 2;
        const y = v >= 0 ? this._y(v) : zeroY;
        const hgt = Math.abs(this._y(v) - zeroY);
        const color = v >= 0 ? "var(--up)" : "var(--down)";
        const rect = el("rect", { x, y, width: bw, height: Math.max(hgt, 1), rx: Math.min(3, bw / 2), fill: color, opacity: 0.82 }, g);
        rect.style.transformOrigin = `${x + bw/2}px ${y}px`;
        rect.style.transition = "transform .5s cubic-bezier(.2,.8,.2,1), opacity .3s";
        rect.style.transform = "scaleY(0)";
        requestAnimationFrame(() => requestAnimationFrame(() => { rect.style.transform = "scaleY(1)"; }));
        this.bars.push({ rect, v, i });
      });
      const stepL = Math.max(1, Math.ceil(this.n / 10));
      for (let i = 0; i < this.n; i += stepL) {
        const lbl = el("text", { x: this._x(i), y: this.h - 8, "text-anchor": "middle", "font-size": 10.5, fill: "var(--text-3)" }, g);
        lbl.textContent = this.o.labels[i] || "";
      }
      this.wrapEl = wrap;
      this.svg = svg;
      this._bind();
    }
    _bind() {
      this.wrapEl.addEventListener("mousemove", e => {
        const rect = this.svg.getBoundingClientRect();
        const px = (e.clientX - rect.left) * (this.w / rect.width);
        const i = clamp(Math.floor((px - M.left) / (this.iw / this.n)), 0, this.n - 1);
        this.bars.forEach(b => b.rect.setAttribute("opacity", b.i === i ? 1 : 0.5));
        const b = this.bars.find(x => x.i === i);
        if (!b) return;
        let tip = this.wrapEl.querySelector(".chart-tip");
        if (!tip) { tip = document.createElement("div"); tip.className = "chart-tip"; this.wrapEl.appendChild(tip); }
        tip.innerHTML = `<div class="tt-title">${this.o.labels[i]}</div>` +
          `<div class="tt-row"><span class="tt-dot" style="background:${b.v>=0?"var(--up)":"var(--down)"}"></span><span>周收益</span><span class="tt-val">${this.o.fmt(b.v)}</span></div>`;
        tip.classList.add("show");
        tip.style.left = clamp(e.clientX - rect.left + 14, 0, rect.width - 170) + "px";
        tip.style.top = clamp(e.clientY - rect.top - 10, 0, rect.height - 90) + "px";
      });
      this.wrapEl.addEventListener("mouseleave", () => {
        this.bars.forEach(b => b.rect.setAttribute("opacity", 0.82));
        const tip = this.wrapEl.querySelector(".chart-tip");
        if (tip) tip.classList.remove("show");
      });
    }
  }

  /* ---------- 迷你走势 ---------- */
  function Sparkline(host, values, color, height) {
    host.innerHTML = "";
    const h = height || 44;
    const w = 120;
    const valid = values.map((v, i) => [i, v]).filter(x => x[1] != null);
    if (valid.length < 2) {
      host.innerHTML = `<span style="font-size:11px;color:var(--text-3)">—</span>`;
      return;
    }
    const xs = valid.map(x => x[0]), ys = valid.map(x => x[1]);
    const mn = Math.min(...ys), mx = Math.max(...ys), pad = (mx - mn) * 0.15 || 1;
    const lo = mn - pad, hi = mx + pad;
    const X = i => 2 + (i - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs) || 1) * (w - 4);
    const Y = v => h - 3 - (v - lo) / (hi - lo) * (h - 6);
    let d = valid.map((p, k) => `${k ? "L" : "M"} ${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(" ");
    const svgNS = NS;
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.style.width = "100%"; svg.style.height = "auto";
    const area = document.createElementNS(svgNS, "path");
    area.setAttribute("d", `${d} L ${X(valid[valid.length-1][0]).toFixed(1)} ${h-3} L ${X(valid[0][0]).toFixed(1)} ${h-3} Z`);
    area.setAttribute("fill", color || "var(--accent)");
    area.setAttribute("opacity", "0.12");
    svg.appendChild(area);
    const line = document.createElementNS(svgNS, "path");
    line.setAttribute("d", d);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", color || "var(--accent)");
    line.setAttribute("stroke-width", "1.8");
    line.setAttribute("stroke-linejoin", "round");
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
    host.appendChild(svg);
  }

  global.Charts = { LineChart, BarChart, Sparkline, fmtPct, COLORS };
})(window);
