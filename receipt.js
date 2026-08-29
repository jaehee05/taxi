/* 영수증 렌더링 공통 모듈 — 미터기(app.js)와 공유 링크 페이지(r.js)가 함께 쓴다.
   감열지 영수증 모양을 DOM 과 캔버스 양쪽에서 같은 데이터로 그린다. */

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
const won = (n) => Math.round(n).toLocaleString('ko-KR');
const pad2 = (n) => String(n).padStart(2, '0');

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- 영수증 데이터 ---------- */
/* 실제 영수증처럼 요금을 항목으로 쪼갠다. 할증액은 합계에서 역산해
   반올림 잔돈까지 흡수시키므로, 항목의 합이 언제나 합계와 맞는다. */
function receiptModel(t) {
  const d = new Date(t.startedAt), e = new Date(t.endedAt);
  const base = t.base ?? 4800;
  const unitFare = t.unitFare ?? 100;
  const metered = t.metered ?? base;
  const drive = metered - base;
  const units = t.units ?? (unitFare ? Math.round(drive / unitFare) : 0);
  const out = t.outFare || 0;
  const night = t.surcharge ? Math.round((metered + out) * t.surcharge / 100) : 0;

  const items = [{ name: '기본요금', unit: base, qty: 1, amount: base }];
  if (drive > 0) items.push({ name: '주행요금', unit: unitFare, qty: units, amount: drive });
  if (out > 0) items.push({ name: `시계외할증 ${(t.distOut / 1000).toFixed(1)}km`, amount: out });
  if (night > 0) items.push({ name: `심야할증 ${t.surcharge}%`, amount: night });

  // 최종 요금은 100원 단위로 반올림하므로 그 차액을 항목으로 드러낸다.
  // 이렇게 해야 항목의 합이 언제나 합계와 맞는다.
  const adj = t.fare - items.reduce((a, it) => a + it.amount, 0);
  if (adj !== 0) items.push({ name: '단수조정', amount: adj });

  const info = [
    ['승 차', `${pad2(d.getHours())}:${pad2(d.getMinutes())}`],
    ['하 차', `${pad2(e.getHours())}:${pad2(e.getMinutes())}`],
    ['주행거리', `${(t.dist / 1000).toFixed(2)} km`],
    ['주행시간', fmtTime(t.sec)],
  ];
  if (t.passenger) info.push(['손 님', t.passenger]);

  const no = `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  return {
    plate: t.plate || '08어 9766',
    when: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
    no,
    items, info,
    total: t.fare,
    barcode: `${String(d.getFullYear()).slice(2)}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
             `${pad2(d.getHours())}${pad2(d.getMinutes())}${String(t.fare).padStart(6, '0')}`,
  };
}

// 옛 기록이나 텍스트 공유에서 쓰는 단순 행 목록
function tripRows(t) {
  const m = receiptModel(t);
  return [...m.items.map((it) => [it.name, won(it.amount) + '원']), ...m.info];
}
function receiptSubtitle(t) {
  return new Date(t.startedAt).toLocaleDateString('ko-KR') + ' · 짭택시 ' + (t.plate || '08어 9766');
}
function receiptText(t) {
  const m = receiptModel(t);
  return [
    '🚕 짭택시 영수증',
    `${m.when}  NO : ${m.no}`,
    '─────────────',
    ...m.items.map((it) => `${it.name}: ${won(it.amount)}원`),
    '─────────────',
    `합계: ${won(m.total)}원`,
    '',
    ...m.info.map(([k, v]) => `${k}: ${v}`),
    '',
    '※ 현금·카드 결제 가능',
  ].join('\n');
}

/* ---------- DOM ---------- */
function renderReceiptDOM(host, t) {
  const m = receiptModel(t);
  const item = (it) => it.unit === undefined
    ? `<div class="ln"><span>${esc(it.name)}</span><b>${won(it.amount)}</b></div>`
    : `<div class="ln nm">${esc(it.name)}</div>
       <div class="ln qty"><span>${won(it.unit)}</span><span>${it.qty}</span><b>${won(it.amount)}</b></div>`;

  host.innerHTML = `
    <div class="rc-head">
      <div class="rc-logo">짭택시</div>
      <div class="rc-biz">
        경기도 성남시 분당구<br>
        차량번호 ${esc(m.plate)}<br>
        개인택시 · 대표 재희
      </div>
    </div>
    <div class="rc-when">${esc(m.when)}&nbsp;&nbsp;NO : ${esc(m.no)}</div>
    <div class="rc-sep"></div>
    <div class="ln cols"><span>항목</span><span>단가수량</span><b>금액</b></div>
    <div class="rc-sep"></div>
    <div class="rc-items">${m.items.map(item).join('')}</div>
    <div class="rc-sep"></div>
    <div class="rc-total"><span>합 계</span><b>${won(m.total)}</b></div>
    <div class="rc-sep"></div>
    <div class="rc-info">${m.info.map(([k, v]) =>
      `<div class="ln"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <div class="rc-sep"></div>
    <div class="rc-note">※ 현금·카드 결제 가능</div>
    <svg class="rc-bars" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
      ${barcodeBars(m.barcode, 200).map((b) =>
        `<rect x="${b.x}" y="0" width="${b.w}" height="40"/>`).join('')}
    </svg>
    <div class="rc-code">${esc(m.barcode)}</div>`;
}

/* 숫자에서 막대 패턴을 만든다. 실제 규격은 아니고 생김새만 흉내 낸다.
   막대와 여백의 총 단위를 먼저 세어 주어진 폭을 정확히 채운다. */
function barcodeBars(code, width) {
  const pattern = [[1, 1], [1, 1]];                      // 시작 가드
  for (const ch of code) {
    const d = (+ch || 0);
    pattern.push([1 + (d % 3), 1 + ((d >> 1) % 2)]);
  }
  pattern.push([1, 1], [1, 0]);                          // 끝 가드

  const units = pattern.reduce((a, [w, g]) => a + w + g, 0);
  const step = width / units;
  const bars = [];
  let x = 0;
  for (const [w, g] of pattern) {
    bars.push({ x, w: w * step });
    x += (w + g) * step;
  }
  return bars;
}

/* ---------- 이미지 ---------- */
const MONO = 'ui-monospace,"SF Mono",Menlo,"D2Coding",monospace';
const KR = '"Apple SD Gothic Neo",-apple-system,system-ui,sans-serif';
const IMG_W = 620;          // 논리 폭 (실제 PNG 는 2배)
const PAGE = '#e9e9e9';     // 종이 바깥 배경
const TOOTH = 13;           // 절취선 톱니 너비
const TOOTH_H = 9;

function drawReceipt(t) {
  const m = receiptModel(t);
  const px = 52;                       // 종이 좌우 여백
  const pw = IMG_W - px * 2;           // 종이 폭
  const pad = 30;                      // 종이 안쪽 여백
  const L = px + pad, R = px + pw - pad;

  // 높이를 먼저 계산한다
  const itemH = m.items.reduce((a, it) => a + (it.unit === undefined ? 30 : 56), 0);
  const h = 26 + 92 + 34 + 20 + 30 + 20 + itemH + 20 + 60 + 20 +
            m.info.length * 30 + 20 + 40 + 70 + 34 + 26;

  const dpr = 2;
  const cv = document.createElement('canvas');
  cv.width = IMG_W * dpr;
  cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = PAGE;
  ctx.fillRect(0, 0, IMG_W, h);
  ctx.fillStyle = '#fff';
  ctx.fillRect(px, 0, pw, h);
  tornEdge(ctx, px, pw, 0, 1);         // 위쪽 절취선
  tornEdge(ctx, px, pw, h, -1);        // 아래쪽 절취선

  const ink = '#111';
  let y = 26 + TOOTH_H;

  // 상호
  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  ctx.font = `800 34px ${KR}`;
  ctx.fillText('짭택시', L, y + 30);
  ctx.textAlign = 'right';
  ctx.font = `13px ${MONO}`;
  ctx.fillText('경기도 성남시 분당구', R, y + 8);
  ctx.fillText(`차량번호 ${m.plate}`, R, y + 28);
  ctx.fillText('개인택시 · 대표 재희', R, y + 48);
  y += 82;

  ctx.textAlign = 'left';
  ctx.font = `15px ${MONO}`;
  ctx.fillText(`${m.when}  NO : ${m.no}`, L, y + 15);
  y += 34;

  y = sep(ctx, L, R, y);

  // 열 제목
  ctx.font = `15px ${MONO}`;
  ctx.textAlign = 'left';   ctx.fillText('항목', L + 10, y + 15);
  ctx.textAlign = 'center'; ctx.fillText('단가수량', (L + R) / 2 + 20, y + 15);
  ctx.textAlign = 'right';  ctx.fillText('금 액', R, y + 15);
  y += 30;
  y = sep(ctx, L, R, y);

  // 항목
  for (const it of m.items) {
    ctx.font = `15px ${MONO}`;
    if (it.unit === undefined) {
      ctx.textAlign = 'left';  ctx.fillText(it.name, L + 10, y + 15);
      ctx.textAlign = 'right'; ctx.fillText(won(it.amount), R, y + 15);
      y += 30;
    } else {
      ctx.textAlign = 'left';  ctx.fillText(it.name, L + 10, y + 15);
      y += 26;
      ctx.textAlign = 'right';
      ctx.fillText(won(it.unit), L + 190, y + 15);
      ctx.fillText(String(it.qty), L + 250, y + 15);
      ctx.fillText(won(it.amount), R, y + 15);
      y += 30;
    }
  }
  y = sep(ctx, L, R, y);

  // 합계
  ctx.textAlign = 'left';
  ctx.font = `800 30px ${KR}`;
  ctx.fillText('합', L + 6, y + 32);
  ctx.fillText('계', L + 74, y + 32);
  ctx.textAlign = 'right';
  ctx.font = `800 34px ${MONO}`;
  ctx.fillText(won(m.total), R, y + 33);
  y += 60;
  y = sep(ctx, L, R, y);

  // 운행 정보
  ctx.font = `15px ${MONO}`;
  for (const [k, v] of m.info) {
    ctx.textAlign = 'left';  ctx.fillText(k, L + 10, y + 15);
    ctx.textAlign = 'right'; ctx.fillText(v, R, y + 15);
    y += 30;
  }
  y = sep(ctx, L, R, y);

  ctx.textAlign = 'left';
  ctx.font = `15px ${MONO}`;
  ctx.fillText('※ 현금·카드 결제 가능', L, y + 15);
  y += 40;

  // 바코드
  const bw = pw - pad * 2 - 40;
  const bx = px + pad + 20;
  for (const b of barcodeBars(m.barcode, bw)) {
    ctx.fillRect(bx + b.x, y, Math.max(1, b.w), 52);
  }
  y += 70;
  ctx.textAlign = 'center';
  ctx.font = `17px ${MONO}`;
  ctx.fillText(m.barcode, IMG_W / 2, y + 17);

  return cv;
}

function sep(ctx, l, r, y) {
  ctx.save();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 6]);
  ctx.beginPath();
  ctx.moveTo(l, y + 10);
  ctx.lineTo(r, y + 10);
  ctx.stroke();
  ctx.restore();
  return y + 20;
}

// 종이 끝을 톱니 모양으로 뜯어 낸다 (배경색 삼각형을 덮어씌우는 방식)
function tornEdge(ctx, x, w, edgeY, dir) {
  ctx.fillStyle = PAGE;
  for (let i = 0; i * TOOTH < w; i++) {
    const x0 = x + i * TOOTH;
    const x1 = Math.min(x0 + TOOTH, x + w);
    ctx.beginPath();
    ctx.moveTo(x0, edgeY);
    ctx.lineTo(x1, edgeY);
    ctx.lineTo((x0 + x1) / 2, edgeY + TOOTH_H * dir);
    ctx.closePath();
    ctx.fill();
  }
}

function receiptFileName(t) {
  const d = new Date(t.startedAt);
  return `짭택시영수증_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}.png`;
}
