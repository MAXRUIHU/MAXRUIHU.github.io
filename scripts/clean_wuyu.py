#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
无鱼内参数据源 · 采集与清洗管线
================================
从「私募周报/无鱼/无鱼内参XXX-*.xlsx」读取 24+ 策略 sheet，产出看板数据。

数据源特点（相对旧周报）：
  * 每个 sheet 自带基准指数周收益（行0，如 沪深300/中证500/中证全指/南华商品…）
  * 提供「区间收益」（单周）与「YTD收益」（今年累计），及超额口径
  * 按 大厂/小厂/全部 分档，CTA/套利 等含「策略类型」子分类
  * 行0 尾部附带统计块（收益中位数/四分位/样本总数/正收益数…）

清洗规则：
  1. 周序：优先解析文件内日期 sheet（含年份前缀），否则用文件名回退
  2. 剔除：说明 sheet、日期 sheet、*总 汇总 sheet
  3. 身份：CTA 族用 (管理人, 策略类型) 作键；其余同管理人重复行取均值合并（记 QA）
  4. 异常：|区间收益|>50% 记为极端值（保留但标记）；YTD 链乘偏差>2pp 标记「源数据修正」
  5. 净值：官方 YTD 为主口径，当周收益复利为参考；缺周置空（图表断开）
  6. 基准：直接采用源数据行0 的指数周收益，链乘为净值

用法:
  python3 scripts/clean_wuyu.py [--source ../../私募周报/无鱼] [--out public/data]
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import re
import statistics
from collections import Counter, defaultdict
from datetime import date

import numpy as np
import pandas as pd

# ----------------------------------------------------------------------------
WEEK_RE = re.compile(r"^([\d.]{1,12})[-~]([\d.]{1,12})$")
SKIP_SHEETS = {"说明", "Sheet", "目录", "使用说明"}
SKIP_SUFFIX = ("总",)          # 500总 / 1000总 / 量化多头总 / 中性总
INDEX_NAMES = {                # 用于识别行0 基准对
    "中证全指", "沪深300", "中证500", "中证1000", "中证2000", "中证A500", "A500",
    "红利指数", "红利", "中证转债", "可转债", "南华商品指数", "南华农产品", "南华工业品",
    "南华能化", "南华有色", "南华贵金属", "南华黄金", "国债", "中债", "上证50",
}


def to_num(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float, np.floating, np.integer)):
        return float(v)
    s = str(v).strip().replace(",", "")
    if s in ("", "-", "nan", "None", "N/A"):
        return None
    try:
        if s.endswith("%"):
            return float(s[:-1]) / 100.0
        return float(s)
    except ValueError:
        return None


def parse_week_from_sheet(name: str) -> tuple[date, date] | None:
    """解析日期 sheet 名：'2026.1.5-2026.1.9' / '1.12-1.16' / '7.27-7.31' / '8.3-8.7'"""
    m = WEEK_RE.match(name.strip())
    if not m:
        return None
    def parse_part(p: str) -> tuple[int, int] | None:
        nums = [int(x) for x in p.split(".") if x.strip()]
        if len(nums) == 3:      # 2026.1.5 -> (year, month, day)
            _, mo, dy = nums
        elif len(nums) == 2:    # 1.12 -> (month, day)
            mo, dy = nums
        else:
            return None
        if mo < 1 or mo > 12 or dy < 1 or dy > 31:
            return None
        return mo, dy
    a, b = parse_part(m.group(1)), parse_part(m.group(2))
    if not a or not b:
        return None
    return date(2026, a[0], a[1]), date(2026, b[0], b[1])


def parse_week_from_filename(fname: str) -> tuple[date, date] | None:
    m = re.search(r"(\d{4})(\d{4})(\d{4})$", fname.replace("-", "").split(".")[0])
    if not m:
        return None
    try:
        y, s, e = int(m.group(1)), m.group(2), m.group(3)
        return date(y, int(s[:2]), int(s[2:])), date(y, int(e[:2]), int(e[2:]))
    except ValueError:
        return None


def resolve_weeks(files: list[str]) -> tuple[list[dict], list[dict]]:
    """返回 (weeks, notes)；周序按报告期开始日期排序。"""
    info = []
    for f in files:
        xl = pd.ExcelFile(f)
        wk = None
        for s in xl.sheet_names:
            w = parse_week_from_sheet(s)
            if w:
                wk = w
                break
        if wk is None:
            wk = parse_week_from_filename(os.path.basename(f))
        info.append({"file": os.path.basename(f), "path": f, "week": wk})
    bad = [i for i in info if i["week"] is None]
    if bad:
        raise SystemExit(f"无法解析周序的文件: {[b['file'] for b in bad]}")
    info.sort(key=lambda x: x["week"][0])
    for i, it in enumerate(info):
        it["idx"] = i
    weeks = [{"idx": i["idx"], "start": i["week"][0], "end": i["week"][1],
              "file": i["file"],
              "label": f"{i['week'][0].month:02d}.{i['week'][0].day:02d}~"
                       f"{i['week'][1].month:02d}.{i['week'][1].day:02d}"}
             for i in info]
    return weeks, info


def parse_sheet(raw: pd.DataFrame, sheet: str) -> dict | None:
    """解析单个策略 sheet -> {meta, rows}。"""
    nrows, ncols = raw.shape
    if nrows < 2 or ncols < 4:
        return None
    hdr = [str(c) for c in raw.iloc[0].tolist()]

    def col(name):
        return hdr.index(name) if name in hdr else None

    idx_name = col("管理人")
    if idx_name is None:
        return None
    idx_pt = col("策略类型")
    idx_scale = col("管理人规模")
    idx_ret = col("区间收益")
    idx_ret_ex = col("区间超额收益")
    idx_ytd = col("YTD收益")
    idx_mdd = col("YTD最大回撤")
    idx_ytd_ex = col("YTD超额收益")
    idx_mdd_ex = col("YTD超额最大回撤")

    # ---- 行0 统计块与基准 ----
    stats = {}
    benches = []
    # 行0 为「标签, 值」成对布局（标签在 j 列，数值在 j+1 列）
    for j in range(ncols):
        label = hdr[j]
        if label in ("nan", "None", ""):
            continue
        if j + 1 >= ncols:
            break
        val = to_num(raw.iloc[0, j + 1])
        if label in INDEX_NAMES and val is not None:
            benches.append({"name": label, "value": val})
        elif val is not None and re.search(r"1/4|中位数|样本总数|正收益|正超额", label):
            stats[label] = val

    rows = []
    for i in range(1, nrows):
        nm = str(raw.iloc[i, idx_name]).strip()
        if nm in ("nan", "None", "") or nm.isdigit():
            continue
        pt = None
        if idx_pt is not None:
            pt = str(raw.iloc[i, idx_pt]).strip()
            if pt in ("nan", "None"):
                pt = None
        rows.append({
            "name": nm,
            "pt": pt,
            "scale": str(raw.iloc[i, idx_scale]).strip() if idx_scale is not None
                     and isinstance(raw.iloc[i, idx_scale], str) else None,
            "ret": to_num(raw.iloc[i, idx_ret]) if idx_ret is not None else None,
            "ret_ex": to_num(raw.iloc[i, idx_ret_ex]) if idx_ret_ex is not None else None,
            "ytd": to_num(raw.iloc[i, idx_ytd]) if idx_ytd is not None else None,
            "mdd": to_num(raw.iloc[i, idx_mdd]) if idx_mdd is not None else None,
            "ytd_ex": to_num(raw.iloc[i, idx_ytd_ex]) if idx_ytd_ex is not None else None,
            "mdd_ex": to_num(raw.iloc[i, idx_mdd_ex]) if idx_mdd_ex is not None else None,
        })
    return {"stats": stats, "benches": benches, "rows": rows}


def avg_rows(dup_rows: list[dict]) -> dict:
    """同管理人周内多产品 -> 取各列均值（记 QA）。"""
    out = dict(dup_rows[0])
    for k in ("ret", "ret_ex", "ytd", "mdd", "ytd_ex", "mdd_ex"):
        vals = [r[k] for r in dup_rows if r[k] is not None]
        out[k] = float(np.mean(vals)) if vals else None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=os.path.normpath(
        os.path.join(os.path.dirname(__file__), "..", "..", "私募周报", "无鱼")))
    ap.add_argument("--out", default=os.path.normpath(
        os.path.join(os.path.dirname(__file__), "..", "public", "data")))
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.source, "*.xlsx")))
    files = [f for f in files if not os.path.basename(f).startswith("~$")]
    if not files:
        raise SystemExit(f"未在 {args.source} 找到 xlsx")

    print(f"[1/5] 解析周序: {len(files)} 个文件")
    weeks, info = resolve_weeks(files)
    wk_of_file = {i["file"]: i["idx"] for i in info}
    print(f"      {len(weeks)} 个交易周: {weeks[0]['label']} ~ {weeks[-1]['label']}")

    print("[2/5] 解析策略 sheet ...")
    notes: list[dict] = []
    # sheet 顺序：以首文件的策略 sheet 顺序为基准
    first_xl = pd.ExcelFile(files[0])
    strat_order = [s for s in first_xl.sheet_names
                   if s not in SKIP_SHEETS and WEEK_RE.match(s) is None
                   and not s.endswith(SKIP_SUFFIX)]
    for s in pd.ExcelFile(files[-1]).sheet_names:
        if s not in strat_order and s not in SKIP_SHEETS and WEEK_RE.match(s) is None \
                and not s.endswith(SKIP_SUFFIX):
            strat_order.append(s)

    records = []          # 长表
    sheet_meta = {}       # (sheet, week_idx) -> stats/benches
    for it in info:
        f = it["path"]
        wi = it["idx"]
        xl = pd.ExcelFile(f)
        for s in xl.sheet_names:
            if s in SKIP_SHEETS or WEEK_RE.match(s) or s.endswith(SKIP_SUFFIX):
                continue
            parsed = parse_sheet(pd.read_excel(f, sheet_name=s, header=None), s)
            if not parsed:
                continue
            sheet_meta.setdefault(s, {})[wi] = {"stats": parsed["stats"],
                                                "benches": parsed["benches"]}
            # 去重
            by_key = defaultdict(list)
            for r in parsed["rows"]:
                k = (r["name"], r["pt"] or "")
                by_key[k].append(r)
            for (name, pt), group in by_key.items():
                if len(group) > 1:
                    notes.append({"type": "dup_merged", "file": it["file"], "sheet": s,
                                  "detail": f"{name} 同周多产品，已取均值合并 {len(group)} 行"})
                    r = avg_rows(group)
                else:
                    r = group[0]
                if r["ret"] is not None and abs(r["ret"]) > 0.5:
                    notes.append({"type": "extreme", "file": it["file"], "sheet": s,
                                  "detail": f"{name} 区间收益 {r['ret']:.2%} 异常（保留并标记）"})
                records.append({"sheet": s, "name": name, "pt": pt, "week": wi,
                                "scale": r["scale"], "ret": r["ret"], "ret_ex": r["ret_ex"],
                                "ytd": r["ytd"], "mdd": r["mdd"],
                                "ytd_ex": r["ytd_ex"], "mdd_ex": r["mdd_ex"]})
    print(f"      {len(records)} 条记录, {len(strat_order)} 个策略分类")

    print("[3/5] 构建管理人面板 ...")
    n_weeks = len(weeks)
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in records:
        key = (r["sheet"], r["name"], r["pt"] or "")
        groups[key].append(r)

    funds = []
    for key, rows in groups.items():
        sheet, name, pt = key
        display = f"{name}·{pt}" if pt else name
        by_wk = {r["week"]: r for r in rows}
        weekly = [None] * n_weeks; ytd = [None] * n_weeks
        weekly_ex = [None] * n_weeks; ytd_ex = [None] * n_weeks
        mdd = [None] * n_weeks; mdd_ex = [None] * n_weeks
        for r in rows:
            i = r["week"]
            weekly[i] = r["ret"]; ytd[i] = r["ytd"]
            weekly_ex[i] = r["ret_ex"]; ytd_ex[i] = r["ytd_ex"]
            mdd[i] = r["mdd"]; mdd_ex[i] = r["mdd_ex"]

        # ---- 缺失周收益回填（仅限前后周都有官方 YTD 的连续缺口）----
        for i in range(n_weeks):
            if weekly[i] is None and ytd[i] is not None and i > 0 and ytd[i - 1] is not None:
                weekly[i] = (1 + ytd[i]) / (1 + ytd[i - 1]) - 1

        # ---- YTD 逐周跳变检测（仅限“连续在录”周，避免缺周跨期误判）----
        # 若 (1+ytd_t)/(1+ytd_{t-1})-1 与 当周收益 偏差 > 5pp，判定该周 YTD 异常；
        # 先基于原始 YTD 计算异常掩码，再统一置空，避免级联误报。
        ytd_anomaly_weeks = []
        for i in range(1, n_weeks):
            if ytd[i] is not None and ytd[i - 1] is not None and weekly[i] is not None:
                implied = (1 + ytd[i]) / (1 + ytd[i - 1]) - 1
                if abs(implied - weekly[i]) > 0.05:
                    ytd_anomaly_weeks.append(i)
        for i in ytd_anomaly_weeks:
            ytd[i] = None
        ytd_unreliable = len(ytd_anomaly_weeks) > 0

        nav_official = [None] * n_weeks; nav_chained = [None] * n_weeks
        nav_excess = [None] * n_weeks
        cum = 1.0; cum_ex = 1.0
        for i in range(n_weeks):
            has = weekly[i] is not None or ytd[i] is not None
            if weekly[i] is not None:
                cum *= (1 + weekly[i])
            if has:
                nav_chained[i] = round(cum, 6)
                nav_official[i] = round(1 + ytd[i], 6) if ytd[i] is not None else round(cum, 6)
            if weekly_ex[i] is not None:
                cum_ex *= (1 + weekly_ex[i])
            if has:
                nav_excess[i] = round(cum_ex, 6)

        wks = sorted(by_wk)
        complete = len(wks) == n_weeks and all(w is not None for w in weekly)
        restated = bool(complete and nav_official[-1] is not None and nav_chained[-1] is not None
                        and abs(nav_official[-1] - nav_chained[-1]) > 0.02)
        incomplete = len(wks) < n_weeks

        wvals = [w for w in weekly if w is not None]
        rets = np.array(wvals, dtype=float) if wvals else np.array([])
        last = rows[-1]
        latest = {"weekly": weekly[-1], "ytd": ytd[-1],
                  "excess_ytd": ytd_ex[-1], "ret_1y": None, "vol": None,
                  "mdd": mdd[-1], "sharpe": None, "calmar": None, "corr": None}
        st = {}
        if len(rets) >= 2:
            st["vol_ann"] = round(float(np.std(rets, ddof=1) * math.sqrt(52)), 4)
        else:
            st["vol_ann"] = None
        valid = [x for x in nav_chained if x is not None]
        peak = -np.inf; maxdd = 0.0
        for x in valid:
            peak = max(peak, x); maxdd = min(maxdd, x / peak - 1)
        st["maxdd_chained"] = round(maxdd, 4) if valid else None
        if wvals:
            st["best_week"] = round(max(wvals), 4); st["worst_week"] = round(min(wvals), 4)
            st["win_rate"] = round(sum(1 for w in wvals if w > 0) / len(wvals), 4)
        else:
            st["best_week"] = st["worst_week"] = st["win_rate"] = None
        st["sharpe_est"] = None
        if st.get("vol_ann") and len(rets) >= 2:
            mean_ann = float(np.mean(rets)) * 52
            st["sharpe_est"] = round((mean_ann - 0.02) / st["vol_ann"], 2)

        funds.append({
            "id": f"{sheet}::{display}",
            "strategy": sheet, "name": display, "institution": name, "suffix": pt,
            "scale": last["scale"], "weeks_present": len(wks),
            "first_week": wks[0], "last_week": wks[-1],
            "latest": latest, "stats": st, "restated": restated, "incomplete": incomplete,
            "ytd_unreliable": ytd_unreliable,
            "ytd_anomaly_weeks": ytd_anomaly_weeks,
            "series": {"weeks": wks, "weekly": weekly, "ytd": ytd,
                       "weekly_ex": weekly_ex, "ytd_ex": ytd_ex,
                       "mdd": mdd, "mdd_ex": mdd_ex,
                       "nav_official": nav_official, "nav_chained": nav_chained,
                       "nav_excess": nav_excess},
        })
    print(f"      {len(funds)} 条管理人序列")

    print("[4/5] 策略汇总 + 基准 ...")
    strat_summary = {}
    for strat in strat_order:
        fs = [f for f in funds if f["strategy"] == strat]
        if not fs:
            continue
        med = []; mean = []; cnt = []; nav_eq = [None] * n_weeks
        src_stats = [None] * n_weeks
        cum = 1.0
        for i in range(n_weeks):
            vals = [f["series"]["weekly"][i] for f in fs if f["series"]["weekly"][i] is not None]
            cnt.append(len(vals))
            med.append(round(float(np.median(vals)), 4) if vals else None)
            mean.append(round(float(np.mean(vals)), 4) if vals else None)
            if vals:
                cum *= (1 + float(np.mean(vals)))
            nav_eq[i] = round(cum, 6)
            sm = sheet_meta.get(strat, {}).get(i, {})
            raw_stats = sm.get("stats") or {}
            src_stats[i] = {k: v for k, v in raw_stats.items() if abs(v) <= 1.0} or None
        strat_summary[strat] = {
            "fund_count": len(fs), "median_weekly": med, "mean_weekly": mean,
            "count": cnt, "nav_equal_weight": nav_eq, "source_stats": src_stats,
        }

    # 基准：合并所有 sheet 行0 的指数周收益
    bench_series: dict[str, dict] = {}
    bench_of_strat: dict[str, str] = {}
    for strat, wmeta in sheet_meta.items():
        if strat not in strat_summary:
            continue
        for wi, meta in wmeta.items():
            for b in meta.get("benches", []):
                bs = bench_series.setdefault(b["name"], {"name": b["name"], "weekly": [None] * n_weeks})
                if bs["weekly"][wi] is None:
                    bs["weekly"][wi] = round(b["value"], 6)
        bens = []
        for wi in range(n_weeks):
            for b in wmeta.get(wi, {}).get("benches", []):
                bens.append(b["name"])
        if bens:
            bench_of_strat[strat] = bens[0]

    benchmarks = {}
    for name, bs in bench_series.items():
        nav = [None] * n_weeks
        cum = 1.0; started = False
        for i in range(n_weeks):
            v = bs["weekly"][i]
            if v is not None:
                started = True
                cum *= (1 + v)
            nav[i] = round(cum, 6) if started else None
        benchmarks[name] = {"name": name, "weekly": bs["weekly"], "nav": nav,
                            "ytd_latest": round(nav[-1] - 1, 4) if nav[-1] else None}
    print(f"      {len(benchmarks)} 个基准指数, {len(bench_of_strat)} 个策略关联基准")

    # 基金相对基准超额（链乘净值比）
    for f in funds:
        bk = bench_of_strat.get(f["strategy"])
        f["bench_key"] = bk
        f["series"]["nav_excess_bench"] = None
        if bk and bk in benchmarks:
            bn = benchmarks[bk]["nav"]
            ex = []
            for i, nav in enumerate(f["series"]["nav_chained"]):
                if nav is not None and bn[i] is not None:
                    ex.append(round(nav / bn[i] - 1, 5))
                else:
                    ex.append(None)
            f["series"]["nav_excess_bench"] = ex
            if ex and ex[-1] is not None:
                f["latest"]["excess_bench_ytd"] = ex[-1]

    print("[5/5] 输出 ...")
    qa = {
        "source": "无鱼内参",
        "source_files": len(files), "weeks": n_weeks,
        "fund_rows": len(records), "fund_series": len(funds),
        "strategies": strat_order,
        "missing_weekly_rows": sum(1 for r in records if r["ret"] is None),
        "missing_ytd_rows": sum(1 for r in records if r["ytd"] is None),
        "restated_series": sorted(
            [{"fund": f["name"], "strategy": f["strategy"],
              "official": round(f["series"]["nav_official"][-1] - 1, 4),
              "chained": round(f["series"]["nav_chained"][-1] - 1, 4)}
             for f in funds if f["restated"]],
            key=lambda x: -abs(x["official"] - x["chained"])),
        "ytd_anomaly_funds": sum(1 for f in funds if f["ytd_unreliable"]),
        "ytd_anomaly_points": sum(len(f["ytd_anomaly_weeks"]) for f in funds),
        "ytd_anomaly_by_week": {weeks[i]["label"]: n for i, n in sorted(
            Counter(wi for f in funds for wi in f["ytd_anomaly_weeks"]).items())},
        "notes": notes,
        "benchmarks": {k: v["name"] for k, v in benchmarks.items()},
    }

    def sanitize(o):
        if isinstance(o, dict):
            return {k: sanitize(v) for k, v in o.items()}
        if isinstance(o, list):
            return [sanitize(v) for v in o]
        if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
            return None
        return o

    payload = {
        "meta": {
            "generated_at": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S"),
            "source_dir": os.path.basename(os.path.normpath(args.source)),
            "weeks": [{"idx": w["idx"], "start": w["start"].isoformat(),
                       "end": w["end"].isoformat(), "label": w["label"]} for w in weeks],
            "strategies": strat_order,
            "bench_strategies": bench_of_strat,
        },
        "funds": [], "strategy_summary": strat_summary,
        "benchmarks": benchmarks, "qa": qa,
    }
    for f in funds:
        s = f["series"]
        payload["funds"].append({
            **{k: f[k] for k in ("id", "strategy", "name", "institution", "suffix",
                                 "scale", "weeks_present", "first_week", "last_week",
                                 "latest", "stats", "bench_key", "restated", "incomplete",
                                 "ytd_unreliable", "ytd_anomaly_weeks")},
            "series": {
                "weeks": s["weeks"],
                "weekly": [None if v is None else round(v, 4) for v in s["weekly"]],
                "ytd": [None if v is None else round(v, 4) for v in s["ytd"]],
                "weekly_ex": [None if v is None else round(v, 4) for v in s["weekly_ex"]],
                "ytd_ex": [None if v is None else round(v, 4) for v in s["ytd_ex"]],
                "mdd": [None if v is None else round(v, 4) for v in s["mdd"]],
                "nav_official": [None if v is None else round(v, 4) for v in s["nav_official"]],
                "nav_chained": [None if v is None else round(v, 4) for v in s["nav_chained"]],
                "nav_excess": [None if v is None else round(v, 4) for v in s["nav_excess"]],
                "nav_excess_bench": s.get("nav_excess_bench"),
            },
        })
    payload = sanitize(payload)
    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, "dashboard_data.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    print(f"      -> {out_path} ({os.path.getsize(out_path)/1024:.0f} KB)")

    # QA 报告
    lines = [
        "# 无鱼内参 · 数据质量报告", "",
        f"- 生成时间：{payload['meta']['generated_at']}",
        f"- 源文件数：{qa['source_files']} | 交易周：{qa['weeks']}",
        f"- 记录行数：{qa['fund_rows']} | 管理人·策略序列：{qa['fund_series']}",
        f"- 策略分类：{'、'.join(strat_order)}",
        f"- 缺失区间收益：{qa['missing_weekly_rows']} | 缺失YTD：{qa['missing_ytd_rows']}",
        "", "## 疑似源数据修正（完整序列，官方YTD vs 复利偏差>2%）", "",
    ]
    if qa["restated_series"]:
        for r in qa["restated_series"][:30]:
            lines.append(f"- {r['strategy']} {r['fund']}: 官方 {r['official']:+.2%} vs 复利 {r['chained']:+.2%}")
        if len(qa["restated_series"]) > 30:
            lines.append(f"- …共 {len(qa['restated_series'])} 条")
    else:
        lines.append("- 无")
    lines += ["", "## 处理记录", ""]
    for n in notes:
        lines.append(f"- [{n['type']}] {n.get('file','')} {n.get('sheet','')} {n['detail']}")
    qa_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "DATA_QUALITY_REPORT.md"))
    with open(qa_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"      -> {qa_path}")


if __name__ == "__main__":
    main()
