# Phương án dự phòng: trigger cập nhật giá qua cron-job.org

> **Tại sao cần cái này?** Cron nội bộ của GitHub Actions (`schedule:` trong
> `.github/workflows/update-prices.yml`) **không đáng tin** — đã gặp trường hợp
> bị delay ~13 tiếng, chạy lúc 4h sáng thay vì 16h chiều. Phương án này dùng
> dịch vụ ngoài (cron-job.org) gọi thẳng GitHub API để **trigger workflow đúng
> giờ**, không phụ thuộc cron của GitHub.
>
> Workflow vẫn giữ guard (chỉ ghi giá khi chạy 14h–23h VN) và 3 mốc cron GitHub
> làm lớp dự phòng thứ hai. Đây là 3 lớp: cron GitHub → cron-job.org → chạy tay.

---

## Bước 1 — Tạo Fine-grained Personal Access Token (PAT)

1. Vào https://github.com/settings/personal-access-tokens/new (đăng nhập tài khoản `nctffi-cell`).
2. Điền:
   - **Token name:** `cron-job-trigger-prices`
   - **Expiration:** 1 năm (đặt lịch nhắc gia hạn — token hết hạn thì dự phòng ngừng chạy).
   - **Resource owner:** `nctffi-cell`
   - **Repository access:** chọn **Only select repositories** → `nctffi-cell/ocbs-rtt-margin`.
3. Mục **Permissions** → **Repository permissions** → tìm **Actions** → đặt thành **Read and write**.
   (Chỉ cần đúng quyền này. KHÔNG cấp thêm quyền khác.)
4. Bấm **Generate token** → **copy token ngay** (chỉ hiện 1 lần). Token dạng `github_pat_...`.

> ⚠️ **BẢO MẬT:** token này = quyền chạy workflow trên repo. KHÔNG commit vào repo,
> KHÔNG dán vào chat. Chỉ dán vào ô mật khẩu/header của cron-job.org.

---

## Bước 2 — Tạo cron job trên cron-job.org

1. Đăng ký/đăng nhập https://cron-job.org → **Create cronjob**.
2. **Title:** `OCBS cap nhat gia`
3. **URL:**
   ```
   https://api.github.com/repos/nctffi-cell/ocbs-rtt-margin/actions/workflows/update-prices.yml/dispatches
   ```
4. **Schedule** (giờ cron-job.org — chọn timezone **Asia/Ho_Chi_Minh** trong cài đặt account trước):
   - Đặt **15:30** các ngày **T2–T6** (sau giờ đóng cửa, nằm trong khung guard 14h–23h).
   - (Tùy chọn) thêm job thứ hai lúc **16:30** để chắc chắn — chạy lặp an toàn, giá không đổi sẽ không tạo commit thừa.
5. Mở mục **Advanced** (hoặc "Headers" / "Request method"):
   - **Request method:** `POST`
   - **Headers** — thêm 3 dòng:
     | Key | Value |
     |-----|-------|
     | `Accept` | `application/vnd.github+json` |
     | `Authorization` | `Bearer <DÁN_TOKEN_Ở_ĐÂY>` |
     | `X-GitHub-Api-Version` | `2022-11-28` |
   - **Request body** (bắt buộc với GitHub dispatch API):
     ```json
     {"ref":"main"}
     ```
6. Lưu (**Create**).

---

## Bước 3 — Kiểm tra ngay

- Trong cron-job.org, bấm **Run now** / **Test run** trên job vừa tạo.
- Kết quả mong đợi: HTTP **204 No Content** (GitHub dispatch thành công, không trả body).
  - Nếu **401** → token sai/hết hạn.
  - Nếu **403** → token thiếu quyền Actions: Read and write.
  - Nếu **404** → sai URL (kiểm tra owner/repo/tên file workflow) hoặc token không có quyền trên repo.
  - Nếu **422** → thiếu/sai body `{"ref":"main"}`.
- Sau ~3 phút, vào https://github.com/nctffi-cell/ocbs-rtt-margin/actions xem có run mới (event = `workflow_dispatch`) không.

---

## Kiểm chứng bằng dòng lệnh (tùy chọn, để tự test trước khi cắm vào cron-job.org)

PowerShell:
```powershell
$token = "github_pat_..."   # token vừa tạo
curl -s -o /dev/null -w "%{http_code}" -X POST `
  -H "Accept: application/vnd.github+json" `
  -H "Authorization: Bearer $token" `
  -H "X-GitHub-Api-Version: 2022-11-28" `
  https://api.github.com/repos/nctffi-cell/ocbs-rtt-margin/actions/workflows/update-prices.yml/dispatches `
  -d '{\"ref\":\"main\"}'
```
Trả về `204` = OK.

---

## Ghi nhớ vận hành

- **Token hết hạn** là nguyên nhân phổ biến khiến dự phòng "im lặng ngừng chạy". Đặt nhắc gia hạn trước ngày hết hạn.
- Guard trong `scripts/update_prices_ci.py` chỉ cho ghi giá trong khung **14h–23h giờ VN**. Nếu đổi giờ chạy cron-job.org ra ngoài khung này, nhớ nới guard tương ứng.
- 3 lớp dự phòng hiện có: (1) cron GitHub nội bộ, (2) cron-job.org gọi API, (3) chạy tay `gh workflow run update-prices.yml`. Chỉ cần 1 lớp chạy là giá được cập nhật; chạy trùng vô hại nhờ concurrency group + git diff guard.
