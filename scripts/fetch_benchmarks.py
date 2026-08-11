"""Fetch daily A-share index data for benchmark comparison.

Sources:
  - Tencent  (沪深300 / 中证500 / 中证1000 / 红利指数)
  - CSIndex  (中证2000 / 中证全指, official index website)
  - Sina     (fallback for Tencent symbols)

Usage:  python3 scripts/fetch_benchmarks.py [output.json]
Output: JSON with daily OHLCV per index (cache used by clean_data.py).
"""
import json, sys, time, datetime, urllib.request, os

TENCENT = {
    "csi300":  ("sh000300",  "沪深300"),
    "csi500":  ("sh000905",  "中证500"),
    "csi1000": ("sh000852",  "中证1000"),
    "dividend":("sh000015",  "红利指数"),
}
CSINDEX = {
    "csi2000": ("932000", "中证2000"),
    "csi_all": ("000985", "中证全指"),
}
DATALEN = 420
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "data", "benchmarks_raw.json"))

def http_get(url, referer="https://gu.qq.com/", timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": referer})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")

def fetch_tencent(symbol):
    url = (f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},day,,,{DATALEN},qfq")
    data = json.loads(http_get(url))
    node = (data.get("data") or {}).get(symbol) or {}
    rows = node.get("day") or node.get("qfqday") or []
    return [{"date": r[0], "open": float(r[1]), "close": float(r[2]),
             "high": float(r[3]), "low": float(r[4]), "volume": float(r[5])}
            for r in rows if len(r) >= 6]

def fetch_sina(symbol):
    url = ("https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService."
           f"getKLineData?symbol={symbol}&scale=240&ma=no&datalen={DATALEN}")
    txt = http_get(url)
    arr = json.loads(txt[txt.find("["):txt.rfind("]")+1])
    return [{"date": r["day"], "open": float(r["open"]), "close": float(r["close"]),
             "high": float(r["high"]), "low": float(r["low"]),
             "volume": float(r.get("volume") or 0)} for r in arr]

def fetch_csindex(code, start="20251201", end=""):
    end = end or datetime.date.today().strftime("%Y%m%d")
    url = (f"https://www.csindex.com.cn/csindex-home/perf/index-perf?"
           f"indexCode={code}&startDate={start}&endDate={end}")
    data = json.loads(http_get(url, referer="https://www.csindex.com.cn/"))
    rows = data.get("data") or []
    return [{"date": r["tradeDate"], "open": r.get("open"), "close": r["close"],
             "high": r.get("high"), "low": r.get("low"), "volume": r.get("tradingVol") or 0}
            for r in rows if r.get("tradeDate")]

result = {}
for key, (symbol, name) in TENCENT.items():
    try:
        d = fetch_tencent(symbol)
        if d:
            result[key] = {"name": name, "symbol": symbol, "source": "tencent", "data": d}
            print(f"{key}: {len(d)} rows via tencent, last={d[-1]['date']}")
            time.sleep(0.8)
            continue
    except Exception as e:
        print(f"{key} tencent fail: {e}")
    try:
        d = fetch_sina(symbol)
        result[key] = {"name": name, "symbol": symbol, "source": "sina", "data": d}
        print(f"{key}: {len(d)} rows via sina, last={d[-1]['date']}")
    except Exception as e:
        result[key] = {"name": name, "symbol": symbol, "data": [], "error": str(e)}
        print(f"{key}: FAILED {e}")
    time.sleep(0.8)

for key, (code, name) in CSINDEX.items():
    try:
        d = fetch_csindex(code)
        result[key] = {"name": name, "symbol": code, "source": "csindex", "data": d}
        print(f"{key}: {len(d)} rows via csindex, last={d[-1]['date']}")
    except Exception as e:
        result[key] = {"name": name, "symbol": code, "data": [], "error": str(e)}
        print(f"{key}: FAILED {e}")

out = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False)
print("saved ->", out)
