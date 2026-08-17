/**
 * OCBS Margin Calculator — API admin (Cloudflare Worker + KV)
 * ------------------------------------------------------------
 * Web dautugiatri.vn là trang tĩnh nên không tự lưu được. Worker này đóng vai
 * "server": giữ dữ liệu admin (tỷ lệ, room, giá chặn, hạn mức) trong KV.
 *   • Người dùng thường  : GET  /data   → đọc dữ liệu mới nhất (không cần đăng nhập)
 *   • Admin lưu thay đổi : POST /save   → kiểm tra tài khoản rồi ghi vào KV
 * Sửa xong bên web là mọi người thấy NGAY, không phải chờ build lại web.
 *
 * CẦN CÀI (xem hướng dẫn trong README):
 *   - KV Namespace bind tên  DB
 *   - Biến môi trường  ADMIN_USER  (vd: margin)
 *   - Secret           ADMIN_PASS  (mật khẩu admin)
 */

const KEYS = ['overrides', 'caps', 'settings', 'master'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400',
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store', ...CORS },
});

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const path = (new URL(req.url).pathname.replace(/\/+$/, '')) || '/';

    // Kiểm tra worker sống chưa
    if (path === '/' || path === '/health') {
      return json({ ok: true, service: 'ocbs-admin', kv: !!env.DB });
    }

    // ── Đọc dữ liệu (ai cũng gọi được) ───────────────────────
    if (path === '/data' && req.method === 'GET') {
      if (!env.DB) return json({ ok: false, error: 'chưa gắn KV namespace tên DB' }, 500);
      const out = {};
      for (const k of KEYS) {
        const v = await env.DB.get(k);
        out[k] = v ? JSON.parse(v) : null;      // null = chưa có → web dùng bản mặc định trong repo
      }
      out._updated = await env.DB.get('_updated');
      return json(out);
    }

    // ── Admin lưu thay đổi ───────────────────────────────────
    if (path === '/save' && req.method === 'POST') {
      if (!env.DB) return json({ ok: false, error: 'chưa gắn KV namespace tên DB' }, 500);
      if (!env.ADMIN_PASS) return json({ ok: false, error: 'chưa đặt secret ADMIN_PASS' }, 500);

      let body;
      try { body = await req.json(); } catch (_) { return json({ ok: false, error: 'dữ liệu gửi lên không hợp lệ' }, 400); }

      const { user, pass, key, data } = body || {};
      if (user !== (env.ADMIN_USER || 'margin') || pass !== env.ADMIN_PASS) {
        return json({ ok: false, error: 'sai tài khoản hoặc mật khẩu admin' }, 401);
      }
      if (!KEYS.includes(key))       return json({ ok: false, error: 'loại dữ liệu không hợp lệ' }, 400);
      if (data === undefined || data === null) return json({ ok: false, error: 'thiếu dữ liệu' }, 400);

      await env.DB.put(key, JSON.stringify(data));
      await env.DB.put('_updated', new Date().toISOString());
      return json({ ok: true, key, count: typeof data === 'object' ? Object.keys(data).length : 1 });
    }

    return json({ ok: false, error: 'không có đường dẫn này' }, 404);
  },
};
