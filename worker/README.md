# Server cho phần admin của dautugiatri.vn

Web chạy trên GitHub Pages là trang **tĩnh** — tự nó không lưu được gì. File
`ocbs-worker.js` là một Cloudflare Worker đóng vai server: giữ dữ liệu admin
(tỷ lệ cho vay, room, giá chặn, hạn mức, danh mục) và trả về cho mọi người.

Admin sửa trên web → tự lưu vào Worker → **mọi người vào web thấy ngay**
(không phải chờ build lại web, không cần token trên trình duyệt).

## Cài 1 lần (~10 phút)

1. Tạo tài khoản free tại <https://dash.cloudflare.com> (không cần thẻ).
2. Vào **Workers & Pages** → **Create** → **Create Worker** → đặt tên
   `ocbs-admin` → **Deploy**.
3. Bấm **Edit code**, xoá hết code mẫu, dán toàn bộ nội dung
   [`ocbs-worker.js`](ocbs-worker.js) vào → **Deploy**.
4. Tạo kho dữ liệu: menu trái **Storage & Databases → KV** → **Create instance**
   → tên `ocbs-data` → Create.
5. Quay lại Worker `ocbs-admin` → tab **Settings** → **Bindings** →
   **Add binding** → chọn **KV namespace**:
   - Variable name: `DB`  ← *phải đúng chữ DB*
   - KV namespace: `ocbs-data`
   → Save.
6. Vẫn ở **Settings** → **Variables and Secrets** → thêm:
   | Loại | Tên | Giá trị |
   |---|---|---|
   | Secret | `ADMIN_PASS` | mật khẩu admin |
   | Text   | `ADMIN_USER` | `margin` |
   → **Deploy** lại.
7. Copy địa chỉ Worker (dạng `https://ocbs-admin.<tên-bạn>.workers.dev`).
   Mở nó trên trình duyệt phải thấy `{"ok":true,"service":"ocbs-admin","kv":true}`.
8. Vào web → **🔒 Admin** đăng nhập → tab **⚙️ Giá chặn & Room** →
   **🔗 Kết nối server** → dán địa chỉ vừa copy.

Bước 8 chỉ áp cho máy đang dùng. Để **mọi máy** dùng chung, dán địa chỉ đó vào
biến `API_BASE` ở đầu `docs/app.js` rồi commit (hoặc gửi địa chỉ cho người
quản trị repo làm giúp).

## Kiểm tra hoạt động

- Sửa tỷ lệ 1 mã → góc phải hiện `⏳ Đang lưu…` rồi `✅ Đã lưu … lên server`.
- Mở web trên máy/điện thoại khác (không đăng nhập) → thấy đúng số vừa sửa.

## Ghi chú

- Dữ liệu nằm trong Cloudflare KV, **không** nằm trong git. Muốn có bản lưu
  trong repo thì bấm **⬇️ Xuất file JSON** rồi commit vào `docs/`.
- Các file `docs/*.json` trong repo vẫn là **bản mặc định**: khi Worker chưa
  cấu hình hoặc không phản hồi, web tự động dùng chúng nên không bao giờ trắng dữ liệu.
- Free tier Cloudflare: 100.000 lượt đọc + 1.000 lượt ghi mỗi ngày — thừa sức.
- Mật khẩu admin thật nằm ở `ADMIN_PASS` trên Worker; đổi mật khẩu thì sửa
  secret này và sửa `ADMIN_HASH` trong `docs/app.js` (hash SHA-256 của
  `user:password`).
