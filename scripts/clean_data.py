#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
私募策略业绩周刊 —— 数据清洗与建模管线
=========================================
读取「私募周报」目录下全部《量化策略业绩周刊》xlsx，清洗为连贯的面板数据：

  * 统一 7+ 个策略 sheet 的异构表头 / 错位列 / 百分比格式 / 汇总行
  * 剔除「市场中性1」重复 sheet、剔除「均值/平均值」汇总行
  * 统一管理人身份（机构·策略后缀），补齐缺失的后缀
  * 以「报告期」为交易周网格（天然剔除非交易日/休市周，如春节周缺失）
  * 构造三条累计净值：官方今年收益、当周收益复利、超额收益
  * 对齐 A 股指数（沪深300/中证500/中证1000/中证2000/红利/中证全指）周度收益
  * 输出 web 前端所需的 JSON + 一份数据质量报告

用法:
  python3 scripts/clean_data.py [--source ../私募周报] [--out public/data]

依赖: pandas, openpyxl, numpy
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
# 常量
# ----------------------------------------------------------------------------
SCALE_VALS = {"百亿", "未百亿"}
STRATEGY_ORDER = ["300指增", "500指增", "1000指增", "2000指增", "红利指增",
                  "全市场选股", "市场中性", "灵活对冲"]
SUFFIX_ALIAS = {"300": "300中性", "500": "500中性", "1000": "1000中性",
                "2000": "2000中性", "混合": "混合中性", "对冲": "灵活对冲"}
SUFFIX_RE = re.compile(
    r"(300中性|500中性|1000中性|2000中性|混合中性|灵活对冲|"
    r"300指增|500指增|1000指增|2000中性|2000指增|红利指增|中性|对冲|指增)$")

# 需要“错位列”修复的 (文件前缀, sheet)：这些文件里 管理规模 列实际是当周收益(%)，
# 整行数据相对表头右移一列（且无策略列）。
SHIFTED_LAYOUT = {
    ("20260209-0213", "灵活对冲"),
    ("20260223-0227", "灵活对冲"),
    ("20260302-0306", "灵活对冲"),
}

BENCH_MAP = {  # 策略 -> 基准指数
    "300指增": "csi300",
    "500指增": "csi500",
    "1000指增": "csi1000",
    "2000指增": "csi2000",
    "红利指增": "dividend",
    "全市场选股": "csi_all",
}


# ----------------------------------------------------------------------------
# 基础工具
# ----------------------------------------------------------------------------
def to_num(v) -> float | None:
    """宽容地把单元格转成 float：支持百分比字符串、+/- 号、千分位。"""
    if v is None:
        return None
    if isinstance(v, (float, np.floating)) and math.isnan(float(v)):
        return None
    if isinstance(v, (int, float, np.floating, np.integer)):
        return float(v)
    s = str(v).strip().replace(",", "")
    if s in ("", "-", "nan", "None", "N/A", "--"):
        return None
    try:
        if s.endswith("%"):
            return float(s[:-1]) / 100.0
        return float(s)
    except ValueError:
        return None


def parse_period(title: str) -> tuple[date, date] | None:
    """从 sheet 标题解析报告期，如 300指增（报告期：01.05~01.09）"""
    m = re.search(r"(\d{2})\.(\d{2})~(\d{2})\.(\d{2})", title)
    if not m:
        return None
    m1, d1, m2, d2 = (int(x) for x in m.groups())
    return date(2026, m1, d1), date(2026, m2, d2)


def norm_suffix(s: str | None) -> str | None:
    if not s:
        return None
    s = s.strip()
    if s in SUFFIX_ALIAS:
        return SUFFIX_ALIAS[s]
    return s


def split_identity(name: str) -> tuple[str, str | None]:
    """把管理人名称拆成 (机构, 策略后缀)。"""
    name = name.strip()
    if "·" in name:
        parts = name.split("·")
        inst = parts[0].strip()
        suf = "·".join(parts[1:]).strip()
        return inst, norm_suffix(suf) if suf else None
    m = SUFFIX_RE.search(name)
    if m:
        return name[: m.start()].strip(), norm_suffix(m.group(1))
    return name, None


# ----------------------------------------------------------------------------
# Sheet 解析
# ----------------------------------------------------------------------------
def parse_sheet(raw: pd.DataFrame, file_key: str, sheet: str) -> list[dict]:
    """解析单个 sheet，返回 fund 记录列表（不包含身份补齐）。"""
    nrows, ncols = raw.shape
    if nrows < 3 or ncols < 3:
        return []
    title = str(raw.iloc[0, 0])
    period = parse_period(title)
    hdr = [str(c).strip() for c in raw.iloc[1].tolist()]
    if "当周收益" not in hdr:
        return []

    shifted = (file_key, sheet) in SHIFTED_LAYOUT

    def col(name):
        return hdr.index(name) if name in hdr else None

    idx_inst = 0
    idx_scale = col("管理规模")
    idx_strategy = col("策略")
    idx_week = col("当周收益")
    idx_week_ex = col("当周超额")
    idx_ytd = col("今年收益")
    idx_ytd_ex = col("今年超额")
    idx_1y = col("近一年收益")
    idx_vol = col("波动率")
    idx_mdd = col("最大回撤")
    idx_sharpe = col("夏普比率")
    idx_calmar = col("卡玛比率")
    idx_corr = [col(c) for c in ("300相关性", "500相关性", "1000相关性",
                                  "2000相关性", "最小市值相关性")]

    records = []
    for i in range(2, nrows):
        row = raw.iloc[i]
        inst_raw = row.iloc[idx_inst]
        if not isinstance(inst_raw, str):
            continue
        inst = inst_raw.strip()
        if inst in ("", "nan", "None") or "均值" in inst or "平均" in inst:
            continue

        rec = {
            "raw_name": inst,
            "institution": inst,
            "suffix": None,
            "scale": None,
            "weekly": None, "ytd": None,
            "weekly_ex": None, "ytd_ex": None,
            "ret_1y": None, "vol": None, "mdd": None,
            "sharpe": None, "calmar": None,
            "corr": [None] * 5,
        }

        def get(idx):
            return row.iloc[idx] if idx is not None and idx < ncols else None

        if shifted:
            # 错位布局：col1=规模，col2=当周收益(%), col3=今年收益, ...
            rec["scale"] = str(get(1)).strip() if isinstance(get(1), str) else None
            rec["weekly"] = to_num(get(2))
            rec["ytd"] = to_num(get(3))
            rec["ret_1y"] = to_num(get(4))
            rec["vol"] = to_num(get(5))
            rec["mdd"] = to_num(get(6))
            rec["sharpe"] = to_num(get(7))
            rec["calmar"] = to_num(get(8))
            corr_vals = [to_num(get(9 + j)) for j in range(5)]
            for j, cv in enumerate(corr_vals):
                rec["corr"][j] = cv if cv is not None and -1.0 <= cv <= 1.0 else None
        else:
            # 策略列（如果有且值看起来像策略后缀）
            if idx_strategy is not None:
                sv = get(idx_strategy)
                if isinstance(sv, str) and sv.strip() and sv.strip() not in SCALE_VALS:
                    rec["suffix"] = norm_suffix(sv.strip())
            # 管理规模
            if idx_scale is not None:
                sv = get(idx_scale)
                if isinstance(sv, str) and sv.strip() in SCALE_VALS:
                    rec["scale"] = sv.strip()
                elif isinstance(sv, str) and rec["suffix"] is None \
                        and sv.strip() and not sv.strip().endswith("%"):
                    # 某些文件把策略后缀误放进“管理规模”列
                    rec["suffix"] = norm_suffix(sv.strip())
            # 收益指标
            rec["weekly"] = to_num(get(idx_week))
            rec["ytd"] = to_num(get(idx_ytd))
            rec["weekly_ex"] = to_num(get(idx_week_ex))
            rec["ytd_ex"] = to_num(get(idx_ytd_ex))
            rec["ret_1y"] = to_num(get(idx_1y))
            rec["vol"] = to_num(get(idx_vol))
            rec["mdd"] = to_num(get(idx_mdd))
            rec["sharpe"] = to_num(get(idx_sharpe))
            rec["calmar"] = to_num(get(idx_calmar))
            for j, cidx in enumerate(idx_corr):
                cv = to_num(get(cidx))
                rec["corr"][j] = cv if cv is not None and -1.0 <= cv <= 1.0 else None

        # 名称里可能内嵌后缀（千象混合中性 / 正定500中性）
        if rec["suffix"] is None:
            inst2, suf = split_identity(inst)
            rec["institution"] = inst2
            rec["suffix"] = suf

        # 灵活对冲 sheet 未写后缀时，补为“灵活对冲”
        if sheet == "灵活对冲" and rec["suffix"] is None:
            rec["suffix"] = "灵活对冲"

        rec["period"] = period
        records.append(rec)
    return records


# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------
def load_funds(source_dir: str) -> tuple[list[dict], list[dict], list[dict]]:
    """返回 (funds, weeks, qa_notes)。"""
    files = sorted(glob.glob(os.path.join(source_dir, "*.xlsx")))
    files = [f for f in files if not os.path.basename(f).startswith("~$")]
    if not files:
        raise SystemExit(f"未在 {source_dir} 找到 xlsx 文件")

    weeks: dict[tuple[date, date], dict] = {}
    qa_notes: list[dict] = []
    records: list[dict] = []

    for f in files:
        fkey = os.path.basename(f).split("_")[-1].split(".")[0]  # 20260105-0109
        xl = pd.ExcelFile(f)
        for sheet in xl.sheet_names:
            if sheet == "市场中性1":
                qa_notes.append({"type": "dropped_sheet", "file": os.path.basename(f),
                                 "detail": "剔除重复 sheet「市场中性1」"})
                continue
            if sheet not in STRATEGY_ORDER:
                qa_notes.append({"type": "unknown_sheet", "file": os.path.basename(f),
                                 "sheet": sheet, "detail": f"未知 sheet，跳过：{sheet}"})
                continue
            raw = pd.read_excel(f, sheet_name=sheet, header=None)
            recs = parse_sheet(raw, fkey, sheet)
            for r in recs:
                r["file"] = os.path.basename(f)
                r["sheet"] = sheet
                if r["period"] is None:
                    qa_notes.append({"type": "no_period", "file": os.path.basename(f),
                                     "sheet": sheet, "detail": "无法解析报告期"})
                    continue
                weeks.setdefault(r["period"], {"start": r["period"][0],
                                               "end": r["period"][1],
                                               "files": set()})
                weeks[r["period"]]["files"].add(os.path.basename(f))
                records.append(r)

    week_list = sorted(weeks.values(), key=lambda w: w["start"])
    for i, w in enumerate(week_list):
        w["idx"] = i
    week_lookup = {(w["start"], w["end"]): w for w in week_list}

    for r in records:
        r["week_idx"] = week_lookup[r["period"]]["idx"]

    # ---- 身份补齐：市场中性缺失后缀 -------------------------------------
    neutral = [r for r in records if r["sheet"] == "市场中性"]
    inst_suffixes: dict[str, Counter] = defaultdict(Counter)
    for r in neutral:
        if r["suffix"]:
            inst_suffixes[r["institution"]][r["suffix"]] += 1

    for r in neutral:
        if r["suffix"] is None:
            cnt = inst_suffixes.get(r["institution"])
            if cnt:
                # 唯一后缀 -> 直接补齐；多个后缀 -> 取众数并记录 QA
                suf, n = cnt.most_common(1)[0]
                r["suffix"] = suf
                if len(cnt) > 1:
                    qa_notes.append({
                        "type": "suffix_inferred", "file": r["file"],
                        "detail": f"市场中性 {r['institution']} 缺失后缀，按众数补为 {suf}",
                    })
            else:
                qa_notes.append({"type": "suffix_missing", "file": r["file"],
                                 "detail": f"市场中性 {r['institution']} 无法确定后缀"})

    # ---- 关键字段数值化 & 合理性清洗 --------------------------------------
    dropped = 0
    for r in records:
        # 当周收益缺失但今年收益前后可推 -> 留待面板阶段推导；这里仅剔除极端值
        w = r["weekly"]
        if w is not None and (w > 1.0 or w < -0.9):
            qa_notes.append({"type": "extreme_weekly", "file": r["file"],
                             "sheet": r["sheet"], "detail": f"{r['institution']} 当周收益 {w:.4f} 异常，置空"})
            r["weekly"] = None
        y = r["ytd"]
        if y is not None and (y > 5.0 or y < -2.0):
            qa_notes.append({"type": "extreme_ytd", "file": r["file"],
                             "sheet": r["sheet"], "detail": f"{r['institution']} 今年收益 {y:.4f} 异常，置空"})
            r["ytd"] = None

    return records, week_list, qa_notes


def build_fund_panels(records: list[dict], weeks: list[dict]) -> tuple[list[dict], list[dict]]:
    """把长表聚合成每个 管理人·策略 的周度面板。"""
    n_weeks = len(weeks)
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in records:
        key = (r["sheet"], f"{r['institution']}·{r['suffix']}" if r["suffix"]
               else r["institution"])
        groups[key].append(r)

    funds = []
    qa_notes = []
    for (sheet, key), rows in groups.items():
        by_wk = {r["week_idx"]: r for r in rows}
        wks = sorted(by_wk)
        weekly = [None] * n_weeks
        ytd = [None] * n_weeks
        weekly_ex = [None] * n_weeks
        ytd_ex = [None] * n_weeks

        for r in rows:
            i = r["week_idx"]
            weekly[i] = r["weekly"]
            ytd[i] = r["ytd"]
            weekly_ex[i] = r["weekly_ex"]
            ytd_ex[i] = r["ytd_ex"]

        # 缺失当周收益 -> 由今年收益倒推（仅当前后两周官方 YTD 都在）
        for i in range(n_weeks):
            if weekly[i] is None and ytd[i] is not None:
                prev = next((ytd[j] for j in range(i - 1, -1, -1) if ytd[j] is not None), None)
                if prev is not None:
                    weekly[i] = (1 + ytd[i]) / (1 + prev) - 1

        # 累计净值
        nav_official = [None] * n_weeks
        nav_chained = [None] * n_weeks
        nav_excess = [None] * n_weeks
        cum = 1.0
        cum_ex = 1.0
        for i in range(n_weeks):
            if weekly[i] is not None:
                cum *= (1 + weekly[i])
            nav_chained[i] = round(cum, 6)
            if ytd[i] is not None:
                nav_official[i] = round(1 + ytd[i], 6)
            else:
                nav_official[i] = nav_chained[i]
            if weekly_ex[i] is not None:
                cum_ex *= (1 + weekly_ex[i])
            nav_excess[i] = round(cum_ex, 6)

        # 统计指标
        wvals = [w for w in weekly if w is not None]
        rets = np.array(wvals, dtype=float) if wvals else np.array([])
        n = len(wvals)
        last = rows[-1] if rows else {}
        latest = {
            "weekly": weekly[-1] if weekly[-1] is not None else None,
            "ytd": ytd[-1] if ytd[-1] is not None else None,
            "excess_ytd": ytd_ex[-1] if ytd_ex[-1] is not None else None,
            "ret_1y": last.get("ret_1y"),
            "vol": last.get("vol"),
            "mdd": last.get("mdd"),
            "sharpe": last.get("sharpe"),
            "calmar": last.get("calmar"),
            "corr": last.get("corr"),
        }
        stats = {}
        if n >= 2:
            stats["vol_ann"] = round(float(np.std(rets, ddof=1) * math.sqrt(52)), 4)
        else:
            stats["vol_ann"] = None
        valid_nav = [x for x in nav_chained if x is not None]
        if valid_nav:
            peak = -np.inf
            maxdd = 0.0
            for x in valid_nav:
                peak = max(peak, x)
                maxdd = min(maxdd, x / peak - 1)
            stats["maxdd_chained"] = round(maxdd, 4)
        else:
            stats["maxdd_chained"] = None
        if wvals:
            stats["best_week"] = round(max(wvals), 4)
            stats["worst_week"] = round(min(wvals), 4)
            stats["win_rate"] = round(sum(1 for w in wvals if w > 0) / len(wvals), 4)
        else:
            stats["best_week"] = stats["worst_week"] = stats["win_rate"] = None
        if latest["sharpe"] is None and stats.get("vol_ann"):
            # 近似年化夏普（无风险利率按 2%）
            mean_ann = float(np.mean(rets)) * 52
            stats["sharpe_est"] = round((mean_ann - 0.02) / stats["vol_ann"], 2) \
                if stats["vol_ann"] else None
        else:
            stats["sharpe_est"] = None

        # 与基准的逐周超额（面板阶段算好）
        excess_vs_bench = None  # 依赖 benchmark，留到 build 后补充

        funds.append({
            "id": f"{sheet}::{key}",
            "strategy": sheet,
            "name": key,
            "institution": key.split("·")[0],
            "suffix": key.split("·")[1] if "·" in key else None,
            "scale": last.get("scale"),
            "weeks_present": len(wks),
            "first_week": wks[0],
            "last_week": wks[-1],
            "latest": latest,
            "stats": stats,
            "series": {
                "weeks": wks,
                "weekly": weekly,
                "ytd": ytd,
                "nav_official": nav_official,
                "nav_chained": nav_chained,
                "weekly_ex": weekly_ex,
                "ytd_ex": ytd_ex,
                "nav_excess": nav_excess,
            },
        })
    return funds, qa_notes


def build_strategy_summary(funds: list[dict], weeks: list[dict]) -> dict:
    n_weeks = len(weeks)
    out = {}
    for strat in STRATEGY_ORDER:
        fs = [f for f in funds if f["strategy"] == strat]
        if not fs:
            continue
        median_weekly = []
        mean_weekly = []
        count = []
        nav_equal = [None] * n_weeks
        cum = 1.0
        for i in range(n_weeks):
            vals = []
            for f in fs:
                v = f["series"]["weekly"][i]
                if v is not None:
                    vals.append(v)
            count.append(len(vals))
            median_weekly.append(round(float(np.median(vals)), 4) if vals else None)
            mean_weekly.append(round(float(np.mean(vals)), 4) if vals else None)
            if vals:
                cum *= (1 + float(np.mean(vals)))
            nav_equal[i] = round(cum, 6)
        out[strat] = {
            "fund_count": len(fs),
            "median_weekly": median_weekly,
            "mean_weekly": mean_weekly,
            "count": count,
            "nav_equal_weight": nav_equal,
        }
    return out


def build_benchmarks(weeks: list[dict], bench_raw: dict) -> tuple[dict, list[dict]]:
    """把日线指数对齐到报告期周网格，计算周收益与累计净值。"""
    qa = []
    out = {}
    for key, info in bench_raw.items():
        rows = info.get("data") or []
        if not rows:
            qa.append({"type": "benchmark_empty", "key": key, "detail": "无日线数据"})
            continue
        closes = {}
        for r in rows:
            d = str(r["date"]).replace("-", "")[:8]
            closes[d] = float(r["close"])

        def close_on_or_before(d: date):
            cur = d
            for _ in range(12):
                ds = cur.strftime("%Y%m%d")
                if ds in closes:
                    return closes[ds]
                cur = date.fromordinal(cur.toordinal() - 1)
            return None

        # 基期：第一个报告期开始前最近交易日
        base_d = weeks[0]["start"].toordinal() - 1
        base_close = close_on_or_before(date.fromordinal(base_d))
        if base_close is None:
            qa.append({"type": "benchmark_no_base", "key": key})
            continue

        weekly = []
        nav = []
        prev_close = base_close
        cum = 1.0
        for w in weeks:
            end_close = close_on_or_before(w["end"])
            if end_close is None:
                weekly.append(None)
                nav.append(round(cum, 6))
                qa.append({"type": "benchmark_gap", "key": key,
                           "week": w["start"].isoformat(), "detail": "周内无行情"})
                continue
            r = end_close / prev_close - 1
            prev_close = end_close
            cum *= (1 + r)
            weekly.append(round(r, 6))
            nav.append(round(cum, 6))

        out[key] = {
            "name": info.get("name", key),
            "symbol": info.get("symbol"),
            "source": info.get("source"),
            "last_date": rows[-1]["date"],
            "weekly": weekly,
            "nav": nav,
            "ytd_latest": round(nav[-1] - 1, 4) if nav and nav[-1] else None,
        }
    return out, qa


def build_fund_bench_excess(funds: list[dict], benchmarks: dict) -> None:
    """为每个 fund 计算相对其策略基准的累计超额。"""
    for f in funds:
        bkey = BENCH_MAP.get(f["strategy"])
        if bkey and bkey in benchmarks:
            bn = benchmarks[bkey]["nav"]
            f["bench_key"] = bkey
            ex = []
            for i, nav in enumerate(f["series"]["nav_chained"]):
                if nav is not None and bn[i] is not None:
                    ex.append(round(nav / bn[i] - 1, 5))
                else:
                    ex.append(None)
            f["series"]["nav_excess_bench"] = ex
            if ex and ex[-1] is not None:
                f["latest"]["excess_bench_ytd"] = ex[-1]
        else:
            f["bench_key"] = None


def build_qa(records, funds, weeks, benchmarks, qa_notes) -> dict:
    n_weeks = len(weeks)
    total_rows = len(records)
    miss_weekly = sum(1 for r in records if r["weekly"] is None)
    miss_ytd = sum(1 for r in records if r["ytd"] is None)

    restated = []
    for f in funds:
        if f["first_week"] == 0 and f["last_week"] == n_weeks - 1:
            o = f["series"]["nav_official"][-1]
            c = f["series"]["nav_chained"][-1]
            if o is not None and c is not None and abs(o - c) > 0.02:
                restated.append({
                    "fund": f["name"], "strategy": f["strategy"],
                    "official": round(o - 1, 4), "chained": round(c - 1, 4),
                })

    return {
        "source_files": len({r["file"] for r in records}),
        "weeks": n_weeks,
        "fund_rows": total_rows,
        "fund_series": len(funds),
        "strategies": sorted({r["sheet"] for r in records}),
        "missing_weekly_rows": miss_weekly,
        "missing_ytd_rows": miss_ytd,
        "restated_series": sorted(restated, key=lambda x: -abs(x["official"] - x["chained"])),
        "notes": qa_notes,
        "benchmarks": {k: v.get("source") for k, v in benchmarks.items()},
    }


def round_list(lst, nd=4):
    return None if lst is None else [None if v is None else round(v, nd) for v in lst]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=os.path.normpath(
        os.path.join(os.path.dirname(__file__), "..", "..", "私募周报")))
    ap.add_argument("--bench", default=os.path.normpath(
        os.path.join(os.path.dirname(__file__), "..", "data", "benchmarks_raw.json")))
    ap.add_argument("--out", default=os.path.normpath(
        os.path.join(os.path.dirname(__file__), "..", "public", "data")))
    args = ap.parse_args()

    print(f"[1/5] 解析源数据: {args.source}")
    records, weeks, qa_notes = load_funds(args.source)
    print(f"      {len(records)} 条记录, {len(weeks)} 个交易周")

    print("[2/5] 构建管理人面板 ...")
    funds, qa_panel = build_fund_panels(records, weeks)
    qa_notes.extend(qa_panel)
    print(f"      {len(funds)} 条管理人·策略序列")

    print("[3/5] 策略汇总 ...")
    strat_summary = build_strategy_summary(funds, weeks)

    print("[4/5] 对齐指数基准 ...")
    with open(args.bench, encoding="utf-8") as f:
        bench_raw = json.load(f)
    benchmarks, qa_bench = build_benchmarks(weeks, bench_raw)
    qa_notes.extend(qa_bench)
    build_fund_bench_excess(funds, benchmarks)
    print(f"      {len(benchmarks)} 个指数")

    print("[5/5] 输出 JSON + QA ...")
    os.makedirs(args.out, exist_ok=True)

    payload = {
        "meta": {
            "generated_at": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S"),
            "source_dir": os.path.basename(os.path.normpath(args.source)),
            "weeks": [{"idx": w["idx"], "start": w["start"].isoformat(),
                       "end": w["end"].isoformat(),
                       "label": f"{w['start'].month:02d}.{w['start'].day:02d}~"
                                f"{w['end'].month:02d}.{w['end'].day:02d}"}
                      for w in weeks],
            "strategies": STRATEGY_ORDER,
            "bench_strategies": BENCH_MAP,
        },
        "funds": [],
        "strategy_summary": strat_summary,
        "benchmarks": benchmarks,
        "qa": build_qa(records, funds, weeks, benchmarks, qa_notes),
    }
    for f in funds:
        payload["funds"].append({
            **{k: f[k] for k in ("id", "strategy", "name", "institution", "suffix",
                                 "scale", "weeks_present", "first_week", "last_week",
                                 "latest", "stats", "bench_key")},
            "series": {
                "weeks": f["series"]["weeks"],
                "weekly": round_list(f["series"]["weekly"], 4),
                "ytd": round_list(f["series"]["ytd"], 4),
                "weekly_ex": round_list(f["series"]["weekly_ex"], 4),
                "ytd_ex": round_list(f["series"]["ytd_ex"], 4),
                "nav_official": round_list(f["series"]["nav_official"], 4),
                "nav_chained": round_list(f["series"]["nav_chained"], 4),
                "nav_excess": round_list(f["series"]["nav_excess"], 4),
                "nav_excess_bench": round_list(f["series"].get("nav_excess_bench"), 5),
            },
        })

    def sanitize(o):
        """递归把 NaN / Infinity 替换为 None（保证严格合法 JSON）。"""
        if isinstance(o, dict):
            return {k: sanitize(v) for k, v in o.items()}
        if isinstance(o, list):
            return [sanitize(v) for v in o]
        if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
            return None
        return o

    payload = sanitize(payload)
    data_path = os.path.join(args.out, "dashboard_data.json")
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"),
                  allow_nan=False)
    print(f"      -> {data_path} ({os.path.getsize(data_path)/1024:.0f} KB)")

    # QA 报告
    qa = payload["qa"]
    lines = [
        "# 私募周报数据质量报告",
        "",
        f"- 生成时间：{payload['meta']['generated_at']}",
        f"- 源文件数：{qa['source_files']} | 交易周：{qa['weeks']}",
        f"- 记录行数：{qa['fund_rows']} | 管理人·策略序列：{qa['fund_series']}",
        f"- 策略：{'、'.join(qa['strategies'])}",
        f"- 缺失当周收益：{qa['missing_weekly_rows']} | 缺失今年收益：{qa['missing_ytd_rows']}",
        "",
        "## 基准指数",
        "",
    ]
    for k, src in qa["benchmarks"].items():
        lines.append(f"- {benchmarks[k]['name']}（{k}）: {src}")
    lines += ["", "## 疑似净值重构/修正的序列（官方今年收益 vs 当周收益复利偏差 > 2%）", ""]
    if qa["restated_series"]:
        for r in qa["restated_series"][:40]:
            lines.append(f"- {r['strategy']} {r['fund']}: 官方 {r['official']:+.2%} vs 复利 {r['chained']:+.2%}")
        if len(qa["restated_series"]) > 40:
            lines.append(f"- …共 {len(qa['restated_series'])} 条")
    else:
        lines.append("- 无")
    lines += ["", "## 处理记录", ""]
    for n in qa_notes:
        lines.append(f"- [{n['type']}] {n.get('file','')} {n.get('sheet','')} {n['detail']}")

    qa_path = os.path.join(args.out, "..", "..", "DATA_QUALITY_REPORT.md")
    qa_path = os.path.normpath(qa_path)
    with open(qa_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"      -> {qa_path}")


if __name__ == "__main__":
    main()
