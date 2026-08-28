/* 택시 미터기 — 서울 중형택시 요금 체계 기반 */

/* 지역별 요금 체계와 시 경계.
   심야할증 구간은 [시작시, 끝시, 할증률]. 끝시가 시작시보다 작으면 자정을 넘긴 구간.
   경계 폴리곤은 [위도, 경도] 근사치로, 경계 부근 1~2km 오차가 있음. */
const REGIONS = {
  seongnam: {
    label: '성남 · 분당',
    plate: '08어 9766',
    fare: { base: 4800, baseDist: 2000, unitDist: 132, unitTime: 31, unitFare: 100, outPct: 20 },
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
    plate: '08어 9766',
    fare: { base: 4800, baseDist: 1600, unitDist: 131, unitTime: 30, unitFare: 100, outPct: 20 },
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
  dist: 0,          // 실제 주행거리 (m) — 표시·영수증용
  distOut: 0,       // 시계외 실제 주행거리 (m)
  eff: 0,           // 효과거리 (m) — 실제 거리 + 저속/정차 시간의 거리 환산분
  effCharged: 0,    // 기본거리를 넘어선 효과거리 (요금이 붙는 구간)
  effOut: 0,        // 그중 시계외에서 쌓인 몫
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

/* ---------- 클라우드 ---------- */
let cloudOn = false;

function refreshLists() {
  if (!$('historyOverlay').hidden) renderHistory();
  if (!$('ledgerOverlay').hidden) renderLedger();
  render();
}

window.addEventListener('cloud-ready', (e) => {
  const c = e.detail;
  renderCloudStatus();
  if (!c.available) return;
  cloudOn = true;
  c.onTrips((list) => { trips = list.filter((t) => !deleting.has(t.id)); refreshLists(); });
  migrateLocalTrips();
});
window.addEventListener('cloud-auth', renderCloudStatus);

// 브라우저에만 있던 기존 기록을 한 번만 클라우드로 올린다
async function migrateLocalTrips() {
  if (localStorage.getItem('taxi.migrated')) return;
  const local = loadTrips();
  localStorage.setItem('taxi.migrated', '1');
  for (const t of local) {
    try { await window.cloud.addTrip(t); } catch { /* 실패해도 로컬본은 남아 있다 */ }
  }
}

function renderCloudStatus() {
  const box = $('s_cloud');
  if (!box) return;
  const c = window.cloud;
  if (!c || !c.available) {
    box.innerHTML = '<b class="off">클라우드 미연결</b><span>이 브라우저에만 기록이 저장됩니다</span>';
    return;
  }
  const u = c.user;
  if (u && !u.isAnonymous) {
    box.innerHTML = `<b class="on">${esc(u.email || '구글 계정')} 연결됨</b><span>다른 기기에서도 같은 기록이 보입니다</span>`;
  } else {
    box.innerHTML = '<b>이 기기에만 연결됨</b><span>구글 계정을 연결하면 폰·PC에서 같은 기록을 씁니다</span>';
  }
  $('s_link').hidden = !!(u && !u.isAnonymous);
  $('s_unlink').hidden = !(u && !u.isAnonymous);
}

async function linkGoogle() {
  const btn = $('s_link');
  try {
    const { merged, pending, moved } = await window.cloud.linkGoogle();
    if (pending) return;                       // 리다이렉트로 넘어감
    // 상태 상자를 직접 다시 그린다. 버튼 글자만 잠깐 바꾸면
    // 1.4초 뒤 원래대로 돌아와 연결이 안 된 것처럼 보인다.
    renderCloudStatus();
    if (!merged && moved) {
      $('s_cloud').insertAdjacentHTML('beforeend',
        `<span class="moved">이 기기에 있던 운행 ${moved}건을 옮겨 왔습니다</span>`);
    }
  } catch (e) {
    if (e.code === 'auth/popup-closed-by-user') return;
    // 무엇 때문에 막혔는지 화면에 그대로 보여 준다
    const code = (e.code || e.message || '').replace('auth/', '');
    $('s_cloud').innerHTML =
      `<b class="off">연결 실패</b><span>${esc(code)}</span>` +
      (code === 'unauthorized-domain'
        ? `<span>Firebase 콘솔 → Authentication → Settings → 승인된 도메인에 <b>${esc(location.hostname)}</b> 를 추가하세요</span>`
        : '');
    console.warn('[cloud] 구글 연결 실패:', e.code || e.message);
  }
}

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
// 시간요금이 붙기 시작하는 속도. 단위요금이 같은 이상 거리 단가와 시간 단가는
// 같은 지점에서 만나므로, 별도 설정값이 아니라 두 단위에서 유도된다.
// 예: 132m / 31초 = 4.26m/s = 15.33km/h
function mps() { return rates.unitDist / rates.unitTime; }
function slowSpeed() { return mps() * 3.6; }

// 미터요금: 기본요금 + 기본거리 초과 효과거리를 단위로 나눈 만큼
function meteredFare() {
  return rates.base + Math.floor(S.effCharged / rates.unitDist) * rates.unitFare;
}
// 시계외 할증: 시계외에서 쌓인 효과거리에 해당하는 요금에만 적용
function outFare() {
  return Math.floor(S.effOut / rates.unitDist) * rates.unitFare * (rates.outPct / 100);
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

/* 효과거리를 쌓는다. 기본거리를 넘어선 몫만 요금이 붙고,
   그 몫이 시계외에서 쌓였으면 할증 대상으로 따로 센다. */
function addEff(de) {
  if (!(de > 0)) return;
  const before = S.eff;
  S.eff += de;
  const chargeable = S.eff - Math.max(before, rates.baseDist);
  if (chargeable <= 0) return;
  S.effCharged += chargeable;
  if (S.outside) S.effOut += chargeable;
}

// 실제 주행거리. 기준속도 이상이면 거리가 그대로 효과거리가 된다.
function addDistance(dd, speedKmh) {
  if (!(dd > 0)) return;
  S.dist += dd;
  if (S.outside) S.distOut += dd;
  if (speedKmh >= slowSpeed()) addEff(dd);
}

// 기본거리에서 아직 남은 양 (실제 미터기가 1600부터 깎아 내려가는 그 숫자)
function baseLeft() { return Math.max(0, rates.baseDist - S.eff); }

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
    // 기준속도 미만이면 흐른 시간을 거리로 환산해 적립한다.
    // 기본거리 구간에서도 똑같이 깎이므로, 멈춰 있어도 미터는 진행된다.
    if (S.speed < slowSpeed() && dt > 0) addEff(dt * mps());
  }
  render();
}

/* ---------- 렌더 ---------- */

function elapsed() {
  if (!S.startedAt) return 0;
  return ((S.running ? Date.now() : S.endedAt) - S.startedAt) / 1000;
}

/* 미터기의 기본거리 창. 화면은 250ms마다 다시 그리지만 이 숫자는
   실제 미터기처럼 1초에 한 번만 갱신한다 (정차 중이면 한 번에 4씩 떨어진다). */
let hintShown = '';
let hintAt = 0;
function hintText() {
  if (!S.running || baseLeft() <= 0) { hintShown = ''; return ''; }
  const now = Date.now();
  if (!hintShown || now - hintAt >= 1000) {
    hintAt = now;
    hintShown = String(Math.ceil(baseLeft()));
  }
  return hintShown;
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
  el.outNote.textContent = S.outside ? `${(S.distOut / 1000).toFixed(2)}km` : '';

  el.hint.textContent = hintText();

  const owed = trips.reduce((a, t) => a + (t.settled ? 0 : t.fare), 0);
  el.owed.textContent = owed ? `누적 미수금 ${won(owed)}원` : '';
}

/* ---------- 운행 ---------- */
async function start() {
  S.running = true;
  S.startedAt = Date.now();
  S.endedAt = 0;
  S.dist = 0; S.distOut = 0; S.eff = 0; S.effCharged = 0; S.effOut = 0;
  S.outside = false; S.manualOut = false;
  S.speed = 0; S.lastFix = null; S.lastFixAt = Date.now();
  lastTick = 0; hintShown = ''; hintAt = 0;

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
  persistTrip(trip);
  showReceipt(trip);
  render();
}

// 클라우드가 붙어 있으면 그쪽에 쓰고 목록은 스냅샷이 갱신한다
function persistTrip(trip) {
  if (!cloudOn) { trips.unshift(trip); saveTrips(); refreshLists(); return; }
  window.cloud.addTrip(trip)
    .then((id) => { trip.id = id; })
    .catch(() => { trips.unshift(trip); saveTrips(); refreshLists(); });
}

function patchTrip(trip, patch) {
  Object.assign(trip, patch);
  if (cloudOn && trip.id) window.cloud.updateTrip(trip.id, patch).catch(() => {});
  else saveTrips();
  refreshLists();
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
function renderReceiptRows(t) {
  $('rRows').innerHTML = tripRows(t)
    .map(([k, v]) => `<div class="r-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`)
    .join('');
  $('rTotal').textContent = won(t.fare) + '원';
  $('rCompany').textContent = receiptSubtitle(t);
}

function showReceipt(t) {
  renderReceiptRows(t);
  renderGuestPicker(t);
  $('receiptOverlay').hidden = false;
  $('rShare').onclick = () => shareTripImage(t);
  $('rText').onclick = () => copyTripText(t);
  $('rLink').onclick = () => shareTripLink(t);
  $('rLink').hidden = !cloudOn;
  prepareImage(t);
}

/* ---------- 손님 지정 ---------- */
// 지금까지 쓴 이름을 최근 순으로 모은다
function knownGuests() {
  const seen = [];
  for (const t of trips) {
    if (t.passenger && !seen.includes(t.passenger)) seen.push(t.passenger);
  }
  return seen.slice(0, 8);
}

function renderGuestPicker(t) {
  const box = $('rGuests');
  const chips = knownGuests().map((n) =>
    `<button class="chip${n === t.passenger ? ' on' : ''}" data-guest="${esc(n)}">${esc(n)}</button>`);
  chips.push('<button class="chip add" data-guest-new>+ 이름</button>');
  box.innerHTML = chips.join('');

  box.querySelectorAll('[data-guest]').forEach((b) => {
    b.onclick = () => setGuest(t, b.dataset.guest === t.passenger ? null : b.dataset.guest);
  });
  box.querySelector('[data-guest-new]').onclick = () => {
    box.innerHTML = '<input class="guest-input" id="rGuestInput" maxlength="12" placeholder="이름 입력 후 Enter" autocomplete="off">';
    const inp = $('rGuestInput');
    inp.focus();
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') setGuest(t, inp.value.trim() || null);
      if (e.key === 'Escape') renderGuestPicker(t);
    };
    inp.onblur = () => { if (inp.value.trim()) setGuest(t, inp.value.trim()); else renderGuestPicker(t); };
  };
}

function setGuest(t, name) {
  patchTrip(t, { passenger: name });
  renderReceiptRows(t);
  renderGuestPicker(t);
  prepareImage(t);          // 이름이 영수증에 들어가므로 이미지를 다시 만든다
}

/* ---------- 공유 링크 ---------- */
async function shareTripLink(t) {
  const btn = $('rLink');
  try {
    if (!t.shareId) {
      t.shareId = await window.cloud.publishReceipt(t);
    }
    const url = `${location.origin}/r/${t.shareId}`;
    if (navigator.share) {
      try { await navigator.share({ title: '택시 영수증', url }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    await navigator.clipboard.writeText(url);
    flash(btn, '링크 복사됨!');
  } catch (e) {
    flash(btn, '발행 실패');
    console.warn('[cloud] 영수증 발행 실패:', e.code || e.message);
  }
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
/* 삭제 요청을 보낸 기록의 id. 서버 확인이 오기 전에 도착한 스냅샷에는
   아직 그 기록이 들어 있어 화면에 되살아나 보이므로, 여기 있는 동안은 걸러 낸다. */
const deleting = new Set();

function deleteTrip(i) {
  const t = trips[i];
  if (!t) return;

  // 화면에서 먼저 지운다. 서버 왕복을 기다리며 남아 있으면 안 지워진 것처럼 보인다.
  trips.splice(i, 1);

  if (cloudOn && t.id) {
    deleting.add(t.id);
    refreshLists();
    window.cloud.deleteTrip(t.id)
      .then(() => { deleting.delete(t.id); })
      .catch((e) => {
        // 정말 실패했으면 되살리고 이유를 알린다
        deleting.delete(t.id);
        trips.push(t);
        trips.sort((a, b) => b.startedAt - a.startedAt);
        refreshLists();
        alertOnce('삭제 실패: ' + (e.code || e.message));
      });
    return;
  }
  saveTrips();
  refreshLists();
}

// 같은 메시지를 반복해서 띄우지 않는다
let lastNotice = '';
function alertOnce(msg) {
  console.warn('[cloud]', msg);
  if (msg === lastNotice) return;
  lastNotice = msg;
  const box = $('s_cloud');
  if (box) box.innerHTML = `<b class="off">${esc(msg)}</b>`;
}

/* ---------- 미수금 장부 ---------- */
// 손님별로 묶어 미정산 금액이 큰 순으로 세운다
function ledgerData() {
  const map = new Map();
  for (const t of trips) {
    const key = t.passenger || '';
    if (!map.has(key)) map.set(key, { name: key, trips: [], owed: 0, paid: 0 });
    const e = map.get(key);
    e.trips.push(t);
    if (t.settled) e.paid += t.fare; else e.owed += t.fare;
  }
  return [...map.values()].sort((a, b) => b.owed - a.owed || b.paid - a.paid);
}

let openGuest = null;   // 펼쳐 놓은 손님

function renderLedger() {
  const list = $('ledgerList');
  const data = ledgerData();
  if (!data.length) { list.innerHTML = '<div class="empty">아직 태워준 사람이 없습니다</div>'; return; }

  list.innerHTML = data.map((g) => {
    const open = g.name === openGuest;
    const rows = !open ? '' : `<div class="ldg-trips">${g.trips.map((t) => `
      <div class="ldg-trip${t.settled ? ' done' : ''}">
        <button class="ldg-chk" data-toggle="${esc(t.id || String(t.startedAt))}">${t.settled ? '✓' : ''}</button>
        <span class="ldg-when">${esc(tripTitle(t))}</span>
        <span class="ldg-fare">${won(t.fare)}원</span>
      </div>`).join('')}</div>`;
    return `
      <div class="ldg${open ? ' open' : ''}">
        <button class="ldg-head" data-guest="${esc(g.name)}">
          <span class="ldg-name">${esc(g.name || '이름 없는 손님')}</span>
          <span class="ldg-sum">
            ${g.owed ? `<b>${won(g.owed)}원</b>` : '<i>정산 완료</i>'}
            <em>${g.trips.length}건</em>
          </span>
        </button>
        ${rows}
      </div>`;
  }).join('');

  list.querySelectorAll('[data-guest]').forEach((b) => {
    b.onclick = () => { openGuest = openGuest === b.dataset.guest ? null : b.dataset.guest; renderLedger(); };
  });
  list.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = () => {
      const t = trips.find((x) => (x.id || String(x.startedAt)) === b.dataset.toggle);
      if (t) patchTrip(t, { settled: !t.settled });
    };
  });

  const total = data.reduce((a, g) => a + g.owed, 0);
  $('ledgerTotal').textContent = total ? `받을 돈 ${won(total)}원` : '받을 돈 없음';
}

/* ---------- 설정 ---------- */
const FIELDS = ['base', 'baseDist', 'unitDist', 'unitTime', 'unitFare', 'outPct'];
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
  $('s_derived').textContent =
    `정차 시 ${mps().toFixed(2)}m/s 씩 소모 · 시간요금 전환 속도 ${slowSpeed().toFixed(2)}km/h ` +
    `(${rates.unitDist}m ÷ ${rates.unitTime}초에서 유도)`;
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
$('openLedger').onclick = () => { openGuest = null; renderLedger(); $('ledgerOverlay').hidden = false; };
$('l_close').onclick = () => { $('ledgerOverlay').hidden = true; };
$('s_link').onclick = linkGoogle;
$('s_unlink').onclick = async () => { await window.cloud.signOutCloud(); flash($('s_unlink'), '연결 해제됨'); };
$('h_close').onclick = () => { $('historyOverlay').hidden = true; };
// 한 번 더 눌러야 지워진다. 브라우저 확인창 대신 버튼 자체로 되묻는다.
let clearArmed = 0;
$('h_clear').onclick = async () => {
  const btn = $('h_clear');
  if (!trips.length) return;

  if (Date.now() - clearArmed > 4000) {
    clearArmed = Date.now();
    btn.textContent = '정말 지울까요?';
    setTimeout(() => {
      if (Date.now() - clearArmed >= 4000) btn.textContent = '전체 삭제';
    }, 4000);
    return;
  }
  clearArmed = 0;
  btn.textContent = '전체 삭제';

  const gone = trips;
  trips = [];
  refreshLists();

  if (!cloudOn) { saveTrips(); return; }

  // 서버까지 지우지 않으면 다음 운행을 추가하는 순간 스냅샷이 전부 되살린다
  gone.forEach((t) => { if (t.id) deleting.add(t.id); });
  try {
    await window.cloud.deleteAllTrips();
  } catch (e) {
    trips = gone;
    refreshLists();
    flash(btn, '삭제 실패');
    alertOnce('전체 삭제 실패: ' + (e.code || e.message));
  } finally {
    gone.forEach((t) => { if (t.id) deleting.delete(t.id); });
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
