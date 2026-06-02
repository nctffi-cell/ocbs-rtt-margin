"""
update_prices_ci.py — Lấy giá tham chiếu cho GitHub Actions (chạy trên server GitHub).

Khác bản update_ref_prices.py (công cụ Excel cá nhân):
  - Tự chứa trong repo (Actions chỉ thấy file trong repo).
  - Đọc docs/stocks.json, ghi docs/prices.json (nguồn duy nhất GitHub Pages serve).
  - KHÔNG tự git commit/push — workflow .yml lo việc đó.

Nguồn giá:
  1. sieucophieu.vn /api/v1/stock/latest/ (batch, field 'last_price' = giá khớp cuối
     phiên = giá tham chiếu phiên kế tiếp, đơn vị nghìn đồng → ×1000). Cần token JWT
     trong env SCP_TOKEN (GitHub Secret).
  2. Fallback SSI iboard /stock/{sym} cho mã sieucophieu không trả về.

Đơn vị output: đồng (int).
"""
import sys, io, os, json, time
from datetime import datetime, timedelta, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

HERE        = os.path.dirname(os.path.abspath(__file__))
ROOT        = os.path.dirname(HERE)                       # gốc repo
DOCS        = os.path.join(ROOT, "docs")                  # nguồn duy nhất (GitHub Pages)
STOCKS_JSON = os.path.join(DOCS, "stocks.json")
OUT_DOCS    = os.path.join(DOCS, "prices.json")

SCP_LATEST_URL = "https://sieucophieu.vn/api/v1/stock/latest/?symbols={syms}"
SCP_TOKEN      = os.environ.get("SCP_TOKEN", "").strip()
SCP_BATCH      = 50
SSI_URL        = "https://iboard-query.ssi.com.vn/stock/{sym}"
UA             = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

# Giờ VN (UTC+7) — server GitHub chạy theo UTC.
VN_TZ = timezone(timedelta(hours=7))


def log(msg):
    ts = datetime.now(VN_TZ).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def next_business_day(d: datetime) -> datetime:
    nxt = d + timedelta(days=1)
    while nxt.weekday() >= 5:        # 5=Sat, 6=Sun
        nxt += timedelta(days=1)
    return nxt


def fetch_sieucophieu_batch(symbols):
    out = {}
    if not SCP_TOKEN:
        log("  (sieucophieu) bỏ qua: chưa có SCP_TOKEN")
        return out
    headers = {
        "accept": "*/*",
        "authorization": f"Bearer {SCP_TOKEN}",
        "user-agent": UA,
        "referer": "https://sieucophieu.vn/bang-dien",
    }
    for i in range(0, len(symbols), SCP_BATCH):
        chunk = symbols[i:i + SCP_BATCH]
        url = SCP_LATEST_URL.format(syms=",".join(chunk))
        try:
            with urlopen(Request(url, headers=headers), timeout=15) as r:
                data = json.loads(r.read().decode("utf-8"))
            d = data.get("data") if isinstance(data, dict) and "data" in data else data
            for sym, rec in (d or {}).items():
                v = rec.get("last_price")
                if v:
                    out[sym.upper()] = float(v) * 1000.0
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as e:
            log(f"  ! sieucophieu batch {i}: {type(e).__name__}: {e}")
        time.sleep(0.2)
    log(f"  (sieucophieu) lấy được {len(out)}/{len(symbols)} mã")
    return out


def fetch_ssi(sym):
    try:
        req = Request(SSI_URL.format(sym=sym), headers={"accept": "application/json", "user-agent": UA})
        with urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))
        d = (data or {}).get("data") or {}
        for key in ("closePrice", "matchedPrice", "lastMatchedPrice", "refPrice", "priorClosePrice"):
            v = d.get(key)
            if v:
                return float(v)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        pass
    return None


def main():
    # Guard giờ chạy: cron GitHub có thể bị delay nhiều giờ (đã gặp run lệch sang
    # 4h sáng). Giá tham chiếu chỉ đáng tin sau khi phiên đóng cửa (~15h VN), nên
    # chỉ ghi khi chạy trong khung 14h–23h giờ VN. Chạy tay (workflow_dispatch)
    # luôn được phép — để còn cập nhật thủ công khi cần.
    now = datetime.now(VN_TZ)
    event = os.environ.get("GITHUB_EVENT_NAME", "").strip()
    if event == "schedule" and not (14 <= now.hour < 23):
        log(f"Bỏ qua: cron chạy lúc {now:%H:%M} VN (ngoài khung 14h–23h, có thể do "
            f"GitHub delay). Giá lúc này không đáng tin → giữ nguyên bản cũ.")
        return 0

    if not os.path.exists(STOCKS_JSON):
        log(f"Không tìm thấy {STOCKS_JSON}")
        return 1
    with open(STOCKS_JSON, "r", encoding="utf-8") as f:
        master = json.load(f)
    stocks = master.get("stocks") or {}
    symbols = sorted(stocks.keys())
    log(f"─── Lấy giá tham chiếu cho {len(symbols)} mã ───")

    prices, ok, fail = {}, 0, 0
    for sym, p in fetch_sieucophieu_batch(symbols).items():
        if sym in stocks:
            prices[sym] = int(round(p)); ok += 1

    missing = [s for s in symbols if s not in prices]
    if missing:
        log(f"  Fallback SSI cho {len(missing)} mã…")
    for i, sym in enumerate(missing, 1):
        p = fetch_ssi(sym)
        if p:
            prices[sym] = int(round(p)); ok += 1
        else:
            fail += 1
        if i % 20 == 0:
            log(f"  …fallback {i}/{len(missing)} (ok={ok}, fail={fail})")
        time.sleep(0.15)

    if not prices:
        log("Không lấy được giá nào → KHÔNG ghi file (giữ nguyên bản cũ).")
        return 2

    # Giá vừa lấy là giá đóng cửa phiên gần nhất → áp dụng cho phiên giao dịch KẾ
    # TIẾP. Sau 15h (đã đóng cửa) thì là ngày làm việc kế tiếp; trước đó (chỉ xảy ra
    # khi chạy tay sáng sớm) coi như áp cho chính phiên hôm nay nếu là ngày làm việc.
    if now.hour >= 15:
        applies = next_business_day(now)
    elif now.weekday() < 5:
        applies = now
    else:
        applies = next_business_day(now)
    payload = {
        "updated": now.strftime("%Y-%m-%d %H:%M:%S"),
        "tradingDate": applies.strftime("%Y-%m-%d"),
        "count": len(prices),
        "prices": prices,
    }
    os.makedirs(os.path.dirname(OUT_DOCS), exist_ok=True)
    with open(OUT_DOCS, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    log(f"  ✓ Ghi {OUT_DOCS}")
    log(f"─── Tổng kết: ok={ok}, fail={fail}, lưu {len(prices)} mã, áp dụng {payload['tradingDate']} ───")
    return 0


if __name__ == "__main__":
    sys.exit(main())
