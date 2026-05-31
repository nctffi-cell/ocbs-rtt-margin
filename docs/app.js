// ╔════════════════════════════════════════════════════════════╗
// ║  OCBS Margin Calculator – Frontend logic                  ║
// ╚════════════════════════════════════════════════════════════╝

const STATE = {
  master: {},        // {SYM: {name, exch, r, ts}}
  caps:   {},        // {SYM: {high, low}}
  prices: {},        // {SYM: {price, change, changePct}}
  holdings: [],      // 10 rows: {sym, qty, price, capUsed, r}
};

const fmtVND = n => (n==null || isNaN(n)) ? '—' : Math.round(n).toLocaleString('vi-VN');
const getFb       = () => (+$('pFb').value       || 0.15) / 100;
const getFs       = () => getFb() + 0.001;
const getLoanRate = () => (+($('pLoanRate')?.value) || 13) / 100;   // lãi vay %/năm → tỷ lệ
const getAdvRate  = () => (+($('pAdvRate')?.value)  || 13) / 100;   // lãi ứng trước %/năm → tỷ lệ
const getMaxLoan  = () => +($('pMaxLoan')?.value)   || 81e9;
const fmtPct = n => (n==null || isNaN(n)) ? '—' : (n*100).toFixed(2) + '%';
const fmtNum = n => (n==null || isNaN(n)) ? '—' : Math.round(n).toLocaleString('vi-VN');
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ── Numeric input with thousand separators ─────────────────
const parseNum = v => {
  if (v == null) return 0;
  const s = String(v).replace(/[^\d-]/g, '');
  return s ? +s : 0;
};
const fmtNumInput = n => {
  if (n == null || isNaN(n)) return '';
  return Math.round(n).toLocaleString('vi-VN');
};
const setNumVal = (el, n) => { if (el) el.value = fmtNumInput(n); };
const getNumVal = id => parseNum($(id)?.value);

// Live format [data-num] inputs while preserving caret position
document.addEventListener('input', e => {
  const t = e.target;
  if (!t.matches || !t.matches('input[data-num]')) return;
  const before = t.value;
  const caret = t.selectionStart || 0;
  const digitsBefore = (before.slice(0, caret).match(/\d/g) || []).length;
  const num = parseNum(before);
  const formatted = num === 0 && before.trim() === '' ? '' : num.toLocaleString('vi-VN');
  if (formatted !== before) {
    t.value = formatted;
    let pos = 0, seen = 0;
    while (pos < formatted.length && seen < digitsBefore) {
      if (/\d/.test(formatted[pos])) seen++;
      pos++;
    }
    try { t.setSelectionRange(pos, pos); } catch(_) {}
  }
}, true);

// Format initial values for any [data-num] inputs currently in DOM
function formatNumInputs(root = document) {
  root.querySelectorAll('input[data-num]').forEach(el => {
    const raw = el.value.trim();
    if (!raw) return;
    const n = parseNum(raw);
    el.value = isNaN(n) ? raw : n.toLocaleString('vi-VN');
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => formatNumInputs());
} else {
  formatNumInputs();
}

// ── Tabs ───────────────────────────────────────────────────
$$('.tab').forEach(t => t.onclick = () => {
  $$('.tab').forEach(x => x.classList.remove('active'));
  $$('.panel').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.querySelector(`.panel[data-panel="${t.dataset.tab}"]`).classList.add('active');
  if (t.dataset.tab === 'caps') renderCaps();
  if (t.dataset.tab === 'muonhang') recalcMuon();
  if (t.dataset.tab === 'viphm') renderSellTable();
});

// ── Load master + caps ─────────────────────────────────────
async function loadMaster() {
  let d = null;
  for (const url of ['/api/stocks', 'stocks.json']) {
    try { const r = await fetch(url); if (r.ok) { d = await r.json(); break; } } catch(_) {}
  }
  if (!d) { $('hdrInfo').textContent = '⚠️ Không tải được master list'; return; }
  STATE.master = d.stocks || {};
  if ($('listDate')) $('listDate').textContent = `Danh mục áp dụng: ${d.updated || '—'}  (${d.count||0} mã)`;
  if ($('listCount')) $('listCount').textContent = d.count || Object.keys(STATE.master).length;
  $('hdrInfo').textContent = `${d.count || 0} mã CK · cập nhật ${d.updated || '—'}`;
}
async function loadCaps() {
  for (const url of ['/api/caps', 'caps.json']) {
    try { const r = await fetch(url); if (r.ok) { STATE.caps = await r.json(); return; } } catch(_) {}
  }
  STATE.caps = {};
}
async function saveCaps() {
  await fetch('/api/caps', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(STATE.caps)});
  $('capInfo').textContent = `✓ Đã lưu ${Object.keys(STATE.caps).length} mã`;
  setTimeout(()=>$('capInfo').textContent='', 3000);
}

// ── Giá tham chiếu hôm nay (đọc từ prices.json, cập nhật 1 lần/ngày) ─
async function loadPrices() {
  try {
    // Thử backend (server.py) trước, fallback file tĩnh trong cùng folder
    let d = null;
    try { const r = await fetch('/prices.json'); if (r.ok) d = await r.json(); } catch(_) {}
    if (!d) { const r = await fetch('prices.json'); if (r.ok) d = await r.json(); }
    if (!d) throw new Error('prices.json không tải được');
    for (const [sym, price] of Object.entries(d.prices || {})) {
      STATE.prices[sym] = { price, ref: price };
    }
    if ($('hdrInfo')) {
      const cur = $('hdrInfo').textContent;
      $('hdrInfo').textContent = `${cur} · Giá TC ${d.tradingDate || d.updated || '?'}`;
    }
  } catch(e) { console.warn('loadPrices', e); }
}

async function fetchPrice(sym) {
  if (!sym) return null;
  sym = sym.toUpperCase().trim();
  return STATE.prices[sym] || null;
}

// Tỷ lệ cho vay margin. Mã NGOÀI danh mục ký quỹ (không có trong master) → r = 0
// (không được vay, phải mua 100% bằng tiền/vốn tự có).
function getR(sym) {
  const m = STATE.master[(sym||'').toUpperCase()];
  return m ? m.r : 0;
}
// Tỷ lệ tài sản (ts) = TL tài sản SM của Excel — dùng để CHIẾT KHẤU giá trị CK khi
// định giá tài sản tính Rtt (PV). Khác với r (tỷ lệ cho vay).
// Mã NGOÀI danh mục ký quỹ → ts = 0 (không được tính làm tài sản đảm bảo).
function getTs(sym) {
  const m = STATE.master[(sym||'').toUpperCase()];
  if (!m) return 0;
  const t = (m.ts != null) ? m.ts : m.evalRatio;
  return (t != null) ? t : 0;
}
function getCapHigh(sym) {
  const s = (sym||'').toUpperCase();
  // Ưu tiên user override (caps.json/localStorage), fallback giá chặn từ PL1 (master.cap)
  const u = STATE.caps[s];
  if (u && u.high) return u.high;
  const m = STATE.master[s];
  return (m && m.cap) ? m.cap : null;
}
function getStockLimit(sym) {
  const m = STATE.master[(sym||'').toUpperCase()];
  return (m && m.limit) ? m.limit : null;
}
// Hiện/ẩn dòng cảnh báo chạm Hạn mức tối đa 1 mã (limit).
// rowId/warnId: id dòng + ô text. capped: true nếu dư nợ đã bị kẹp. lim: trần. raw: dư nợ trước kẹp.
function showLimitWarn(rowId, warnId, capped, lim, raw) {
  const row = $(rowId), warn = $(warnId);
  if (!row || !warn) return;
  if (capped) {
    row.style.display = '';
    warn.textContent = `Trần ${fmtVND(lim)} (lý thuyết ${fmtVND(raw)})`;
  } else {
    row.style.display = 'none';
    warn.textContent = '';
  }
}
// Giá đánh giá = MIN(giá TT, giá chặn trên). Nếu chặn null → dùng giá TT
function evalPrice(sym, marketPrice) {
  const cap = getCapHigh(sym);
  return cap ? Math.min(marketPrice, cap) : marketPrice;
}

// ╔════════════════ TAB 1: Rtt & Danh mục ════════════════════╗
function initHoldingsTable() {
  const tb = $('tblHoldings').querySelector('tbody');
  tb.innerHTML = '';
  for (let i = 0; i < 10; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i+1}</td>
      <td><input type="text" data-i="${i}" data-f="sym" placeholder=""></td>
      <td><input type="text" inputmode="numeric" data-num data-i="${i}" data-f="qty" value="0"></td>
      <td><input type="text" inputmode="numeric" data-num data-i="${i}" data-f="price" value="0"></td>
      <td class="calc" data-i="${i}" data-f="evalPrice">0</td>
      <td><input type="number" data-i="${i}" data-f="r" value="0.5" min="0" max="1" step="0.05"
          style="width:70px;text-align:right;background:#FFF9C4;color:#0d47a1;font-weight:600;
                 padding:4px 6px;border:1px solid #dbe3ec;border-radius:3px"
          title="T.lệ CTCK cho vay – tự gợi ý từ master list, có thể sửa"></td>
      <td class="calc" data-i="${i}" data-f="mv">0</td>
      <td class="calc" data-i="${i}" data-f="dmax">0</td>
      <td class="calc" data-i="${i}" data-f="mr">0</td>
    `;
    tb.appendChild(tr);
  }
  STATE.holdings = Array.from({length:10}, () => ({sym:'', qty:0, price:0, r:0.5}));
  tb.addEventListener('input', onHoldingChange);
  tb.addEventListener('change', onHoldingBlur);
}
function onHoldingChange(e) {
  const t = e.target; if (!t.dataset) return;
  const i = +t.dataset.i, f = t.dataset.f;
  if (f === 'sym') {
    const sym = t.value.toUpperCase().trim();
    STATE.holdings[i].sym = sym;
    const rEl = document.querySelector(`input[data-i="${i}"][data-f="r"]`);
    if (rEl) { delete rEl.dataset.manualEdit; rEl.style.background = '#FFF9C4'; }
    // Auto-fill T.lệ Margin từ master list ngay khi mã khớp
    const masterR = STATE.master[sym]?.r;
    if (masterR != null && rEl) {
      rEl.value = masterR;
      STATE.holdings[i].r = masterR;
    }
    // Auto-fill giá tham chiếu nếu đã có sẵn trong cache (prices.json)
    const cachedPx = STATE.prices[sym]?.price;
    if (cachedPx) {
      const priceEl = document.querySelector(`input[data-i="${i}"][data-f="price"]`);
      setNumVal(priceEl, cachedPx);
      STATE.holdings[i].price = cachedPx;
    }
  } else if (f === 'r') {
    STATE.holdings[i].r = +t.value || 0;
    // Đánh dấu đã sửa tay → đổi màu cam nhạt
    t.dataset.manualEdit = '1';
    t.style.background = '#FFE0B2';
  } else if (f === 'qty' || f === 'price') {
    STATE.holdings[i][f] = parseNum(t.value);
  } else {
    STATE.holdings[i][f] = +t.value || 0;
  }
  recalcAll();
}
async function onHoldingBlur(e) {
  const t = e.target; if (!t.dataset) return;
  if (t.dataset.f !== 'sym') return;
  const sym = t.value.toUpperCase().trim();
  if (!sym) return;
  const i = +t.dataset.i;
  // Fill giá tham chiếu (luôn ghi đè khi user vừa gõ mã, kể cả khi prices đã prefetch)
  const p = await fetchPrice(sym);
  if (p) {
    const inputPrice = document.querySelector(`input[data-i="${i}"][data-f="price"]`);
    setNumVal(inputPrice, p.price);
    STATE.holdings[i].price = p.price;
  }
  // Gợi ý T.lệ margin từ master list. Mã NGOÀI danh mục ký quỹ → gợi ý 0% (không vay).
  const masterR = STATE.master[sym]?.r;
  const rEl = document.querySelector(`input[data-i="${i}"][data-f="r"]`);
  if (rEl && !rEl.dataset.manualEdit) {
    const suggested = (masterR != null) ? masterR : 0;   // mã lạ → 0
    rEl.value = suggested;
    STATE.holdings[i].r = suggested;
  }
  recalcAll();
}

function recalcHoldings() {
  let totMV = 0, totPV = 0, totDmax = 0, totMR = 0, totMRpv = 0;
  for (let i = 0; i < 10; i++) {
    const h = STATE.holdings[i];
    const r = h.r ?? getR(h.sym);
    const ts = getTs(h.sym);                       // tỷ lệ tài sản (chiết khấu định giá)
    const pEval = evalPrice(h.sym, h.price);
    const mv = h.qty * pEval;                       // giá trị thị trường (100%)
    const pv = mv * ts;                             // giá trị tài sản đã chiết khấu (PV — Excel)
    const lim = getStockLimit(h.sym);
    const dmaxRaw = mv * r;
    const dmax = (lim != null) ? Math.min(dmaxRaw, lim) : dmaxRaw;
    const mr = mv - dmax;
    // MR theo cơ sở chiết khấu (khớp Excel V42): ký quỹ yêu cầu = pv × (1 − r) per-stock.
    totMRpv += pv * (1 - r);
    totMV += mv; totPV += pv; totDmax += dmax; totMR += mr;
    // Update cells
    document.querySelector(`[data-i="${i}"][data-f="evalPrice"]`).textContent = fmtVND(pEval);
    document.querySelector(`[data-i="${i}"][data-f="mv"]`).textContent = fmtVND(mv);
    document.querySelector(`[data-i="${i}"][data-f="dmax"]`).textContent = fmtVND(dmax);
    document.querySelector(`[data-i="${i}"][data-f="mr"]`).textContent = fmtVND(mr);
  }
  $('totMV').textContent = fmtVND(totMV);
  $('totDmax').textContent = fmtVND(totDmax);
  $('totMR').textContent = fmtVND(totMR);
  return { totMV, totPV, totDmax, totMR, totMRpv };
}

function recalcAll() {
  // Cập nhật display phí + thuế bán
  if ($('pFsDisplay')) $('pFsDisplay').textContent = (getFs() * 100).toFixed(3) + '%';

  const { totMV, totPV, totDmax, totMRpv } = recalcHoldings();
  const cash = getNumVal('aCash');
  const debt = getNumVal('aDebt');
  const intt = getNumVal('aInt');
  const D = debt + intt;
  $('aTotalDebt').textContent = fmtVND(D);

  // ── MÔ HÌNH CMRp (khớp Excel "File tính sức mua - OCBS 1", ô D24) ──────────
  //   PV  = Σ KL × giá đánh giá × ts   (giá trị tài sản đã CHIẾT KHẤU theo tỷ lệ tài sản)
  //   Vasset (Excel EB) = PV + tiền    → đây là "Tổng tài sản V" hiển thị & cơ sở tính Rtt
  //   AB (Excel)        = PV + tiền − D  (vốn chủ trên cơ sở chiết khấu)
  //   CMRp (Rtt)        = (PV + tiền − D) / (PV + max(tiền − D, 0))
  // Tiền KHÔNG bị chiết khấu; khi tiền < nợ, phần tiền bị trừ khỏi mẫu số → khớp ô D24.
  const PV     = totPV;                       // tổng giá trị tài sản tạm tính (Excel D9)
  const Vasset = PV + cash;                   // tổng tài sản trên cơ sở chiết khấu (Excel EB)
  const AB     = PV + cash - D;               // vốn chủ chiết khấu (Excel AB / EE gốc)
  const cmrpDen = PV + Math.max(cash - D, 0); // mẫu số CMRp đặc biệt
  const rtt    = cmrpDen > 0 ? (PV + cash - D) / cmrpDen : 0;

  // V (giá trị THỊ TRƯỜNG) — giữ cho các phép bán/nộp tiền (tài sản bán theo giá TT).
  const Vmkt = totMV + cash;
  const V = Vasset;                           // "Tổng tài sản V" hiển thị theo cơ sở chiết khấu
  const E = AB;                               // "Vốn chủ E" = AB
  STATE.account = { V, Vmkt, PV, D, E, AB, rtt, cash, totMV, totPV, totDmax, totMRpv };
  const room = totDmax - D;

  // Tab 1 outputs
  $('rVcp').textContent = fmtVND(PV);         // Giá trị danh mục CP = PV (đã chiết khấu)
  $('rM').textContent = fmtVND(cash);
  $('rV').textContent = fmtVND(V);
  $('rD').textContent = fmtVND(D);
  $('rE').textContent = fmtVND(E);
  $('rRtt').textContent = fmtPct(rtt);
  // Dư ký quỹ (EE) = AB − MR, với MR = PV×MMR (mức ký quỹ tối thiểu 50% trên tài sản).
  //   EE = AB − PV×0.5. Hết EE tức Rtt chạm 50%. (Excel D15)
  if ($('rEE')) $('rEE').textContent = fmtVND(Math.max(0, AB - 0.5 * PV));

  const loanRoom = getMaxLoan() - D;
  if ($('rLoanRoom')) {
    const el = $('rLoanRoom');
    el.textContent = fmtVND(loanRoom);
    el.style.color = loanRoom < 0 ? '#c0392b' : '';
    el.style.fontWeight = loanRoom < 0 ? '700' : '';
  }

  const cm = +$('pCall').value || 0.35;
  const fs = +$('pForce').value || 0.25;
  const stEl = $('rStatus');
  let needAlert = false, alertClass = '';
  if (V === 0) { stEl.textContent = '— (nhập danh mục để bắt đầu)'; stEl.className = 'status'; }
  else if (rtt >= 0.5)     { stEl.textContent = '✅ AN TOÀN (Rtt ≥ 50%)';                                stEl.className = 'status safe'; }
  else if (rtt >= cm)      { stEl.textContent = `⚠️ CẢNH BÁO (${(cm*100)|0}% ≤ Rtt < 50%)`;             stEl.className = 'status watch'; }
  else if (rtt >= fs)      { stEl.textContent = `🔴 CALL MARGIN (${(fs*100)|0}% ≤ Rtt < ${(cm*100)|0}%)`; stEl.className = 'status call'; needAlert = true; alertClass = 'call'; }
  else                     { stEl.textContent = `🚨 FORCE SELL (Rtt < ${(fs*100)|0}%)`;                  stEl.className = 'status force'; needAlert = true; alertClass = 'force'; }

  // Nộp tiền / bán CP để đạt Rtt mục tiêu (theo CMRp + chiết khấu ts).
  //   Nộp C: Rtt mới = (PV+cash+C−D)/(PV+max(cash+C−D,0)). Còn vay (cash+C<D) → mẫu=PV.
  //          C = D − PV×(1−t) − cash.
  //   Bán S (giá thị trường): PV↓ S×tsAvg, nợ↓ S×(1−fsSell), phí mất S×fsSell.
  //          Rtt = (PV−S·ts + 0 − (D−S(1−φ))) / (PV−S·ts)  → S = (D−PV(1−t))/(1−φ−ts+t·ts).
  const tsAvg  = totMV > 0 ? PV / totMV : 1;     // tỷ lệ tài sản bình quân danh mục CP
  const fsSell = getFs();                        // phí + thuế khi bán
  const depFor = t => Math.max(0, D - PV * (1 - t) - cash);
  const sellFor = t => {
    const den = 1 - fsSell - tsAvg + t * tsAvg;
    return den > 1e-9 ? Math.max(0, (D - PV * (1 - t)) / den) : 0;
  };

  // Alert panel
  const panel = $('alertPanel');
  if (needAlert && V > 0 && D > 0) {
    const c50 = depFor(0.5);
    const c35 = depFor(cm);                      // về ngưỡng Call hiện hành (mặc định 35%)
    const s50 = sellFor(0.5);
    const s35 = sellFor(cm);
    $('alertTitle').textContent = alertClass === 'force'
      ? `🚨 FORCE SELL – Rtt hiện tại ${fmtPct(rtt)} – Cần xử lý NGAY`
      : `🔴 CALL MARGIN – Rtt hiện tại ${fmtPct(rtt)} – Cần bổ sung tài sản`;
    $('alertBox').className = `alert-box ${alertClass}`;
    $('aC50').textContent = fmtVND(c50) + ' đ';
    $('aC35').textContent = fmtVND(c35) + ' đ';
    $('aS50').textContent = fmtVND(s50) + ' đ';
    $('aS35').textContent = fmtVND(s35) + ' đ';
    panel.style.display = 'block';
  } else {
    panel.style.display = 'none';
  }

  // Tab 2 propagate — nộp tiền & bán CP theo CMRp (dùng depFor/sellFor ở trên).
  $('vV').textContent = fmtVND(V); $('vD').textContent = fmtVND(D);
  $('vE').textContent = fmtVND(E); $('vRtt').textContent = fmtPct(rtt);
  // Rtt sau nộp C (CMRp): cash'=cash+C; còn vay → mẫu=PV.
  const rttAfterDep  = C => { const den = PV + Math.max(cash + C - D, 0); return den>0 ? (PV+cash+C-D)/den : 0; };
  // Rtt sau bán S (CMRp): PV↓S·tsAvg, nợ↓S·(1−fsSell), tiền dư nếu trả hết nợ.
  const rttAfterSell = S => {
    const PVa = Math.max(0, PV - S*tsAvg), recv = S*(1-fsSell);
    const Da = Math.max(0, D - recv), ca = Math.max(0, cash + recv - (D - Da));
    const den = PVa + Math.max(ca - Da, 0); return den>0 ? (PVa+ca-Da)/den : 0;
  };
  const d50 = depFor(0.5), d35 = depFor(0.35);
  $('d50').textContent = fmtVND(d50);
  $('d35').textContent = fmtVND(d35);
  $('d50r').textContent = fmtPct(d50>0 ? rttAfterDep(d50) : rtt);
  $('d35r').textContent = fmtPct(d35>0 ? rttAfterDep(d35) : rtt);
  const s35 = sellFor(0.35), s50 = sellFor(0.5);
  $('s35').textContent = fmtVND(s35);
  $('s50').textContent = fmtVND(s50);
  $('s35r').textContent = fmtPct(s35>0 ? rttAfterSell(s35) : rtt);
  $('s50r').textContent = fmtPct(s50>0 ? rttAfterSell(s50) : rtt);

  // Tab 3 propagate
  $('bV').textContent = fmtVND(V); $('bD').textContent = fmtVND(D);
  $('bRtt').textContent = fmtPct(rtt); $('bDmax').textContent = fmtVND(E);
  // EE (đệm Rtt 50%) = vốn chủ còn lại trên mức ký quỹ tối thiểu = AB − 50%×PV (≥0).
  if ($('bEE')) $('bEE').textContent = fmtVND(Math.max(0, AB - 0.5 * PV));
  $('bRoom').textContent = fmtVND(getMaxLoan() - D); $('bM').textContent = fmtVND(cash);

  recalcBuy(V, D, room, cash);
  recalcDeals();
  renderSellTable();
}

// ── Tab 3 buy section ──────────────────────────────────────
async function onBuySymBlur() {
  const sym = $('bSym').value.toUpperCase().trim();
  if (sym) {
    const p = await fetchPrice(sym);
    if (p) { setNumVal($('bPrice'), p.price); $('bPriceNote').textContent = `Giá tham chiếu: ${fmtVND(p.price)}`; }
  }
  recalcAll();
}
function recalcBuy(V, D, room, cash) {
  const sym   = $('bSym').value.toUpperCase().trim();
  const price = getNumVal('bPrice');
  const r     = getR(sym);
  const fb    = getFb();

  $('bR').textContent = (r*100).toFixed(0) + '%';

  // ── CÔNG THỨC SỨC MUA OCBS (File tính sức mua - OCBS 1) ───────────────────
  //   Mua bằng tài sản đảm bảo: chi tiền = GT lệnh + phí (GT×fb); nợ tăng = chi − tiền mặt.
  //   Phí giao dịch trả bằng tiền/vốn, KHÔNG thành tài sản → giảm vốn chủ.
  //   Sức mua = GT lệnh tối đa giữ Rtt (CMRp) ≥ mức ký quỹ duy trì MMR (50%).
  //   Giải Rtt = MMR với PV' = PV + GT×ts, D' = D + GT(1+fb) − cash:
  //     GT_max = (D − cash − PV×(1−MMR)) / (ts×(1−MMR) − (1+fb))
  //   (mẫu số luôn âm → GT dương). Mua hết GT_max thì Rtt chạm đúng 50% (đã tính phí).
  //   Tách hiển thị: phần từ dư ký quỹ (cash=0) và phần tăng thêm nhờ tiền mặt.
  const lim       = getStockLimit(sym);                 // HM 1 mã (null nếu không có)
  const acctRoom  = Math.max(0, getMaxLoan() - D);      // hạn mức nợ còn lại toàn TK
  const acc       = STATE.account || {};
  const PV        = (acc.PV != null) ? acc.PV : (V - cash);  // tài sản chiết khấu (Excel D9)
  const MR        = (acc.totMRpv != null) ? acc.totMRpv : PV * 0.5;  // ký quỹ YC danh mục (Excel V42)
  const AB        = V - D;                              // vốn chủ chiết khấu = Vasset − D
  const CCR       = r;                                  // tỷ lệ cho vay = tỷ lệ margin của mã mua
  const MMR       = 0.5;                                // ký quỹ duy trì
  const tsBuyR    = getTs(sym);                         // tỷ lệ tài sản của mã mua (chiết khấu PV)
  const EE        = AB - MR;                            // dư ký quỹ (Excel D15 = AB − MR)

  // Mã NGOÀI danh mục ký quỹ (r=0): KHÔNG vay được → mua 100% bằng tiền mặt.
  //   Sức mua từ vốn chủ/ký quỹ = 0; chỉ mua được = cash/(1+phí). Nợ không tăng.
  let bpEquity, bpBeforeLimit, bpCashAdd, bpByLoan, bpStock, bpAcct, loanCap;
  if (r <= 0) {
    bpEquity = 0;                                       // không đòn bẩy
    bpBeforeLimit = cash / (1 + fb);                    // mua hết bằng tiền (trừ phí)
    bpCashAdd = bpBeforeLimit;
    loanCap = 0;
    bpByLoan = Infinity;                                // không phát sinh nợ → không bị HM nợ chặn
    bpStock = Infinity; bpAcct = Infinity;
  } else {
    // GT lệnh tối đa giữ Rtt ≥ MMR, ĐÃ TÍNH phí giao dịch. denom < 0 → GT ≥ 0.
    const denomGT = tsBuyR * (1 - MMR) - (1 + fb);
    const bpFor = c => denomGT < -1e-12 ? Math.max(0, (D - c - PV * (1 - MMR)) / denomGT) : 0;
    bpEquity = bpFor(0);                                // sức mua khi chỉ dùng dư ký quỹ (cash=0)
    bpBeforeLimit = bpFor(cash);                        // sức mua có tính tiền mặt
    bpCashAdd = Math.max(0, bpBeforeLimit - bpEquity);  // phần tăng thêm nhờ tiền mặt
    // Kẹp hạn mức dư nợ: nợ phát sinh = GT − cash ≤ min(HM 1 mã, HM tài khoản 81 tỷ).
    loanCap  = (lim != null) ? Math.min(acctRoom, lim) : acctRoom;
    bpByLoan = loanCap + cash;                          // GT tối đa để nợ ≤ loanCap
    bpStock  = (lim != null) ? lim + cash : Infinity;
    bpAcct   = acctRoom + cash;
  }

  const bpTotal = Math.max(0, Math.min(bpBeforeLimit, bpByLoan));
  const bpLoan  = bpEquity;                             // alias hiển thị "sức mua từ dư ký quỹ"

  const qtyMax = price > 0 ? Math.floor(bpTotal / price / 100) * 100 : 0;
  const gtMax  = qtyMax * price;                        // giá trị lệnh mua tối đa
  const fee    = gtMax * fb;                            // phí giao dịch mua
  // Chi tiền = GT lệnh + phí. Nợ tăng = chi − tiền mặt khách bỏ ra (tiền mặt=0 → vay cả GT+phí).
  const spendMax    = gtMax + fee;
  const cashUsedMax = Math.min(cash, spendMax);
  const loan        = spendMax - cashUsedMax;           // dư nợ phát sinh thực tế (gồm phí nếu phải vay)

  // Yếu tố đang chặn KL = ràng buộc có GT lệnh nhỏ nhất.
  const constraints = [
    { v: bpBeforeLimit, name: 'Dư ký quỹ (EE) + tiền mặt' },
    { v: bpStock,       name: 'HM 1 mã (Phụ lục 1)' },
    { v: bpAcct,        name: 'HM tài khoản (81 tỷ)' },
  ].sort((a, b) => a.v - b.v);
  const boundBy = isFinite(constraints[0].v) ? constraints[0].name : '—';

  // Cảnh báo khi HM 1 mã là ràng buộc chặt hơn HM tài khoản
  showLimitWarn('bLimitRow', 'bLimitWarn', lim != null && lim < acctRoom, lim, acctRoom);
  $('bBpRoom').textContent  = isFinite(bpLoan) ? fmtVND(bpLoan) : '—';
  $('bBpCash').textContent  = isFinite(bpCashAdd) ? fmtVND(bpCashAdd) : '—';
  $('bBpTotal').textContent = fmtVND(bpTotal);
  $('bQtyMax').textContent  = fmtNum(qtyMax);
  $('bFee').textContent     = fmtVND(fee);
  $('bLoan').textContent    = fmtVND(loan);
  // Rtt sau khi mua (theo CMRp): PV tăng giá trị CK mới đã chiết khấu (gtMax×ts);
  // tiền mặt giảm phần đã dùng; nợ tăng loan. Mua hết sức mua → Rtt chạm 50% (mức ký quỹ tối thiểu).
  const PVafter   = PV + gtMax * tsBuyR;
  const cashAfter = cash - cashUsedMax;
  const Dafter    = D + loan;
  const denAfter  = PVafter + Math.max(cashAfter - Dafter, 0);
  $('bRttAfter').textContent = denAfter > 0
    ? fmtPct((PVafter + cashAfter - Dafter) / denAfter)
    : '—';
  if ($('bBoundBy')) $('bBoundBy').textContent = qtyMax > 0 ? boundBy : '—';

  // Ghi chú ngưỡng Rtt: mua bằng tài sản đảm bảo (vay phần thiếu) → Rtt giảm dần về
  // mức ký quỹ duy trì 50% (MMR). Mã r=0 không vay được → mua bằng tiền, Rtt không tụt.
  if ($('bRttFloorNote')) {
    $('bRttFloorNote').textContent = r > 0
      ? `mua hết sức mua → Rtt về mức ký quỹ tối thiểu 50%`
      : `mã ngoài danh mục ký quỹ (T.lệ 0%) → mua 100% bằng tiền, không vay`;
  }

  // ── Mục II mở rộng: KL người dùng tự chọn ──────────────────
  const qC = getNumVal('bQtyChoose');
  const qChosen = qC > 0 ? qC : qtyMax;          // 0 = dùng KL tối đa
  const valC  = qChosen * price;
  const feeC  = valC * fb;
  // Chi tiền = GT + phí; nợ thực tăng = chi − tiền mặt bỏ ra (tiền mặt=0 → vay cả GT+phí).
  const spendC = valC + feeC;
  const cashUsedC = Math.min(cash, spendC);
  const loanC = spendC - cashUsedC;              // dư nợ phát sinh thực tế (gồm phí nếu phải vay)
  const eqC   = valC * (1 - r) + feeC;           // vốn tự có CẦN (phần không vay + phí)
  const eqAvail = Math.max(0, EE) + cash;        // vốn chủ KHẢ DỤNG (dư ký quỹ + tiền mặt)
  $('bcVal').textContent    = fmtVND(valC);
  $('bcFee').textContent    = fmtVND(feeC);
  $('bcLoan').textContent   = fmtVND(loanC);
  $('bcEquity').textContent = fmtVND(eqC);
  $('bcEquityAvail').textContent = fmtVND(eqAvail);

  // (1) KIỂM TRA SỨC MUA: vốn tự có cần ≤ vốn chủ khả dụng (EE + tiền)?
  //     Đây là lý do thật khiến "mua 14.798 tỷ" là SAI khi chỉ còn 4.525 tỷ vốn chủ.
  const bpEl    = $('bcBpChk');
  const shortBp = eqC - eqAvail;                 // thiếu bao nhiêu vốn chủ
  if (qChosen > 0 && shortBp > 1) {
    bpEl.textContent = `❌ Vượt sức mua — thiếu ${fmtVND(shortBp)} đ vốn chủ/tiền`;
    bpEl.style.color = '#c0392b';
  } else if (qChosen > 0) {
    bpEl.textContent = `✅ Đủ vốn chủ (dư ${fmtVND(eqAvail - eqC)} đ)`;
    bpEl.style.color = '#2e7d32';
  } else {
    bpEl.textContent = '—';
    bpEl.style.color = '';
  }

  // (2) Kiểm tra hạn mức NỢ: HM 1 mã hoặc HM tài khoản 81 tỷ.
  const overStock = lim != null && loanC > lim + 1;
  const overAcct  = (D + loanC) > getMaxLoan() + 1;
  const rcEl = $('bcRoomChk');
  if (overStock && overAcct) {
    rcEl.textContent = `❌ Vượt cả HM 1 mã & HM 81 tỷ`;
  } else if (overStock) {
    rcEl.textContent = `❌ Vượt HM 1 mã ${fmtVND(loanC - lim)} đ`;
  } else if (overAcct) {
    rcEl.textContent = `❌ Vượt HM 81 tỷ ${fmtVND((D + loanC) - getMaxLoan())} đ`;
  } else {
    rcEl.textContent = '✅ Trong hạn mức nợ';
  }
  rcEl.style.color = (overStock || overAcct) ? '#c0392b' : '#2e7d32';

  // Rtt sau khi mua KL tự chọn (theo CMRp): nợ tăng = loanC (GT lệnh − tiền mặt dùng);
  // PV tăng giá trị CK mới đã chiết khấu (valC×ts).
  const PVc   = PV + valC * tsBuyR;
  const cashC = cash - cashUsedC;
  const Dc    = D + loanC;
  const denC  = PVc + Math.max(cashC - Dc, 0);
  $('bcRtt').textContent = (qChosen > 0 && denC > 0)
    ? fmtPct((PVc + cashC - Dc) / denC) : '—';
  if ($('bcRttFloorNote')) {
    $('bcRttFloorNote').textContent = (qChosen > 0 && r > 0)
      ? `mua đúng sức mua → Rtt về 50% (mức ký quỹ tối thiểu)`
      : '';
  }

  // Section III: KL mong muốn
  const qtyWant = +$('bQtyWant').value || 0;
  const valWant = qtyWant * price * (1 + fb);
  const eqWant  = valWant * (1 - r);
  const loanWant= valWant * r;
  const deposit = Math.max(0, eqWant - cash);
  $('bValWant').textContent  = fmtVND(valWant);
  $('bEqWant').textContent   = fmtVND(eqWant);
  $('bLoanWant').textContent = fmtVND(loanWant);
  const wantOverStock = lim != null && loanWant > lim + 1;
  const wantOverAcct  = (D + loanWant) > getMaxLoan() + 1;
  $('bRoomCheck').textContent = (!wantOverStock && !wantOverAcct)
    ? '✅ Trong hạn mức'
    : (wantOverStock ? '❌ Vượt HM 1 mã' : '❌ Vượt HM 81 tỷ');
  $('bDeposit').textContent  = fmtVND(deposit);

  // Section IV: CẢ DANH MỤC giảm bao nhiêu % thì Call/Force?
  //   Cơ sở = danh mục Tab 1 (PV, cash, D). Nếu Tab 3 có mã mua thêm (qChosen>0) → ghép vào:
  //     PV' = PV + valC·ts (tài sản mới chiết khấu); D' = D + loanC (vay nếu hết tiền);
  //     cash' = cash − cashUsedC (tiền tự bỏ ra mua).
  //   Toàn bộ giá CP nhân hệ số x (PV tuyến tính theo giá). Rtt = (x·PV' + cash' − D')/(x·PV' + max(cash'−D',0)).
  //   Giải Rtt = T (cash' < D' mới có nợ ròng): x = (D' − cash') / (PV'·(1 − T)). % giảm = 1 − x.
  const note = $('bThreshNote');
  const hasBuy = qChosen > 0 && price > 0;
  const PVt   = PV   + (hasBuy ? valC * tsBuyR : 0);   // PV danh mục (ghép mã mua thêm nếu có)
  const casht = cash - (hasBuy ? cashUsedC : 0);       // tiền mặt còn lại
  const Dt    = D    + (hasBuy ? loanC : 0);           // dư nợ tổng
  const cmCall = +$('pCall').value || 0.35;            // ngưỡng Call (mặc định 35%)
  const fsForce= +$('pForce').value || 0.25;           // ngưỡng Force (mặc định 25%)
  // x = tỷ lệ giá CP còn lại để Rtt chạm ngưỡng T (≤1 mới có nghĩa: cần giá GIẢM).
  const dropFor = T => {
    if (PVt <= 0) return null;                 // không có CP để giảm
    if (casht >= Dt) return Infinity;          // không vay ròng → không bao giờ Call
    const x = (Dt - casht) / (PVt * (1 - T));
    if (x >= 1) return Infinity;               // đã cần giá tăng mới tới ngưỡng → an toàn
    return 1 - Math.max(0, x);                 // % giảm danh mục CP
  };
  const dCall = dropFor(cmCall), dForce = dropFor(fsForce);
  const SAFE = '✅ Không bao giờ Call';
  const fmtDrop = d => d == null ? '—' : (d === Infinity ? SAFE : fmtPct(d));
  $('bPCall').textContent  = fmtDrop(dCall);
  $('bPForce').textContent = fmtDrop(dForce);
  // 2 dòng "% giảm" cũ dùng để hiển thị Rtt hiện tại của danh mục (đã ghép) cho dễ đối chiếu.
  const denNow = PVt + Math.max(casht - Dt, 0);
  const rttNow = denNow > 0 ? (PVt + casht - Dt) / denNow : null;
  $('bDCall').textContent  = rttNow != null ? fmtPct(rttNow) : '—';
  $('bDForce').textContent = hasBuy ? 'có ghép mã mua thêm' : 'danh mục hiện tại';
  if (note) {
    note.style.display = '';
    note.innerHTML = hasBuy
      ? `Đã ghép <b>${sym || 'mã mua thêm'}</b> (KL ${fmtNum(qChosen)}) vào danh mục. Toàn bộ cổ phiếu giảm tới mức trên thì Rtt chạm Call/Force. Tiền vay thêm ${fmtVND(loanC)} đã tính vào nợ.`
      : `Xét <b>danh mục hiện tại</b> (Tab 1). Toàn bộ cổ phiếu cùng giảm bao nhiêu % thì Rtt chạm Call/Force. Nhập mã ở mục II để mô phỏng ghép mã mua thêm.`;
  }
}

// ── Tab 4: 3 Deals ─────────────────────────────────────────
async function onDealSymBlur(e) {
  const id = e.target.id;
  const sym = e.target.value.toUpperCase().trim();
  if (!sym) return;
  const p = await fetchPrice(sym);
  if (!p) return;
  // Mã B (mã giao dịch của Deal 1/2): chỉ fill giá B, không đụng r của mã A lưu ký.
  if (id === 'd1SymB' || id === 'd2SymB') {
    const pbId = id === 'd1SymB' ? 'd1PB' : 'd2PB';
    const noteId = id === 'd1SymB' ? 'd1PBnote' : 'd2PBnote';
    setNumVal($(pbId), p.price);
    $(noteId).textContent = `Giá tham chiếu: ${fmtVND(p.price)}`;
    recalcDeals();
    return;
  }
  if (id === 'd1Sym') { setNumVal($('d1P'), p.price); $('d1Pnote').textContent = `Giá tham chiếu: ${fmtVND(p.price)}`; }
  if (id === 'd2Sym') { setNumVal($('d2P'), p.price); $('d2Pnote').textContent = `Giá tham chiếu: ${fmtVND(p.price)}`; }
  if (id === 'd3Sym') { setNumVal($('d3P'), p.price); $('d3Pnote').textContent = `Giá tham chiếu: ${fmtVND(p.price)}`; }
  if (id === 'd4Sym') {
    setNumVal($('d4P'), p.price);
    setNumVal($('d4Pbuy'), p.price);
    $('d4Pnote').textContent = `Giá tham chiếu: ${fmtVND(p.price)}`;
  }
  // Auto-fill r from master
  const r = getR(sym);
  $('dR').value = r;
  recalcDeals();
}

function recalcDeals() {
  const r    = +$('dR').value   || 0.5;
  const Rtt  = +$('dRtt').value || 0.5;
  const fb   = getFb();
  const fs   = getFs();
  const rp   = Math.min(r, 1 - Rtt);
  $('dRp').textContent = (rp*100).toFixed(2) + '%';

  // Tỷ lệ cho vay HIỆU DỤNG theo mã: rp_eff = min(r, ts×(1−Rtt)).
  //   Dư nợ = V×rp_eff giữ Rtt (CMRp, cô lập) đúng mục tiêu kể cả khi ts<1.
  //   Vì tài sản đảm bảo bị chiết khấu theo ts, dư nợ tối đa = PV×(1−Rtt) = V×ts×(1−Rtt).
  const rpEff = sym => {
    const rr = (sym && STATE.master[sym.toUpperCase()]) ? getR(sym) : r;
    const ts = (sym && STATE.master[sym.toUpperCase()]) ? getTs(sym) : 1;
    return Math.min(rr, ts * (1 - Rtt));
  };

  // Phí ứng tiền (lãi ứng trước %/năm × số ngày T+ / 360) — lãi ứng lấy từ THAM SỐ OCBS
  const adv     = getAdvRate();                            // lãi ứng trước (tỷ lệ/năm)
  const advDays = (+$('dAdvDays')?.value || 0);            // số ngày chờ tiền bán về
  const pctAdv  = adv * advDays / 360;                     // tỷ lệ phí ứng theo kỳ

  // Deal 1 — chuỗi 4 bước: lưu ký A → mua B → bán B → ứng tiền bán B chờ về để rút.
  //   ① Sức mua sinh từ A = dư nợ tối đa debt1 = V_A·rp1 (kẹp theo hạn mức mã A).
  //   ② Mua cp B: KL_B tự tính = floor(sức mua / giá_B / 100)·100 (mua tối đa bằng sức mua).
  //                GT mua B = KL_B·giá_B → phí mua = GT·fb.
  //   ③ B về bán hết (hòa giá mua): GT bán B = GT mua B → phí+thuế bán = GT·fs.
  //   ④ Ứng tiền bán B chờ về (T+advDays): phí ứng = GT·pctAdv.
  //   NET rút = GT bán B − phí mua − phí bán − phí ứng. Dư nợ = GT mua B (CTCK ghi nợ, A vẫn lưu ký).
  const sym1 = $('d1Sym').value, ts1 = (sym1 && STATE.master[sym1.toUpperCase()]) ? getTs(sym1) : 1;
  const rp1 = rpEff(sym1);
  const N1 = getNumVal('d1N'), P1 = getNumVal('d1P');
  const V1 = N1 * P1;                  // giá trị danh nghĩa (N×P)
  const PV1 = V1 * ts1;                // giá trị tài sản đã chiết khấu
  let buyPower1 = V1 * rp1;            // ① sức mua = dư nợ tối đa từ A
  // Kẹp theo Hạn mức tối đa 1 mã: dư nợ phát sinh không vượt limit của mã d1Sym
  const lim1 = getStockLimit($('d1Sym').value);
  const cap1 = lim1 != null && buyPower1 > lim1;
  if (cap1) buyPower1 = lim1;
  // ② Mua cp B: có giá B → tự tính KL tối đa mua được bằng sức mua (làm tròn lô 100).
  const PB1 = getNumVal('d1PB');                             // giá giao dịch B
  const NB1 = PB1 > 0 ? Math.floor(buyPower1 / PB1 / 100) * 100 : 0;
  const Vbuy1 = NB1 * PB1;                                   // GT mua B = KL × giá (≤ sức mua)
  const Vsell1 = Vbuy1;               // ③ GT bán B (hòa giá mua)
  const feeBuy1  = Vbuy1  * fb;        // phí mua B
  const feeSell1 = Vsell1 * fs;        // phí + thuế bán B (fs đã gồm thuế)
  const feeAdv1  = Vsell1 * pctAdv;    // ④ phí ứng tiền bán B chờ về
  const cash1 = Vsell1 - feeBuy1 - feeSell1 - feeAdv1;   // NET rút được
  const debt1 = Vbuy1;                // dư nợ phát sinh = GT mua B
  showLimitWarn('d1LimitRow', 'd1LimitWarn', cap1, lim1, V1 * rp1);
  $('d1V').textContent      = fmtVND(V1);
  $('d1X').textContent      = fmtVND(buyPower1);
  $('d1NB').textContent     = fmtNum(NB1);
  $('d1VB').textContent     = fmtVND(Vbuy1);
  $('d1FeeBuy').textContent = fmtVND(feeBuy1);
  $('d1FeeSell').textContent= fmtVND(feeSell1);
  $('d1FeeAdv').textContent = fmtVND(feeAdv1);
  $('d1Cash').textContent   = fmtVND(cash1);
  $('d1Debt').textContent   = fmtVND(debt1);
  // Rtt cô lập theo CMRp: tài sản chiết khấu PV1, nợ = debt1.
  $('d1Rtt').textContent = PV1>0 ? fmtPct((PV1-debt1)/PV1) : '—';

  // Deal 2 — bài toán NGƯỢC của Deal 1: muốn rút NET = Y → lưu ký bao nhiêu cp A?
  //   NET = sức_mua · (1 − fb − fs − pctAdv) → sức_mua cần = Y / (1 − fb − fs − pctAdv).
  //   V_A cần = sức_mua / r' → N_A = ceil(V_A / P_A / 100)·100 (tròn LÊN để đủ Y).
  //   Mã B + giá B → KL B mua được = floor(sức_mua_thực / giá_B / 100)·100; chuỗi phí như Deal 1.
  const rp2 = rpEff($('d2Sym').value);
  const Y = getNumVal('d2Y'), P2 = getNumVal('d2P');
  const kNet = 1 - fb - fs - pctAdv;                          // hệ số NET / sức mua
  let buyPower2 = kNet > 0 ? Y / kNet : 0;                    // sức mua cần để rút đủ Y
  // Kẹp theo Hạn mức tối đa 1 mã: sức mua (= dư nợ) không vượt limit của mã A
  const lim2 = getStockLimit($('d2Sym').value);
  const cap2 = lim2 != null && buyPower2 > lim2;
  if (cap2) buyPower2 = lim2;          // không rút đủ Y bằng 1 mã
  const Vneed2 = rp2 > 0 ? buyPower2 / rp2 : 0;               // GT lưu ký A cần
  const N2 = P2 > 0 ? Math.ceil(Vneed2 / P2 / 100) * 100 : 0; // số cp A (tròn lên)
  const Vreal2 = N2 * P2;                                     // GT lưu ký A thực tế
  let bpReal2 = Vreal2 * rp2;                                 // sức mua thực sau làm tròn N_A
  if (lim2 != null && bpReal2 > lim2) bpReal2 = lim2;         // N_A tròn lên không vượt trần
  // ② Mua cp B từ sức mua thực; KL tự tính (lô 100). ③ bán hòa giá. ④ ứng tiền.
  const PB2 = getNumVal('d2PB');
  const NB2 = PB2 > 0 ? Math.floor(bpReal2 / PB2 / 100) * 100 : 0;
  const Vbuy2 = NB2 * PB2, Vsell2 = Vbuy2;
  const feeBuy2  = Vbuy2  * fb;
  const feeSell2 = Vsell2 * fs;
  const feeAdv2  = Vsell2 * pctAdv;
  const cash2 = Vsell2 - feeBuy2 - feeSell2 - feeAdv2;        // NET rút thực tế (≳ Y)
  const debt2 = Vbuy2;                                        // dư nợ phát sinh = GT mua B
  showLimitWarn('d2LimitRow', 'd2LimitWarn', cap2, lim2, (kNet>0 ? Y/kNet : 0));
  $('d2BP').textContent     = fmtVND(buyPower2);
  $('d2V').textContent      = fmtVND(Vneed2);
  $('d2N').textContent      = fmtNum(N2);
  $('d2Vreal').textContent  = fmtVND(Vreal2);
  $('d2NB').textContent     = fmtNum(NB2);
  $('d2VB').textContent     = fmtVND(Vbuy2);
  $('d2FeeBuy').textContent = fmtVND(feeBuy2);
  $('d2FeeSell').textContent= fmtVND(feeSell2);
  $('d2FeeAdv').textContent = fmtVND(feeAdv2);
  $('d2Cash').textContent   = fmtVND(cash2);
  $('d2Debt').textContent   = fmtVND(debt2);

  // Deal 3
  const rp3 = rpEff($('d3Sym').value);
  const Z = getNumVal('d3Z'), P3 = getNumVal('d3P');
  // Kẹp theo Hạn mức tối đa 1 mã: dư nợ mong muốn Z không thể vượt limit bằng 1 mã.
  const lim3 = getStockLimit($('d3Sym').value);
  const cap3 = lim3 != null && Z > lim3;
  const Zeff = cap3 ? lim3 : Z;        // dư nợ thực tế đạt được
  const Vneed3 = rp3 > 0 ? Zeff / rp3 : 0;
  const N3 = P3>0 ? Math.ceil(Vneed3 / P3 / 100) * 100 : 0;
  const Vreal3 = N3 * P3;
  let debt3 = Vreal3 * rp3;
  if (lim3 != null && debt3 > lim3) debt3 = lim3;   // N3 tròn lên không vượt trần
  const X3 = debt3 / (1 + fb);
  showLimitWarn('d3LimitRow', 'd3LimitWarn', cap3, lim3, Z);
  $('d3V').textContent    = fmtVND(Vneed3);
  $('d3N').textContent    = fmtNum(N3);
  $('d3Cash').textContent = fmtVND(X3 * (1 - fs));
  $('d3Debt').textContent = fmtVND(debt3);

  // Deal 4: Nộp X tiền mặt → mua tối đa N cp mã Y
  // OCBS cho vay theo giá tham chiếu (Pref), còn user trả tiền theo giá mua (Pbuy).
  //   Loan       = N · Pref · r'
  //   Cash chi   = N · Pbuy · (1+fb) − N · Pref · r'  = N · [Pbuy·(1+fb) − Pref·r']
  //   Đặt = X → N = floor( X / [Pbuy·(1+fb) − Pref·r'] / 100 ) × 100
  const rp4 = rpEff($('d4Sym').value);   // tỷ lệ cho vay hiệu dụng của mã d4 (theo ts & Rtt)
  const X4 = getNumVal('d4X');
  const P4ref = getNumVal('d4P');
  const P4buy = getNumVal('d4Pbuy') || P4ref;
  const perShareCash = P4buy * (1 + fb) - P4ref * rp4;  // tiền mặt cần cho 1 cp
  const Nmax4 = (perShareCash > 0) ? X4 / perShareCash : 0;
  let N4 = Math.max(0, Math.floor(Nmax4 / 100) * 100);
  // Kẹp theo Hạn mức tối đa 1 mã: dư nợ N4·Pref·rp4 không vượt limit của mã d4Sym
  const lim4 = getStockLimit($('d4Sym').value);
  const cap4 = lim4 != null && rp4 > 0 && P4ref > 0 && N4 * P4ref * rp4 > lim4;
  if (cap4) {
    const nByLimit = Math.floor(lim4 / (P4ref * rp4) / 100) * 100;
    N4 = Math.max(0, Math.min(N4, nByLimit));
  }
  showLimitWarn('d4LimitRow', 'd4LimitWarn', cap4, lim4, Math.floor(Nmax4/100)*100 * P4ref * rp4);
  const Vcost4   = N4 * P4buy;            // chi phí mua (giá đặt)
  const VrefVal4 = N4 * P4ref;            // giá trị stock để tính Rtt (giá TC)
  const debt4    = VrefVal4 * rp4;        // dư nợ vay margin
  const cash4    = N4 * perShareCash;     // tiền mặt thực dùng
  $('d4V').textContent    = fmtVND(Vcost4);
  $('d4N').textContent    = fmtNum(N4);
  $('d4Vreal').textContent= fmtVND(VrefVal4);
  $('d4Cash').textContent = fmtVND(cash4);
  $('d4Debt').textContent = fmtVND(debt4);
  $('d4Rem').textContent  = fmtVND(Math.max(0, X4 - cash4));
  // Rtt sau (CMRp) — TÍNH ĐỘC LẬP, chỉ trên giao dịch này (KHÔNG cộng danh mục Tab 1).
  //   PV = giá trị CK mới đã chiết khấu (VrefVal4 × ts); tiền = tiền nộp dư; nợ = debt4.
  const ts4 = getTs($('d4Sym').value);
  const PVafter4   = VrefVal4 * ts4;
  const cashAfter4 = Math.max(0, X4 - cash4);
  const Dafter4    = debt4;
  const den4 = PVafter4 + Math.max(cashAfter4 - Dafter4, 0);
  $('d4Rtt').textContent = (den4 > 0 && N4 > 0)
    ? fmtPct((PVafter4 + cashAfter4 - Dafter4) / den4)
    : '—';
}

// ╔════════ TAB 2: Phân bổ bán theo từng mã (mô phỏng) ════════╗
// Lưu lựa chọn bán theo mã: {SYM: {checked, qty, price}}. Giữ qua các lần render.
STATE.sellPlan = STATE.sellPlan || {};

// Danh sách holding hợp lệ (có mã + KL > 0) từ tab 1, gộp KL theo mã.
function getSellableHoldings() {
  const map = {};
  for (const h of STATE.holdings) {
    const sym = (h.sym || '').toUpperCase().trim();
    if (!sym || !h.qty || h.qty <= 0) continue;
    const pEval = evalPrice(sym, h.price);
    if (!pEval || pEval <= 0) continue;
    if (!map[sym]) map[sym] = { sym, qty: 0, price: pEval, r: h.r ?? getR(sym) };
    map[sym].qty += h.qty;       // gộp nếu cùng mã ở nhiều dòng
  }
  return Object.values(map);
}

function renderSellTable() {
  const tb = $('tblSell')?.querySelector('tbody');
  if (!tb) return;
  const holds = getSellableHoldings();
  const fs = getFs();                       // phí + thuế bán
  $('spFee').textContent = (fs * 100).toFixed(2).replace('.', ',') + '%';

  // Dọn sellPlan: bỏ mã không còn trong danh mục
  const validSyms = new Set(holds.map(h => h.sym));
  for (const s of Object.keys(STATE.sellPlan)) if (!validSyms.has(s)) delete STATE.sellPlan[s];

  $('sellNoHoldings').style.display = holds.length ? 'none' : '';

  tb.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const h of holds) {
    const plan = STATE.sellPlan[h.sym] || { checked: false, qty: 0, price: h.price };
    // Giá bán mặc định = giá đánh giá; KL bán kẹp trong KL đang giữ
    const sellPrice = plan.price || h.price;
    const sellQty   = Math.min(plan.qty || 0, h.qty);
    const gt        = plan.checked ? sellQty * sellPrice : 0;
    const cash      = gt * (1 - fs);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="text-align:center"><input type="checkbox" data-sym="${h.sym}" data-f="checked" ${plan.checked ? 'checked' : ''}></td>
      <td style="font-weight:700;color:#1F3864;text-align:center">${h.sym}</td>
      <td style="text-align:center">${(h.r*100).toFixed(0)}%</td>
      <td style="text-align:right">${fmtNum(h.qty)}</td>
      <td><input type="text" inputmode="numeric" data-num data-sym="${h.sym}" data-f="price" value="${fmtNumInput(sellPrice)}" style="width:120px"></td>
      <td><input type="text" inputmode="numeric" data-num data-sym="${h.sym}" data-f="qty" value="${fmtNumInput(sellQty)}" style="width:110px"></td>
      <td class="calc" style="text-align:right">${gt ? fmtVND(gt) : '0'}</td>
      <td class="calc" style="text-align:right">${cash ? fmtVND(cash) : '0'}</td>
    `;
    frag.appendChild(tr);
  }
  tb.appendChild(frag);

  recalcSell();
}

// Tổng GT bán (giá thị trường) cần để Rtt đạt target, theo CMRp + chiết khấu ts.
//   Bán S: PV↓ S·tsAvg, nợ↓ S·(1−fs). Giải (PV−S·ts − (D−S(1−fs)))/(PV−S·ts) = t
//   → S = (D − PV·(1−t)) / (1 − fs − ts + t·ts). tsAvg = PV/totMV (bình quân danh mục CP).
function sellNeededForTarget(acc, fs, target) {
  const PV = acc.PV || 0, D = acc.D || 0, totMV = acc.totMV || 0;
  const tsAvg = totMV > 0 ? PV / totMV : 1;
  const den = 1 - fs - tsAvg + target * tsAvg;
  return den > 1e-9 ? Math.max(0, (D - PV * (1 - target)) / den) : 0;
}

function recalcSell() {
  const acc = STATE.account || { V:0, Vmkt:0, PV:0, D:0, E:0, cash:0, totDmax:0 };
  const { D } = acc;
  const PV = acc.PV || 0, cashNow = acc.cash || 0;
  const fs = getFs();
  const holds = getSellableHoldings();

  // Tổng GT bán (giá thị trường) + sụt PV (đã chiết khấu theo ts) + Dmax giảm.
  let S = 0, pvDrop = 0, dmaxDrop = 0;
  for (const h of holds) {
    const plan = STATE.sellPlan[h.sym];
    if (!plan || !plan.checked) continue;
    const q  = Math.min(plan.qty || 0, h.qty);
    const px = plan.price || h.price;
    const gt = q * px;
    S += gt;
    pvDrop   += gt * getTs(h.sym);      // PV sụt theo giá trị tài sản đã chiết khấu
    // Bán q cp mã này → giảm Dmax = (q·px)·r (kẹp theo limit không xét ở mức mã đơn lẻ)
    dmaxDrop += gt * h.r;
  }
  const cash = S * (1 - fs);            // tiền thực trả nợ (giá thị trường)
  const fee  = S * fs;                  // phí + thuế mất đi
  // Sau bán: PV↓ pvDrop, tiền nhận về cash dùng trả nợ → D↓; tiền dư (nếu cash>D) ở lại.
  const PVafter   = Math.max(0, PV - pvDrop);
  const Dafter    = Math.max(0, D - cash);
  const cashAfter = Math.max(0, cashNow + cash - (D - Dafter)); // phần tiền chưa dùng trả nợ
  const Vafter    = PVafter + cashAfter;                        // tổng tài sản (chiết khấu) sau bán
  const denAfter  = PVafter + Math.max(cashAfter - Dafter, 0);  // mẫu số CMRp
  const rttAfter  = denAfter > 0 ? (PVafter + cashAfter - Dafter) / denAfter : 0;
  const dmaxAfter = Math.max(0, (acc.totDmax || 0) - dmaxDrop);
  const roomAfter = dmaxAfter - Dafter;

  $('sellTotGT').textContent   = fmtVND(S);
  $('sellTotCash').textContent = fmtVND(cash);
  $('rsS').textContent    = fmtVND(S);
  $('rsCash').textContent = fmtVND(cash);
  $('rsFee').textContent  = fmtVND(fee);
  $('rsV').textContent    = fmtVND(Vafter);
  $('rsD').textContent    = fmtVND(Dafter);
  $('rsDmax').textContent = fmtVND(dmaxAfter);
  $('rsRoom').textContent = fmtVND(roomAfter);
  $('rsRtt').textContent  = S > 0 ? fmtPct(rttAfter) : '—';

  // Trạng thái so mục tiêu
  const target = +$('sellTarget').value || 0.35;
  const stEl = $('rsStatus');
  if (S <= 0) {
    stEl.textContent = '— (chọn mã & nhập KL bán để mô phỏng)';
    stEl.className = 'status';
  } else if (rttAfter >= target) {
    stEl.textContent = `✅ Đạt mục tiêu Rtt ≥ ${(target*100)|0}% (sau bán: ${fmtPct(rttAfter)})`;
    stEl.className = 'status safe';
  } else {
    // còn thiếu bao nhiêu GT bán nữa để đạt target (CMRp + chiết khấu ts)
    const needS = sellNeededForTarget(acc, fs, target);
    const more  = Math.max(0, needS - S);
    stEl.textContent = `⚠️ Chưa đủ — Rtt sau bán ${fmtPct(rttAfter)} < ${(target*100)|0}%. Cần bán thêm ~${fmtVND(more)} đ GT nữa.`;
    stEl.className = 'status watch';
  }
}

// Tự chia KL bán theo thứ tự mã đang được tick, đủ để đạt mục tiêu Rtt.
// Tổng GT bán cần (CMRp + chiết khấu ts): xem sellNeededForTarget.
function autoFillSell() {
  const acc = STATE.account || { V:0, D:0, E:0, PV:0, totMV:0 };
  const fs = getFs();
  const target = +$('sellTarget').value || 0.35;
  let needS = sellNeededForTarget(acc, fs, target);

  const holds = getSellableHoldings();
  // Chỉ chia cho các mã đang tick; nếu chưa tick mã nào → tick tất cả theo thứ tự bảng
  let checkedSyms = holds.filter(h => STATE.sellPlan[h.sym]?.checked).map(h => h.sym);
  if (!checkedSyms.length) {
    holds.forEach(h => { STATE.sellPlan[h.sym] = { ...(STATE.sellPlan[h.sym]||{}), checked: true, price: h.price }; });
    checkedSyms = holds.map(h => h.sym);
  }

  let remain = needS;
  for (const h of holds) {
    if (!checkedSyms.includes(h.sym)) continue;
    const plan = STATE.sellPlan[h.sym] || { checked: true, price: h.price };
    const px = plan.price || h.price;
    if (remain <= 0 || px <= 0) { plan.qty = 0; STATE.sellPlan[h.sym] = plan; continue; }
    const maxGT = h.qty * px;                 // bán hết mã này
    const takeGT = Math.min(remain, maxGT);
    // làm tròn KL lên bội số 100 cho đủ (không bán lẻ dưới lô)
    let q = Math.ceil(takeGT / px / 100) * 100;
    q = Math.min(q, h.qty);                    // không vượt KL đang giữ
    plan.qty = q;
    plan.checked = true;
    STATE.sellPlan[h.sym] = plan;
    remain -= q * px;
  }
  renderSellTable();
}

// Wiring cho bảng bán (event delegation)
function wireSellTable() {
  const tbl = $('tblSell');
  if (!tbl) return;
  tbl.addEventListener('input', e => {
    const t = e.target; const sym = t.dataset.sym; if (!sym) return;
    const f = t.dataset.f;
    STATE.sellPlan[sym] = STATE.sellPlan[sym] || { checked:false, qty:0, price:0 };
    if (f === 'checked')      STATE.sellPlan[sym].checked = t.checked;
    else if (f === 'qty')     STATE.sellPlan[sym].qty   = parseNum(t.value);
    else if (f === 'price')   STATE.sellPlan[sym].price = parseNum(t.value);
    recalcSell();
    // cập nhật riêng 2 ô GT/tiền của dòng đó để không reset caret khi đang gõ
    if (f === 'qty' || f === 'price') {
      const row = t.closest('tr');
      const p = STATE.sellPlan[sym];
      const holds = getSellableHoldings().find(h => h.sym === sym);
      const q = Math.min(p.qty||0, holds?.qty||0);
      const gt = p.checked ? q * (p.price||holds?.price||0) : 0;
      const cells = row.querySelectorAll('td.calc');
      if (cells[0]) cells[0].textContent = gt ? fmtVND(gt) : '0';
      if (cells[1]) cells[1].textContent = gt ? fmtVND(gt*(1-getFs())) : '0';
    }
  });
  // checkbox dùng change để chắc ăn
  tbl.addEventListener('change', e => {
    if (e.target.dataset.f === 'checked') renderSellTable();
  });
  $('btnAutoFill').onclick  = autoFillSell;
  $('btnClearSell').onclick = () => { STATE.sellPlan = {}; renderSellTable(); };
  $('sellTarget').addEventListener('change', recalcSell);
}

// ╔════════════════ TAB 5: Mượn hàng ═════════════════════════╗
// Ngày nghỉ lễ VN (CK đóng cửa) — định dạng 'YYYY-MM-DD'.
// 2026: Tết DL 1/1; Tết Âm 17–21/2 (mùng 1 = 17/2); Giỗ tổ 26/4(CN)→nghỉ bù 27/4;
//        30/4, 1/5; Quốc khánh 2/9 + nghỉ 1/9. (Có thể cập nhật khi nhà nước công bố.)
const VN_HOLIDAYS = new Set([
  '2026-01-01',
  '2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20',
  '2026-04-27',
  '2026-04-30','2026-05-01',
  '2026-09-01','2026-09-02',
]);
// true nếu ngày là phiên nghỉ (T7, CN, hoặc lễ)
function isHoliday(d) {
  const wd = d.getDay();              // 0 = CN, 6 = T7
  if (wd === 0 || wd === 6) return true;
  return VN_HOLIDAYS.has(toISODate(d));
}
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseISODate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
// Ngày trả = ngày mượn + 2 phiên giao dịch. Đếm 2 phiên giao dịch (bỏ qua T7/CN/lễ),
// nếu kết quả rơi vào ngày nghỉ thì dời tiếp sang phiên kế. Trả về Date.
function computeReturnDate(borrow) {
  if (!borrow) return null;
  let d = new Date(borrow.getTime());
  let sessions = 0;
  // bước qua từng ngày, mỗi phiên giao dịch hợp lệ tính 1, cần đủ 2 phiên (T+2)
  while (sessions < 2) {
    d.setDate(d.getDate() + 1);
    if (!isHoliday(d)) sessions++;
  }
  return d;
}
// Số ngày lịch giữa 2 mốc
function daysBetween(a, b) {
  if (!a || !b) return 0;
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / 86400000);
}

let mReturnAutoFilled = true;  // true khi ngày trả do app tự điền (chưa bị user sửa tay)

async function onMuonSymBlur() {
  const sym = $('mSym').value.toUpperCase().trim();
  if (!sym) return;
  const p = await fetchPrice(sym);
  if (p) { setNumVal($('mPrice'), p.price); $('mPriceNote').textContent = `Giá tham chiếu: ${fmtVND(p.price)}`; }
  recalcMuon();
}

// Khi đổi ngày mượn → tự tính lại ngày trả (nếu user chưa override)
function onBorrowDateChange() {
  const borrow = parseISODate($('mDateBorrow').value);
  if (borrow && mReturnAutoFilled) {
    const ret = computeReturnDate(borrow);
    if (ret) $('mDateReturn').value = toISODate(ret);
  }
  recalcMuon();
}

function recalcMuon() {
  const qty   = getNumVal('mQty');
  const price = getNumVal('mPrice');
  const value = qty * price;                 // Giá trị mượn
  $('mValue').textContent = fmtVND(value);

  const borrow = parseISODate($('mDateBorrow').value);
  const ret    = parseISODate($('mDateReturn').value);
  const days   = daysBetween(borrow, ret);
  $('mDays').textContent = days > 0 ? `${days} ngày` : '—';

  // Tham số % (nhập theo %, chia 100 khi nhân giá trị)
  const fee    = (+$('mFee').value        || 0);   // phí GD mua/bán %
  const tax    = (+$('mTax').value        || 0);   // thuế bán %
  const brw    = (+$('mFeeBorrow').value  || 0);   // phí mượn hàng %
  const adv    = (+$('mFeeAdvance').value || 0);   // phí ứng %/năm

  // Tổng flow phí (%)
  const pctSell    = fee + tax;                    // bán = phí + thuế
  const pctBuy     = fee;                          // mua = phí
  const pctAdvance = adv * days / 360;             // ứng theo kỳ
  const pctBorrow  = brw;                          // phí mượn hàng
  $('mPctSell').textContent    = pctSell.toFixed(3) + '%';
  $('mPctBuy').textContent     = pctBuy.toFixed(3) + '%';
  $('mPctAdvance').textContent = pctAdvance.toFixed(4) + '%';
  $('mPctBorrow').textContent  = pctBorrow.toFixed(3) + '%';

  // Các khoản phí (đồng)
  const feeSell = value * pctSell    / 100;
  const feeBuy  = value * pctBuy     / 100;
  const feeAdv  = value * pctAdvance / 100;
  const feeBrw  = value * pctBorrow  / 100;
  const totalFee = feeSell + feeBuy + feeAdv + feeBrw;
  $('mFeeSell').textContent = fmtVND(feeSell);
  $('mFeeBuy').textContent  = fmtVND(feeBuy);
  $('mFeeAdv').textContent  = fmtVND(feeAdv);
  $('mFeeBrw').textContent  = fmtVND(feeBrw);
  $('mTotalFee').textContent = fmtVND(totalFee);

  // Giá trả hàng = (giá trị mượn − tổng phí) / khối lượng
  const returnPrice = qty > 0 ? (value - totalFee) / qty : 0;
  $('mReturnPrice').textContent = qty > 0 ? fmtVND(returnPrice) : '—';
}

// ── Tab 5: Caps editor ─────────────────────────────────────
// ── Sort state for caps table ─────────────────────────────────
let capSort = { field: 'sym', asc: true };

function renderCaps() {
  const tb    = $('tblCaps').querySelector('tbody');
  const search = ($('capSearch').value || '').toUpperCase().trim();
  const filter = $('capFilter')?.value || 'all';
  const exch   = $('capExch')?.value  || '';

  // Build rows from full master list
  let rows = Object.entries(STATE.master).map(([sym, m]) => ({
    sym, name: m.name || '', exch: m.exch || '', r: m.r ?? 0.5,
    high: STATE.caps[sym]?.high || null,
    low:  STATE.caps[sym]?.low  || null,
    pl1Cap: m.cap || null,
    limit:  m.limit || null,
  }));

  // Filter
  if (search) rows = rows.filter(r => r.sym.includes(search) || r.name.toUpperCase().includes(search));
  if (filter === 'capped') rows = rows.filter(r => r.high || r.low || r.pl1Cap);
  if (filter === 'nocap')  rows = rows.filter(r => !r.high && !r.low && !r.pl1Cap);
  if (exch) rows = rows.filter(r => r.exch === exch);

  // Sort
  rows.sort((a, b) => {
    let va = a[capSort.field], vb = b[capSort.field];
    if (typeof va === 'string') va = va.toLowerCase(), vb = (vb||'').toLowerCase();
    if (va < vb) return capSort.asc ? -1 :  1;
    if (va > vb) return capSort.asc ?  1 : -1;
    return 0;
  });

  // Render (limit 200 rows at a time for perf)
  const total = rows.length;
  const show  = rows.slice(0, 200);

  tb.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const row of show) {
    const tr = document.createElement('tr');
    const refPx = STATE.prices[row.sym]?.price;
    const placeholderHigh = row.pl1Cap
      ? row.pl1Cap.toLocaleString('vi-VN')
      : (refPx ? refPx.toLocaleString('vi-VN') : 'giá TC');
    const pl1Tag = row.pl1Cap ? `<span style="font-size:10px;color:#2e7d32" title="PL1: ${row.pl1Cap.toLocaleString('vi-VN')}đ">PL1</span>` : '';
    const limTxt = row.limit ? `${(row.limit/1e9).toFixed(0)} tỷ` : '—';
    tr.innerHTML = `
      <td style="font-weight:700;color:#1F3864">${row.sym} ${pl1Tag}</td>
      <td style="text-align:left;font-size:12px;color:#444">${row.name}</td>
      <td style="text-align:center;font-size:12px">${row.exch}</td>
      <td style="text-align:center;font-weight:600;color:${row.r>=0.5?'#1a5276':'#7d6608'}">${(row.r*100).toFixed(0)}%</td>
      <td><input type="number" data-sym="${row.sym}" data-f="high" value="${row.high||''}"
          placeholder="${placeholderHigh}" style="${row.high ? 'background:#FFF2CC;color:#7d6608;font-weight:600' : ''}"></td>
      <td><input type="number" data-sym="${row.sym}" data-f="low"  value="${row.low||''}"
          placeholder="—" style="${row.low  ? 'background:#FFF2CC;color:#7d6608;font-weight:600' : ''}"></td>
      <td style="text-align:center;font-size:12px;color:#666">${limTxt}</td>
    `;
    frag.appendChild(tr);
  }
  tb.appendChild(frag);

  const cappedCount = Object.keys(STATE.caps).length;
  $('capInfo').textContent = `${cappedCount} mã đã có giá chặn`;
  if ($('listCount')) $('listCount').textContent = Object.keys(STATE.master).length;
  if ($('capPageInfo')) {
    $('capPageInfo').textContent = total > 200
      ? `Hiển thị 200/${total} kết quả – hãy tìm kiếm để thu hẹp`
      : `${total} mã`;
  }
}

// Sort by column header click
$('tblCaps').querySelector('thead').addEventListener('click', e => {
  const s = e.target.dataset.sort; if (!s) return;
  capSort.asc = capSort.field === s ? !capSort.asc : true;
  capSort.field = s;
  // Update arrow indicators
  $('tblCaps').querySelectorAll('th[data-sort]').forEach(th => {
    const base = th.textContent.replace(/ [↑↓↕]$/,'');
    th.textContent = base + (th.dataset.sort === s ? (capSort.asc ? ' ↑' : ' ↓') : ' ↕');
  });
  renderCaps();
});

$('tblCaps').addEventListener('input', e => {
  const t = e.target; if (!t.dataset.sym) return;
  const sym = t.dataset.sym, f = t.dataset.f;
  const val = +t.value || null;
  if (val) {
    STATE.caps[sym] = STATE.caps[sym] || {};
    STATE.caps[sym][f] = val;
    t.style.background = '#FFF2CC'; t.style.color = '#7d6608'; t.style.fontWeight = '600';
  } else {
    if (STATE.caps[sym]) { STATE.caps[sym][f] = null; }
    if (STATE.caps[sym] && !STATE.caps[sym].high && !STATE.caps[sym].low) delete STATE.caps[sym];
    t.style.background = ''; t.style.color = ''; t.style.fontWeight = '';
  }
  const cappedCount = Object.keys(STATE.caps).length;
  $('capInfo').textContent = `${cappedCount} mã đã có giá chặn`;
  recalcAll();
});

$('capSave').onclick = saveCaps;
$('capSearch').oninput = renderCaps;
$('capFilter').oninput = renderCaps;
$('capExch').oninput   = renderCaps;

// ── Wire general inputs ────────────────────────────────────
['aCash','aDebt','aInt','pFb','pLoanRate','pAdvRate','pCall','pForce','pMaxLoan','bSym','bPrice','bQtyWant','bQtyChoose',
 'dR','dRtt','dAdvDays','d1N','d1P','d1PB','d2Y','d2P','d2PB','d3Z','d3P','d4X','d4P','d4Pbuy']
.forEach(id => { const el = $(id); if (el) el.addEventListener('input', recalcAll); });

['d1Sym','d1SymB','d2Sym','d2SymB','d3Sym','d4Sym'].forEach(id => $(id).addEventListener('change', onDealSymBlur));
$('bSym').addEventListener('change', onBuySymBlur);

// ── Tab 2: Phân bổ bán theo mã ─────────────────────────────
wireSellTable();

// ── Tab 5: Mượn hàng wiring ────────────────────────────────
['mQty','mPrice','mFee','mTax','mFeeBorrow','mFeeAdvance']
  .forEach(id => { const el = $(id); if (el) el.addEventListener('input', recalcMuon); });
$('mSym').addEventListener('change', onMuonSymBlur);
$('mDateBorrow').addEventListener('change', onBorrowDateChange);
$('mDateReturn').addEventListener('change', () => { mReturnAutoFilled = false; recalcMuon(); });

$('btnRefreshAll').onclick = async () => {
  for (let i = 0; i < 10; i++) {
    const sym = STATE.holdings[i].sym; if (!sym) continue;
    const p = await fetchPrice(sym);
    if (p) {
      const el = document.querySelector(`input[data-i="${i}"][data-f="price"]`);
      setNumVal(el, p.price);
      STATE.holdings[i].price = p.price;
    }
  }
  recalcAll();
};
$('btnClearRows').onclick = () => {
  document.querySelectorAll('#tblHoldings tbody input').forEach(el => {
    if (el.dataset.f === 'r') { el.value = 0.5; el.style.background = '#FFF9C4'; delete el.dataset.manualEdit; }
    else if (el.type === 'number') el.value = 0;
    else el.value = '';
  });
  STATE.holdings = Array.from({length:10}, () => ({sym:'', qty:0, price:0, r:0.5}));
  recalcAll();
};

// Prefetch giá tham chiếu cho các ô mặc định (Deal 1/2/3, Sức mua)
async function prefetchDefaultPrices() {
  const targets = [
    { symId: 'd1Sym', priceId: 'd1P', noteId: 'd1Pnote' },
    { symId: 'd1SymB', priceId: 'd1PB', noteId: 'd1PBnote' },
    { symId: 'd2Sym', priceId: 'd2P', noteId: 'd2Pnote' },
    { symId: 'd2SymB', priceId: 'd2PB', noteId: 'd2PBnote' },
    { symId: 'd3Sym', priceId: 'd3P', noteId: 'd3Pnote' },
    { symId: 'd4Sym', priceId: 'd4P', noteId: 'd4Pnote', buyId: 'd4Pbuy' },
    { symId: 'bSym',  priceId: 'bPrice', noteId: 'bPriceNote' },
  ];
  await Promise.all(targets.map(async t => {
    const sym = $(t.symId)?.value?.toUpperCase().trim();
    if (!sym) return;
    const p = await fetchPrice(sym);
    if (!p) return;
    setNumVal($(t.priceId), p.price);
    if (t.buyId && $(t.buyId)) setNumVal($(t.buyId), p.price);
    if (t.noteId && $(t.noteId)) $(t.noteId).textContent = `Giá tham chiếu: ${fmtVND(p.price)}`;
  }));
  recalcAll();
}

// Khởi tạo ngày mượn = hôm nay, ngày trả = T+2 (auto skip nghỉ/lễ)
function initMuonDates() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  $('mDateBorrow').value = toISODate(today);
  const ret = computeReturnDate(today);
  if (ret) $('mDateReturn').value = toISODate(ret);
  mReturnAutoFilled = true;
}

// Prefetch giá tham chiếu cho mã mượn mặc định
async function prefetchMuonPrice() {
  const sym = $('mSym')?.value?.toUpperCase().trim();
  if (!sym) return;
  const p = await fetchPrice(sym);
  if (!p) return;
  setNumVal($('mPrice'), p.price);
  if ($('mPriceNote')) $('mPriceNote').textContent = `Giá tham chiếu: ${fmtVND(p.price)}`;
}

// ── Init ───────────────────────────────────────────────────
(async () => {
  await loadMaster();
  await loadCaps();
  await loadPrices();
  initHoldingsTable();
  initMuonDates();
  recalcAll();
  await prefetchDefaultPrices();
  await prefetchMuonPrice();
  recalcMuon();
})();
