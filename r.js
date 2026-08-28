/* 공유 링크로 열리는 공개 영수증 페이지 */

const $ = (id) => document.getElementById(id);

function receiptId() {
  // /r/<id> 형태와 /r.html?id=<id> 형태를 모두 받는다
  const m = location.pathname.match(/\/r\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : new URLSearchParams(location.search).get('id');
}

function show(t) {
  $('rRows').innerHTML = tripRows(t)
    .map(([k, v]) => `<div class="r-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`)
    .join('');
  $('rTotal').textContent = won(t.fare) + '원';
  $('rCompany').textContent = receiptSubtitle(t);
  $('msg').hidden = true;
  $('card').hidden = false;
  document.title = `택시 영수증 · ${won(t.fare)}원`;

  $('rSave').onclick = async () => {
    const blob = await new Promise((r) => drawReceipt(t).toBlob(r, 'image/png'));
    if (!blob) return;
    const file = new File([blob], receiptFileName(t), { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}

function fail(text) {
  $('msg').textContent = text;
  $('msg').hidden = false;
}

window.addEventListener('cloud-ready', async (e) => {
  const id = receiptId();
  if (!id) { fail('영수증 주소가 올바르지 않습니다.'); return; }
  if (!e.detail.available) { fail('영수증을 불러오지 못했습니다. 잠시 후 다시 열어 주세요.'); return; }
  try {
    const trip = await window.cloud.getReceipt(id);
    if (!trip) { fail('없거나 삭제된 영수증입니다.'); return; }
    show(trip);
  } catch {
    fail('영수증을 불러오지 못했습니다.');
  }
});
