/* 택시 미터기 — 서울 중형택시 요금 체계 기반 */

const DEFAULTS = {
  base: 4800,        // 기본요금 (원)
  baseDist: 1600,    // 기본거리 (m)
  unitDist: 131,     // 거리요금 단위 (m)
  unitTime: 30,      // 시간요금 단위 (초)
  unitFare: 100,     // 단위당 요금 (원)
  slowSpeed: 15.33,  // 이 속도 미만이면 시간요금 적용 (km/h)
  night: true,       // 심야할증
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
  units: 0,         // 기본거리 초과 후 누적 단위 (소수)
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
  go: $('go'), passenger: $('passenger'), passengerWrap: $('passengerWrap'), owed: $('owed'),
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
// 심야할증: 22~23시 20%, 23~02시 40%, 02~04시 20%
function surchargePct(d = new Date()) {
  if (!rates.night) return 0;
  const h = d.getHours();
  if (h === 22) return 20;
  if (h === 23 || h < 2) return 40;
  if (h < 4) return 20;
  return 0;
}
function meteredFare() {
  return rates.base + Math.floor(S.units) * rates.unitFare;
}
function totalFare(pct = surchargePct()) {
  return Math.round(meteredFare() * (1 + pct / 100) / 100) * 100;
}

/* ---------- 거리 ---------- */
function haversine(a, b) {
  const R = 6371000, toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// 거리 누적 + 기본거리 초과분에 대해 거리요금 단위 적립
function addDistance(dd, speedKmh) {
  if (!(dd > 0)) return;
  const before = S.dist;
  S.dist += dd;
  if (S.dist <= rates.baseDist) return;
  const chargeable = Math.min(dd, S.dist - rates.baseDist);
  if (speedKmh >= rates.slowSpeed) S.units += chargeable / rates.unitDist;
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
      S.units += dt / rates.unitTime;
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
  S.dist = 0; S.units = 0; S.speed = 0; S.lastFix = null; S.lastFixAt = Date.now();
  lastTick = 0;

  el.go.textContent = '운행 종료';
  el.go.classList.add('stop');
  el.lamp.classList.add('running');
  el.lampText.textContent = '주행중';
  el.passengerWrap.hidden = true;

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
  el.passengerWrap.hidden = false;

  const pct = surchargePct(new Date(S.endedAt));
  const trip = {
    name: (el.passenger.value || '').trim() || '이름 없는 손님',
    startedAt: S.startedAt,
    endedAt: S.endedAt,
    sec: Math.round((S.endedAt - S.startedAt) / 1000),
    dist: S.dist,
    metered: meteredFare(),
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
    ['손님', t.name],
    ['승차', d(t.startedAt)],
    ['하차', d(t.endedAt)],
    ['주행거리', (t.dist / 1000).toFixed(2) + ' km'],
    ['주행시간', fmtTime(t.sec)],
    ['미터요금', won(t.metered) + '원'],
  ];
  if (t.surcharge) rows.push(['심야할증', `+${t.surcharge}%`]);
  return rows;
}
function showReceipt(t) {
  $('rRows').innerHTML = tripRows(t)
    .map(([k, v], i) => `<div class="r-row${i === 0 ? ' strong' : ''}"><span>${esc(k)}</span><span>${esc(v)}</span></div>`)
    .join('');
  $('rTotal').textContent = won(t.fare) + '원';
  $('rCompany').textContent = new Date(t.startedAt).toLocaleDateString('ko-KR') + ' · 개인택시 서울 12가 3456';
  $('receiptOverlay').hidden = false;
  $('rShare').onclick = () => shareTrip(t);
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
async function shareTrip(t) {
  const text = receiptText(t);
  try {
    if (navigator.share) { await navigator.share({ title: '택시 영수증', text }); return; }
    await navigator.clipboard.writeText(text);
    flash($('rShare'), '복사됨!');
  } catch { /* 사용자가 취소 */ }
}
function flash(btn, msg) {
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = old; }, 1400);
}

/* ---------- 기록 ---------- */
function renderHistory() {
  const list = $('historyList');
  if (!trips.length) { list.innerHTML = '<div class="empty">아직 태워준 사람이 없습니다</div>'; return; }
  list.innerHTML = trips.map((t, i) => `
    <div class="trip" data-i="${i}">
      <div class="trip-l">
        <div class="trip-name">${esc(t.name)}</div>
        <div class="trip-meta">${new Date(t.startedAt).toLocaleDateString('ko-KR')} · ${(t.dist / 1000).toFixed(2)}km · ${fmtTime(t.sec)}</div>
      </div>
      <div class="trip-fare">${won(t.fare)}원</div>
    </div>`).join('');
  list.querySelectorAll('.trip').forEach((n) => {
    n.onclick = () => { $('historyOverlay').hidden = true; showReceipt(trips[+n.dataset.i]); };
  });
}

/* ---------- 설정 ---------- */
const FIELDS = ['base', 'baseDist', 'unitDist', 'unitTime', 'unitFare', 'slowSpeed'];
function fillSettings() {
  FIELDS.forEach((k) => { $('s_' + k).value = rates[k]; });
  $('s_night').checked = !!rates.night;
  $('s_sim').checked = !!rates.sim;
}
function readSettings() {
  FIELDS.forEach((k) => {
    const v = parseFloat($('s_' + k).value);
    if (Number.isFinite(v) && v >= 0) rates[k] = v;
  });
  if (!(rates.unitDist > 0)) rates.unitDist = DEFAULTS.unitDist;
  if (!(rates.unitTime > 0)) rates.unitTime = DEFAULTS.unitTime;
  rates.night = $('s_night').checked;
  rates.sim = $('s_sim').checked;
  saveRates();
  render();
}

/* ---------- 이벤트 ---------- */
el.go.onclick = () => (S.running ? stop() : start());

$('openSettings').onclick = () => { fillSettings(); $('settingsOverlay').hidden = false; };
$('s_close').onclick = () => { readSettings(); $('settingsOverlay').hidden = true; };
$('s_reset').onclick = () => { rates = { ...DEFAULTS }; saveRates(); fillSettings(); render(); };

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
