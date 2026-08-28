/* 택시 미터기 — 서울 중형택시 요금 체계 기반 */

/* 지역별 요금 체계와 시 경계.
   심야할증 구간은 [시작시, 끝시, 할증률]. 끝시가 시작시보다 작으면 자정을 넘긴 구간.
   경계 폴리곤은 [위도, 경도] 근사치로, 경계 부근 1~2km 오차가 있음. */
const REGIONS = {
  seongnam: {
    label: '성남 · 분당',
    plate: '경기 34바 5678',
    fare: { base: 4800, baseDist: 2000, unitDist: 132, unitTime: 31, unitFare: 100, slowSpeed: 15.33, outPct: 20 },
    night: [[0, 4, 20]],
    bounds: [
      [37.500, 127.100], [37.495, 127.135], [37.485, 127.160], [37.470, 127.185],
      [37.450, 127.200], [37.430, 127.210], [37.405, 127.200], [37.385, 127.185],
      [37.360, 127.165], [37.340, 127.140], [37.325, 127.115], [37.330, 127.090],
      [37.345, 127.075], [37.365, 127.065], [37.390, 127.055], [37.415, 127.050],
      [37.440, 127.055], [37.460, 127.065], [37.480, 127.080], [37.492, 127.090],
    ],
  },
  seoul: {
    label: '서울',
    plate: '서울 12가 3456',
    fare: { base: 4800, baseDist: 1600, unitDist: 131, unitTime: 30, unitFare: 100, slowSpeed: 15.33, outPct: 20 },
    night: [[22, 23, 20], [23, 2, 40], [2, 4, 20]],
    bounds: [
      [37.701, 127.045], [37.690, 127.090], [37.660, 127.110], [37.640, 127.140],
      [37.600, 127.180], [37.560, 127.184], [37.530, 127.180], [37.510, 127.150],
      [37.470, 127.130], [37.450, 127.110], [37.440, 127.060], [37.428, 127.030],
      [37.440, 126.990], [37.450, 126.940], [37.460, 126.900], [37.470, 126.860],
      [37.490, 126.820], [37.520, 126.780], [37.560, 126.764], [37.590, 126.790],
      [37.600, 126.830], [37.610, 126.870], [37.640, 126.900], [37.660, 126.930],
      [37.680, 126.980], [37.695, 127.010],
    ],
  },
};
const DEFAULT_REGION = 'seongnam';

const DEFAULTS = {
  region: DEFAULT_REGION,
  ...REGIONS[DEFAULT_REGION].fare,
  night: true,       // 심야할증 적용 여부
  autoOut: false,    // 시계외 자동 판정 (시 경계 기준)
  sim: false,        // 시뮬레이션 모드
};

const LS_RATES = 'taxi.rates';
const LS_TRIPS = 'taxi.trips';

let rates = loadRates();
let trips = loadTrips();

const S = {
  running: false,
  startedAt: 0,
  endedAt: 0,
  dist: 0,          // 총 주행거리 (m)
  distOut: 0,       // 시계외 주행거리 (m)
  unitsIn: 0,       // 시내 구간 누적 단위 (소수)
  unitsOut: 0,      // 시계외 구간 누적 단위 (소수)
  outside: false,   // 현재 시계외 여부
  manualOut: false, // 사용자가 직접 조작 → 자동 판정 중단
  speed: 0,         // 현재 속도 (km/h)
  lastFix: null,    // {lat, lon, t}
  lastFixAt: 0,     // GPS 마지막 수신 시각
  watchId: null,
  timer: null,
  simTimer: null,
  simSpeed: 0,
  simTarget: 30,
  wakeLock: null,
};

/* ---------- 요소 ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  lamp: $('lamp'), lampText: $('lampText'),
  gpsBadge: $('gpsBadge'), scBadge: $('surchargeBadge'), scVal: $('surchargeVal'),
  fare: $('fare'), dist: $('dist'), time: $('time'), speed: $('speed'), hint: $('hint'),
  outBtn: $('outBtn'), outNote: $('outNote'),
  go: $('go'), owed: $('owed'),
};

/* ---------- 저장소 ---------- */
function loadRates() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_RATES) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveRates() { localStorage.setItem(LS_RATES, JSON.stringify(rates)); }
function loadTrips() {
  try { return JSON.parse(localStorage.getItem(LS_TRIPS) || '[]'); }
  catch { return []; }
}
function saveTrips() { localStorage.setItem(LS_TRIPS, JSON.stringify(trips.slice(0, 50))); }

/* ---------- 요금 계산 ---------- */
function region() { return REGIONS[rates.region] || REGIONS[DEFAULT_REGION]; }

// 심야할증: 지역별 시간대 테이블에서 조회
function surchargePct(d = new Date()) {
  if (!rates.night) return 0;
  const h = d.getHours();
  for (const [from, to, pct] of region().night) {
    const hit = from < to ? (h >= from && h < to) : (h >= from || h < to);
    if (hit) return pct;
  }
  return 0;
}
// 미터요금: 기본요금 + 누적 단위 × 단위요금 (시내·시계외 합산)
function meteredFare() {
  return rates.base + Math.floor(S.unitsIn + S.unitsOut) * rates.unitFare;
}
// 시계외 할증: 시계외 구간에서 오른 요금에만 적용
function outFare() {
  return Math.floor(S.unitsOut) * rates.unitFare * (rates.outPct / 100);
}
// 최종 요금: (미터요금 + 시계외할증)에 심야할증을 곱하고 100원 단위 반올림
function totalFare(pct = surchargePct()) {
  return Math.round((meteredFare() + outFare()) * (1 + pct / 100) / 100) * 100;
}

/* ---------- 거리 ---------- */
function haversine(a, b) {
  const R = 6371000, toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// 현재 구간(시내/시계외)에 단위 적립
function addUnits(u) {
  if (S.outside) S.unitsOut += u; else S.unitsIn += u;
}

// 거리 누적 + 기본거리 초과분에 대해 거리요금 단위 적립
function addDistance(dd, speedKmh) {
  if (!(dd > 0)) return;
  S.dist += dd;
  if (S.outside) S.distOut += dd;
  if (S.dist <= rates.baseDist) return;
  const chargeable = Math.min(dd, S.dist - rates.baseDist);
  if (speedKmh >= rates.slowSpeed) addUnits(chargeable / rates.unitDist);
}

/* ---------- 시계외 판정 ---------- */
// 현재 지역의 시 경계 안에 있는지 (ray casting)
function inRegion(p, poly = region().bounds) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > p.lat) !== (yj > p.lat) &&
        p.lon < (xj - xi) * (p.lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function setOutside(v) {
  if (S.outside === v) return;
  S.outside = v;
  render();
}
function toggleOutside() {
  S.manualOut = true;          // 손으로 만졌으면 이번 운행은 자동 판정 중단
  setOutside(!S.outside);
  render();
}

/* ---------- GPS ---------- */
function startGPS() {
  if (!navigator.geolocation) { gpsBadge('위치 미지원', 'err'); return; }
  gpsBadge('GPS 탐색중');
  S.watchId = navigator.geolocation.watchPosition(onFix, onGpsErr, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 20000,
  });
}
function stopGPS() {
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = null;
}
function onFix(pos) {
  const c = pos.coords, now = pos.timestamp || Date.now();
  gpsBadge(`GPS ±${Math.round(c.accuracy)}m`, c.accuracy <= 30 ? 'ok' : '');
  if (c.accuracy > 60) return;                 // 정확도 낮은 신호는 버림

  const fix = { lat: c.latitude, lon: c.longitude, t: now };

  // 시계외 자동 판정 (수동 조작 전까지만)
  if (rates.autoOut && !S.manualOut) setOutside(!inRegion(fix));

  if (S.lastFix) {
    const dt = (now - S.lastFix.t) / 1000;
    if (dt > 0.3) {
      const dd = haversine(S.lastFix, fix);
      const derived = (dd / dt) * 3.6;
      if (derived > 200) { S.lastFix = fix; S.lastFixAt = Date.now(); return; } // GPS 튐
      const spd = (c.speed != null && c.speed >= 0) ? c.speed * 3.6 : derived;
      S.speed = spd;
      if (S.running) addDistance(dd, spd);
      S.lastFix = fix;
    }
  } else {
    S.lastFix = fix;
  }
  S.lastFixAt = Date.now();
}
function onGpsErr(e) {
  const msg = e.code === 1 ? '위치 권한 거부' : e.code === 3 ? 'GPS 시간초과' : 'GPS 오류';
  gpsBadge(msg, 'err');
}
function gpsBadge(text, cls = '') {
  el.gpsBadge.textContent = text;
  el.gpsBadge.className = 'badge gps ' + cls;
}

/* ---------- 시뮬레이션 ---------- */
function startSim() {
  gpsBadge('시뮬레이션', 'ok');
  let hold = 0;
  S.simTimer = setInterval(() => {
    if (--hold <= 0) {                                  // 주기적으로 목표 속도 변경
      S.simTarget = Math.random() < 0.28 ? 0 : 18 + Math.random() * 45;
      hold = 6 + Math.floor(Math.random() * 18);
    }
    S.simSpeed += (S.simTarget - S.simSpeed) * 0.18;    // 부드러운 가감속
    if (S.simSpeed < 0.6) S.simSpeed = 0;
    S.speed = S.simSpeed;
    S.lastFixAt = Date.now();
    if (S.running) addDistance(S.simSpeed / 3.6 * 0.5, S.simSpeed); // 0.5초분
  }, 500);
}
function stopSim() { clearInterval(S.simTimer); S.simTimer = null; S.simSpeed = 0; }

/* ---------- 틱 (시간요금 + 화면 갱신) ---------- */
let lastTick = 0;
function tick() {
  const now = Date.now();
  const dt = lastTick ? (now - lastTick) / 1000 : 0;
  lastTick = now;

  if (S.running) {
    // GPS가 5초 이상 조용하면 정차로 간주
    if (!rates.sim && now - S.lastFixAt > 5000) S.speed = 0;
    // 기본거리 소진 후, 저속/정차 중이면 시간요금 적립
    if (S.dist > rates.baseDist && S.speed < rates.slowSpeed && dt > 0) {
      addUnits(dt / rates.unitTime);
    }
  }
  render();
}

/* ---------- 렌더 ---------- */
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
const won = (n) => n.toLocaleString('ko-KR');

function elapsed() {
  if (!S.startedAt) return 0;
  return ((S.running ? Date.now() : S.endedAt) - S.startedAt) / 1000;
}

function render() {
  el.fare.textContent = won(S.startedAt ? totalFare() : 0);
  el.dist.textContent = (S.dist / 1000).toFixed(2);
  el.time.textContent = fmtTime(elapsed());
  el.speed.textContent = Math.round(S.speed);

  const pct = surchargePct();
  el.scBadge.hidden = pct === 0;
  el.scVal.textContent = pct + '%';

  el.outBtn.classList.toggle('on', S.outside);
  el.outBtn.textContent = S.outside ? `시계외 할증 +${rates.outPct}%` : '시계외 할증';
  el.outNote.textContent = S.outside
    ? `시계외 ${(S.distOut / 1000).toFixed(2)}km 주행중`
    : (rates.autoOut && !S.manualOut ? `${region().label.split(' · ')[0]}시 경계 자동 판정중` : '');

  if (!S.running) {
    el.hint.textContent = S.startedAt ? '운행 종료' : `기본요금 ${won(rates.base)}원 · 기본거리 ${(rates.baseDist / 1000).toFixed(1)}km`;
  } else if (S.dist <= rates.baseDist) {
    const left = (rates.baseDist - S.dist) / 1000;
    el.hint.textContent = `기본요금 구간 · ${left.toFixed(2)}km 남음`;
  } else if (S.speed < rates.slowSpeed) {
    el.hint.textContent = `⏱ 시간요금 적용중 (${rates.unitTime}초당 ${won(rates.unitFare)}원)`;
  } else {
    el.hint.textContent = `📍 거리요금 적용중 (${rates.unitDist}m당 ${won(rates.unitFare)}원)`;
  }

  const owed = trips.reduce((a, t) => a + t.fare, 0);
  el.owed.textContent = trips.length ? `누적 미수금 ${won(owed)}원` : '';
}

/* ---------- 운행 ---------- */
async function start() {
  S.running = true;
  S.startedAt = Date.now();
  S.endedAt = 0;
  S.dist = 0; S.distOut = 0; S.unitsIn = 0; S.unitsOut = 0;
  S.outside = false; S.manualOut = false;
  S.speed = 0; S.lastFix = null; S.lastFixAt = Date.now();
  lastTick = 0;

  el.go.textContent = '운행 종료';
  el.go.classList.add('stop');
  el.lamp.classList.add('running');
  el.lampText.textContent = '주행중';

  if (rates.sim) startSim(); else startGPS();
  S.timer = setInterval(tick, 250);
  await requestWakeLock();
  render();
}

function stop() {
  S.running = false;
  S.endedAt = Date.now();
  clearInterval(S.timer); S.timer = null;
  stopGPS(); stopSim();
  releaseWakeLock();

  el.go.textContent = '운행 시작';
  el.go.classList.remove('stop');
  el.lamp.classList.remove('running');
  el.lampText.textContent = '빈차';

  const pct = surchargePct(new Date(S.endedAt));
  const trip = {
    startedAt: S.startedAt,
    endedAt: S.endedAt,
    sec: Math.round((S.endedAt - S.startedAt) / 1000),
    dist: S.dist,
    distOut: S.distOut,
    metered: meteredFare(),
    outFare: Math.round(outFare()),
    outPct: rates.outPct,
    plate: region().plate,
    surcharge: pct,
    fare: totalFare(pct),
  };
  trips.unshift(trip);
  saveTrips();
  showReceipt(trip);
  render();
}

/* ---------- 화면 꺼짐 방지 ---------- */
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen'); }
  catch { /* 지원 안 하면 무시 */ }
}
function releaseWakeLock() {
  try { S.wakeLock?.release(); } catch {}
  S.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.running && !S.wakeLock) requestWakeLock();
});

/* ---------- 영수증 ---------- */
function tripRows(t) {
  const d = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const rows = [
    ['승차', d(t.startedAt)],
    ['하차', d(t.endedAt)],
    ['주행거리', (t.dist / 1000).toFixed(2) + ' km'],
    ['주행시간', fmtTime(t.sec)],
    ['미터요금', won(t.metered) + '원'],
  ];
  if (t.outFare) {
    rows.push([`시계외 할증 (${(t.distOut / 1000).toFixed(2)}km)`, `+${won(t.outFare)}원`]);
  }
  if (t.surcharge) rows.push(['심야할증', `+${t.surcharge}%`]);
  return rows;
}
function receiptSubtitle(t) {
  return new Date(t.startedAt).toLocaleDateString('ko-KR') + ' · 개인택시 ' + (t.plate || region().plate);
}
function showReceipt(t) {
  $('rRows').innerHTML = tripRows(t)
    .map(([k, v]) => `<div class="r-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`)
    .join('');
  $('rTotal').textContent = won(t.fare) + '원';
  $('rCompany').textContent = receiptSubtitle(t);
  $('receiptOverlay').hidden = false;
  $('rShare').onclick = () => shareTripImage(t);
  $('rText').onclick = () => copyTripText(t);
  prepareImage(t);
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function receiptText(t) {
  const lines = [
    '🚕 택시 영수증',
    '─────────────',
    ...tripRows(t).map(([k, v]) => `${k}: ${v}`),
    '─────────────',
    `합계: ${won(t.fare)}원`,
    '',
    '※ 현금·카드 결제 불가, 밥으로만 결제 가능합니다 🍚',
  ];
  return lines.join('\n');
}
async function copyTripText(t) {
  const text = receiptText(t);
  try {
    await navigator.clipboard.writeText(text);
    flash($('rText'), '복사됨!');
  } catch {
    if (navigator.share) { try { await navigator.share({ title: '택시 영수증', text }); } catch {} }
  }
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
  ctx.fillText('※ 현금·카드 결제 불가', mid, y + 14);
  ctx.fillText('밥으로만 결제 가능합니다 🍚', mid, y + 40);

  return cv;
}

function receiptFileName(t) {
  const d = new Date(t.startedAt), p = (n) => String(n).padStart(2, '0');
  return `택시영수증_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.png`;
}

// 공유는 사용자 제스처 안에서 즉시 호출돼야 하므로, 영수증을 열 때 미리 만들어 둔다
let pendingImage = null;
function prepareImage(t) {
  pendingImage = { trip: t, promise: null };
  const ref = pendingImage;
  ref.promise = new Promise((resolve) => {
    try { drawReceipt(t).toBlob(resolve, 'image/png'); }
    catch { resolve(null); }
  });
}

async function shareTripImage(t) {
  const btn = $('rShare');
  let blob = null;
  try {
    blob = pendingImage && pendingImage.trip === t
      ? await pendingImage.promise
      : await new Promise((r) => drawReceipt(t).toBlob(r, 'image/png'));
  } catch { /* 아래에서 처리 */ }
  if (!blob) { flash(btn, '이미지 생성 실패'); return; }

  const file = new File([blob], receiptFileName(t), { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }   // 사용자가 취소
  }
  // 공유를 못 쓰면 내려받기로
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash(btn, '이미지 저장됨');
}
function flash(btn, msg) {
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = old; }, 1400);
}

/* ---------- 기록 ---------- */
function tripTitle(t) {
  const d = new Date(t.startedAt);
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }) + ' ' +
         d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}
function renderHistory() {
  const list = $('historyList');
  if (!trips.length) { list.innerHTML = '<div class="empty">아직 태워준 사람이 없습니다</div>'; return; }
  list.innerHTML = trips.map((t, i) => `
    <div class="trip">
      <div class="trip-l" data-open="${i}">
        <div class="trip-name">${esc(tripTitle(t))}${t.outFare ? ' <span class="tag">시계외</span>' : ''}</div>
        <div class="trip-meta">${(t.dist / 1000).toFixed(2)}km · ${fmtTime(t.sec)}</div>
      </div>
      <div class="trip-fare">${won(t.fare)}원</div>
      <button class="trip-del" data-del="${i}" aria-label="이 운행 기록 삭제">&times;</button>
    </div>`).join('');
  list.querySelectorAll('[data-open]').forEach((n) => {
    n.onclick = () => { $('historyOverlay').hidden = true; showReceipt(trips[+n.dataset.open]); };
  });
  list.querySelectorAll('[data-del]').forEach((n) => {
    n.onclick = () => deleteTrip(+n.dataset.del);
  });
}
function deleteTrip(i) {
  trips.splice(i, 1);
  saveTrips();
  renderHistory();
  render();
}

/* ---------- 설정 ---------- */
const FIELDS = ['base', 'baseDist', 'unitDist', 'unitTime', 'unitFare', 'slowSpeed', 'outPct'];
function fillSettings() {
  FIELDS.forEach((k) => { $('s_' + k).value = rates[k]; });
  $('s_night').checked = !!rates.night;
  $('s_autoOut').checked = !!rates.autoOut;
  $('s_sim').checked = !!rates.sim;
  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.region === rates.region);
  });
  $('s_nightDesc').textContent = '심야할증 자동 적용 (' + region().night
    .map(([f, t, p]) => `${f}~${t}시 ${p}%`).join(', ') + ')';
  $('s_autoOutDesc').textContent = `시계외 자동 판정 (${region().label.split(' · ')[0]}시 경계 · 대략)`;
}

// 지역을 고르면 해당 지역 요금표를 채워 넣는다 (숫자는 이후 직접 수정 가능)
function pickRegion(key) {
  if (!REGIONS[key]) return;
  rates = { ...rates, region: key, ...REGIONS[key].fare };
  saveRates();
  fillSettings();
  render();
}
function readSettings() {
  FIELDS.forEach((k) => {
    const v = parseFloat($('s_' + k).value);
    if (Number.isFinite(v) && v >= 0) rates[k] = v;
  });
  if (!(rates.unitDist > 0)) rates.unitDist = DEFAULTS.unitDist;
  if (!(rates.unitTime > 0)) rates.unitTime = DEFAULTS.unitTime;
  rates.night = $('s_night').checked;
  rates.autoOut = $('s_autoOut').checked;
  rates.sim = $('s_sim').checked;
  saveRates();
  render();
}

/* ---------- 이벤트 ---------- */
el.go.onclick = () => (S.running ? stop() : start());
el.outBtn.onclick = toggleOutside;

$('openSettings').onclick = () => { fillSettings(); $('settingsOverlay').hidden = false; };
$('s_close').onclick = () => { readSettings(); $('settingsOverlay').hidden = true; };
$('s_reset').onclick = () => { rates = { ...DEFAULTS }; saveRates(); fillSettings(); render(); };
document.querySelectorAll('.seg-btn').forEach((b) => {
  b.onclick = () => pickRegion(b.dataset.region);
});

$('openHistory').onclick = () => { renderHistory(); $('historyOverlay').hidden = false; };
$('h_close').onclick = () => { $('historyOverlay').hidden = true; };
$('h_clear').onclick = () => {
  if (!trips.length) return;
  if (confirm('운행 기록을 전부 지울까요? 누적 미수금도 사라집니다.')) {
    trips = []; saveTrips(); renderHistory(); render();
  }
};

$('rClose').onclick = () => { $('receiptOverlay').hidden = true; };

// 오버레이 배경 클릭으로 닫기
document.querySelectorAll('.overlay').forEach((o) => {
  o.addEventListener('click', (e) => {
    if (e.target !== o) return;
    if (o.id === 'settingsOverlay') readSettings();
    o.hidden = true;
  });
});

window.addEventListener('beforeunload', (e) => {
  if (S.running) { e.preventDefault(); e.returnValue = ''; }
});

render();
setInterval(() => { if (!S.running) render(); }, 1000); // 대기중 심야할증 배지 갱신
