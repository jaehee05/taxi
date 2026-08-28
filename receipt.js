/* 영수증 렌더링 공통 모듈 — 미터기(app.js)와 공유 링크 페이지(r.js)가 함께 쓴다 */

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
const won = (n) => n.toLocaleString('ko-KR');

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function tripRows(t) {
  const d = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const rows = [];
  if (t.passenger) rows.push(['손님', t.passenger]);
  rows.push(
    ['승차', d(t.startedAt)],
    ['하차', d(t.endedAt)],
    ['주행거리', (t.dist / 1000).toFixed(2) + ' km'],
    ['주행시간', fmtTime(t.sec)],
    ['미터요금', won(t.metered) + '원'],
  );
  if (t.outFare) {
    rows.push([`시계외 할증 (${(t.distOut / 1000).toFixed(2)}km)`, `+${won(t.outFare)}원`]);
  }
  if (t.surcharge) rows.push(['심야할증', `+${t.surcharge}%`]);
  return rows;
}
function receiptSubtitle(t) {
  return new Date(t.startedAt).toLocaleDateString('ko-KR') + ' · 짭택시 ' + (t.plate || '08어 9766');
}
function receiptText(t) {
  const lines = [
    '🚕 짭택시 영수증',
    '─────────────',
    ...tripRows(t).map(([k, v]) => `${k}: ${v}`),
    '─────────────',
    `합계: ${won(t.fare)}원`,
    '',
    '※ 현금·카드 결제 가능',
  ];
  return lines.join('\n');
}

/* ---------- 영수증 이미지 ---------- */
const KR = '"Apple SD Gothic Neo", -apple-system, system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, monospace';
const IMG_W = 640;   // 논리 폭 (실제 PNG는 2배)

function dashLine(ctx, y, w, pad) {
  ctx.save();
  ctx.strokeStyle = '#c9c2b0';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(pad, y);
  ctx.lineTo(w - pad, y);
  ctx.stroke();
  ctx.restore();
}

// 영수증을 캔버스에 직접 그린다 (외부 라이브러리 없이, 화면 디자인과 동일한 톤)
function drawReceipt(t) {
  const pad = 44, rows = tripRows(t);
  // 높이를 먼저 계산해서 캔버스를 잡는다
  const h = pad + 52 + 44 + 34 + 28 + rows.length * 34 + 4 + 26 + 46 + 30 + 52 + pad;
  const dpr = 2;
  const cv = document.createElement('canvas');
  cv.width = IMG_W * dpr;
  cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#f6f3ea';
  ctx.fillRect(0, 0, IMG_W, h);

  const mid = IMG_W / 2;
  let y = pad;

  ctx.textAlign = 'center';
  ctx.fillStyle = '#22201c';
  ctx.font = `36px ${KR}`;
  ctx.fillText('🚕', mid, y + 34);
  y += 52;

  ctx.font = `700 30px ${KR}`;
  ctx.fillText('택 시 영 수 증', mid, y + 26);
  y += 44;

  ctx.font = `14px ${MONO}`;
  ctx.fillStyle = '#7a7466';
  ctx.fillText(receiptSubtitle(t), mid, y + 14);
  y += 34;

  dashLine(ctx, y, IMG_W, pad);
  y += 28;

  ctx.font = `17px ${MONO}`;
  for (const [k, v] of rows) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7a7466';
    ctx.fillText(k, pad, y + 17);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#22201c';
    ctx.fillText(v, IMG_W - pad, y + 17);
    y += 34;
  }

  y += 4;
  dashLine(ctx, y, IMG_W, pad);
  y += 26;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#22201c';
  ctx.font = `700 20px ${KR}`;
  ctx.fillText('합 계', pad, y + 26);
  ctx.textAlign = 'right';
  ctx.font = `700 32px ${MONO}`;
  ctx.fillText(won(t.fare) + '원', IMG_W - pad, y + 28);
  y += 46;

  dashLine(ctx, y, IMG_W, pad);
  y += 30;

  ctx.textAlign = 'center';
  ctx.fillStyle = '#7a7466';
  ctx.font = `14px ${KR}`;
  ctx.fillText('※ 현금·카드 결제 가능', mid, y + 14);

  return cv;
}

function receiptFileName(t) {
  const d = new Date(t.startedAt), p = (n) => String(n).padStart(2, '0');
  return `택시영수증_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.png`;
}

