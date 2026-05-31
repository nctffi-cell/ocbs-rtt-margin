"""
Hook PostToolUse: khi Claude sửa docs/app.js, tự cập nhật ?v=<timestamp>
trong docs/index.html (cache-busting cho GitHub Pages).
Đọc JSON hook trên stdin, lấy tool_input.file_path. Im lặng nếu không phải app.js.
"""
import sys, json, re, os, datetime

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)

fp = (d.get("tool_input") or {}).get("file_path", "").replace("\\", "/")
if not fp.endswith("docs/app.js"):
    sys.exit(0)

idx = os.path.join(os.path.dirname(fp), "index.html")
if not os.path.exists(idx):
    sys.exit(0)

ver = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
s = open(idx, encoding="utf-8").read()
new = re.sub(r'app\.js\?v=[^"\']*', "app.js?v=" + ver, s)
if new != s:
    open(idx, "w", encoding="utf-8").write(new)
    print(f"[hook] cap nhat app.js?v={ver}")
