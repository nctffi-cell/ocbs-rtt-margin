"""
OCBS Margin Webapp – Flask local server
Cách dùng: double-click start_webapp.bat
"""
import json, os, sys, io, webbrowser, threading, time
from datetime import datetime
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from flask import Flask, jsonify, request, send_from_directory

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
BASE = os.path.dirname(os.path.abspath(__file__))
# Một nguồn duy nhất: docs/ (cũng là thư mục GitHub Pages serve khi deploy).
STATIC = os.path.join(BASE, "docs")
STOCKS_JSON = os.path.join(STATIC, "stocks.json")
# caps.json LOCAL (gitignored, server.py ghi đè khi chạy local).
# Lần đầu chưa có → khởi tạo từ bản tĩnh docs/caps.json.
CAPS_JSON = os.path.join(BASE, "caps.json")
if not os.path.exists(CAPS_JSON) and os.path.exists(os.path.join(STATIC, "caps.json")):
    import shutil
    shutil.copyfile(os.path.join(STATIC, "caps.json"), CAPS_JSON)

app = Flask(__name__, static_folder=STATIC)

# ── Static ─────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(STATIC, "index.html")

@app.route("/<path:fname>")
def static_file(fname):
    return send_from_directory(STATIC, fname)

# ── API: stocks master list ───────────────────────────────────
@app.route("/api/stocks")
def api_stocks():
    if not os.path.exists(STOCKS_JSON):
        return jsonify({"updated": None, "count": 0, "stocks": {}})
    mtime = os.path.getmtime(STOCKS_JSON)
    # Tránh strftime với ký tự có dấu (lỗi locale encode trên Windows): tự ghép chuỗi
    updated = "Áp dụng từ " + datetime.fromtimestamp(mtime).strftime("%d/%m/%Y")
    with open(STOCKS_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["updated"] = updated
    data["count"]   = len(data.get("stocks", {}))
    return jsonify(data)

# ── API: caps (giá chặn user-edited) ───────────────────────────
@app.route("/api/caps", methods=["GET"])
def api_caps_get():
    if not os.path.exists(CAPS_JSON):
        return jsonify({})
    with open(CAPS_JSON, "r", encoding="utf-8") as f:
        return jsonify(json.load(f))

@app.route("/api/caps", methods=["POST"])
def api_caps_post():
    data = request.get_json() or {}
    # Ghi cả bản local lẫn bản tĩnh docs/caps.json (để commit → GitHub Pages thấy).
    for path in (CAPS_JSON, os.path.join(STATIC, "caps.json")):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True, "count": len(data)})

# ── API: realtime price proxy → SSI Iboard ────────────────────
SSI_URL = "https://iboard-query.ssi.com.vn/stock/{sym}"
SSI_HEADERS = {"accept": "application/json", "user-agent": "Mozilla/5.0"}

@app.route("/api/price/<sym>")
def api_price(sym):
    sym = sym.upper().strip()
    try:
        req = Request(SSI_URL.format(sym=sym), headers=SSI_HEADERS)
        with urlopen(req, timeout=8) as r:
            data = json.loads(r.read().decode("utf-8"))
        d = (data or {}).get("data") or {}
        price = (d.get("matchedPrice") or d.get("expectedMatchedPrice")
                 or d.get("refPrice") or d.get("priorClosePrice"))
        return jsonify({
            "symbol": sym, "ok": price is not None, "price": price,
            "ceiling": d.get("ceiling"), "floor": d.get("floor"),
            "ref": d.get("refPrice"),
            "change": d.get("priceChange"), "changePct": d.get("priceChangePercent"),
            "high": d.get("highest"), "low": d.get("lowest"),
            "session": d.get("session"),
        })
    except HTTPError as e:
        return jsonify({"symbol": sym, "ok": False, "error": f"HTTP {e.code}"}), 200
    except (URLError, TimeoutError) as e:
        return jsonify({"symbol": sym, "ok": False, "error": str(e)}), 200

# ── API: bulk prices ──────────────────────────────────────────
@app.route("/api/prices")
def api_prices():
    syms = (request.args.get("symbols") or "").upper().split(",")
    syms = [s.strip() for s in syms if s.strip()]
    out = {}
    for s in syms[:30]:
        try:
            req = Request(SSI_URL.format(sym=s), headers=SSI_HEADERS)
            with urlopen(req, timeout=5) as r:
                d = (json.loads(r.read()).get("data") or {})
            p = d.get("matchedPrice") or d.get("expectedMatchedPrice") or d.get("refPrice")
            out[s] = {"price": p, "change": d.get("priceChange"),
                      "changePct": d.get("priceChangePercent")}
        except Exception as e:
            out[s] = {"price": None, "error": str(e)[:60]}
    return jsonify(out)

def open_browser():
    time.sleep(1.2)
    webbrowser.open("http://127.0.0.1:5000/")

if __name__ == "__main__":
    print("=" * 60)
    print(" OCBS Margin Webapp  →  http://127.0.0.1:5000")
    print(" Đóng cửa sổ này để tắt server")
    print("=" * 60)
    threading.Thread(target=open_browser, daemon=True).start()
    app.run(host="127.0.0.1", port=5000, debug=False)
