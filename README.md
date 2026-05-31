# OCBS — Máy tính Rtt & chi phí mượn hàng (margin)

Webapp tĩnh tính tỷ lệ ký quỹ duy trì (Rtt), sức mua và chi phí mượn hàng theo
mô hình CMRp. Deploy trên **GitHub Pages** tại domain **dautugiatri.vn**.

## Cấu trúc thư mục

```
.
├── docs/                     ← NGUỒN DUY NHẤT GitHub Pages serve
│   ├── index.html            trang chính
│   ├── app.js                toàn bộ logic tính toán
│   ├── style.css
│   ├── stocks.json           danh mục ký quỹ + giá chặn (PL1)
│   ├── prices.json           giá tham chiếu — tự cập nhật 16h mỗi ngày
│   ├── caps.json             giá chặn do người dùng chỉnh (bản tĩnh)
│   └── CNAME                 dautugiatri.vn
│
├── scripts/
│   └── update_prices_ci.py   lấy giá tham chiếu (chạy trên GitHub Actions)
├── .github/workflows/
│   └── update-prices.yml      cron 16h (T2–T6) cập nhật docs/prices.json
│
├── server.py                 server Flask để TEST LOCAL (không dùng khi deploy)
├── start_webapp.bat          double-click để chạy server.py local
│
├── excel-tools/              (gitignored) công cụ Excel cá nhân, không deploy
└── _archive/                 (gitignored) file build tạm / cũ
```

> **Một nguồn duy nhất:** mọi thứ frontend nằm trong `docs/`. Trước đây có thêm
> `static/` trùng lặp — đã gộp bỏ. Khi sửa giao diện/logic, chỉ sửa trong `docs/`.

## Chạy thử trên máy (local)

```
python -m pip install flask
start_webapp.bat        # hoặc: python server.py
```

Mở http://127.0.0.1:5000 — server proxy giá realtime qua SSI iBoard và cho phép
lưu giá chặn (`/api/caps`). Khi deploy trên Pages **không có** server: frontend tự
fallback đọc thẳng `stocks.json` / `prices.json` / `caps.json` tĩnh.

## Deploy lên GitHub Pages + domain dautugiatri.vn

### 1. Push repo
```
git push -u origin main
```

### 2. Bật GitHub Pages
Repo → **Settings → Pages**:
- **Source:** Deploy from a branch
- **Branch:** `main` — **Folder:** `/docs`
- Save.

Vài phút sau site lên tại `https://nctffi-cell.github.io/ocbs-rtt-margin/`.

### 3. Domain riêng dautugiatri.vn
File `docs/CNAME` đã chứa `dautugiatri.vn`. Tại nhà cung cấp DNS của domain, thêm:

| Loại  | Tên/Host | Giá trị |
|-------|----------|---------|
| A     | @        | 185.199.108.153 |
| A     | @        | 185.199.109.153 |
| A     | @        | 185.199.110.153 |
| A     | @        | 185.199.111.153 |
| CNAME | www      | nctffi-cell.github.io |

(4 IP trên là của GitHub Pages cho apex domain.) Sau khi DNS lan truyền, vào
Settings → Pages bật **Enforce HTTPS**.

## Cập nhật giá tự động

Workflow `.github/workflows/update-prices.yml` chạy **16:00 giờ VN (09:00 UTC)**
các ngày T2–T6, lấy giá tham chiếu phiên kế tiếp, ghi `docs/prices.json` rồi tự
commit + push. Cần GitHub Secret **`SCP_TOKEN`** (token sieucophieu.vn); thiếu
token thì tự fallback sang SSI iBoard.

Thêm secret: Repo → Settings → Secrets and variables → Actions → New secret →
tên `SCP_TOKEN`.

## Lưu ý

- Mô hình tính theo Excel CMRp (định giá theo `ts`, CMRp đặc biệt, ràng buộc X);
  Rtt/margin dùng **giá tham chiếu (refPrice)**, không phải giá mua/bán.
- `caps.json` ở gốc (do server.py ghi khi chạy local) bị gitignore; bản commit lên
  Pages là `docs/caps.json`.
