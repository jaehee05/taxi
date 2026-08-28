/* Firestore 연동. 클래식 스크립트인 app.js / r.js 가 쓸 수 있도록
   window.cloud 로 노출하고, 준비되면 'cloud-ready' 이벤트를 쏜다.
   Firebase 로딩에 실패해도 앱은 localStorage 로 계속 동작해야 하므로
   모든 실패는 조용히 흡수하고 available=false 로 떨어뜨린다. */

const V = 'https://www.gstatic.com/firebasejs/11.10.0';

const api = {
  available: false,
  user: null,
  error: null,
  onAuth: () => {},
};
window.cloud = api;

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

try {
  const [{ initializeApp }, authMod, fsMod] = await Promise.all([
    import(`${V}/firebase-app.js`),
    import(`${V}/firebase-auth.js`),
    import(`${V}/firebase-firestore.js`),
  ]);

  const {
    getAuth, onAuthStateChanged, signInAnonymously, signOut,
    GoogleAuthProvider, linkWithPopup, signInWithPopup, signInWithCredential,
    linkWithRedirect, signInWithRedirect, getRedirectResult,
  } = authMod;
  const {
    initializeFirestore, persistentLocalCache, persistentSingleTabManager,
    collection, doc, setDoc, addDoc, deleteDoc, updateDoc, getDoc,
    onSnapshot, query, orderBy, serverTimestamp,
  } = fsMod;

  const app = initializeApp(window.FIREBASE_CONFIG);
  const auth = getAuth(app);
  // 오프라인 캐시를 켜두면 지하 주차장이나 터널에서도 기록이 쌓이고,
  // 연결이 돌아오면 알아서 올라간다.
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }),
  });

  const tripsRef = (uid) => collection(db, 'users', uid, 'trips');

  // 규칙의 화이트리스트와 어긋나면 쓰기가 통째로 거부되므로 여기서 한 번 걸러 낸다
  const TRIP_KEYS = ['startedAt', 'endedAt', 'sec', 'dist', 'distOut', 'metered',
    'outFare', 'outPct', 'surcharge', 'fare', 'region', 'plate', 'passenger', 'settled'];
  function clean(t) {
    const out = {};
    for (const k of TRIP_KEYS) if (t[k] !== undefined) out[k] = t[k];
    return out;
  }

  Object.assign(api, {
    available: true,

    onTrips(cb) {
      let unsub = null;
      const attach = (user) => {
        if (unsub) { unsub(); unsub = null; }
        if (!user) { cb([]); return; }
        unsub = onSnapshot(
          query(tripsRef(user.uid), orderBy('startedAt', 'desc')),
          (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
          (e) => { api.error = e.message; cb([]); },
        );
      };
      attach(auth.currentUser);
      onAuthStateChanged(auth, attach);
    },

    // 아이디를 먼저 만들어 돌려주고 쓰기는 백그라운드로 보낸다.
    // 오프라인이면 setDoc 의 프라미스가 계속 대기하므로 await 하면 안 된다.
    async addTrip(t) {
      const u = auth.currentUser;
      if (!u) throw new Error('not signed in');
      const ref = doc(tripsRef(u.uid));
      setDoc(ref, { ...clean(t), createdAt: serverTimestamp() })
        .catch((e) => { api.error = e.message; console.warn('[cloud] 운행 저장 실패:', e.message); });
      return ref.id;
    },

    async updateTrip(id, patch) {
      const u = auth.currentUser;
      if (!u) throw new Error('not signed in');
      await updateDoc(doc(db, 'users', u.uid, 'trips', id), clean(patch));
    },

    async deleteTrip(id) {
      const u = auth.currentUser;
      if (!u) throw new Error('not signed in');
      await deleteDoc(doc(db, 'users', u.uid, 'trips', id));
    },

    // 영수증을 공개 문서로 발행하고 공유용 아이디를 돌려준다
    async publishReceipt(t) {
      const u = auth.currentUser;
      if (!u) throw new Error('not signed in');
      const ref = await addDoc(collection(db, 'receipts'), {
        ownerUid: u.uid,
        trip: clean(t),
        createdAt: serverTimestamp(),
      });
      return ref.id;
    },

    async getReceipt(id) {
      const snap = await getDoc(doc(db, 'receipts', id));
      return snap.exists() ? snap.data().trip : null;
    },

    // 익명 계정을 그대로 둔 채 구글 계정을 얹으면 uid 와 기록이 보존된다
    async linkGoogle() {
      const provider = new GoogleAuthProvider();
      const u = auth.currentUser;

      // 팝업을 못 띄우는 환경(모바일 사파리, 팝업 차단)에서는 리다이렉트로 넘어간다
      const viaRedirect = (e) => ['auth/popup-blocked',
        'auth/operation-not-supported-in-this-environment',
        'auth/cancelled-popup-request'].includes(e.code);

      // 그 구글 계정으로 이미 만든 계정이 있으면 그쪽으로 갈아탄다
      const takeOver = async (e) => {
        const cred = GoogleAuthProvider.credentialFromError(e);
        if (!cred) throw e;
        const res = await signInWithCredential(auth, cred);
        return { user: res.user, merged: false };
      };
      const existing = ['auth/credential-already-in-use',
        'auth/email-already-in-use',
        'auth/account-exists-with-different-credential'];

      if (u && u.isAnonymous) {
        try {
          const res = await linkWithPopup(u, provider);
          return { user: res.user, merged: true };
        } catch (e) {
          if (existing.includes(e.code)) return takeOver(e);
          if (viaRedirect(e)) { await linkWithRedirect(u, provider); return { pending: true }; }
          throw e;
        }
      }
      try {
        const res = await signInWithPopup(auth, provider);
        return { user: res.user, merged: false };
      } catch (e) {
        if (viaRedirect(e)) { await signInWithRedirect(auth, provider); return { pending: true }; }
        throw e;
      }
    },

    async signOutCloud() {
      await signOut(auth);
      await signInAnonymously(auth);   // 로그아웃해도 미터기는 계속 쓸 수 있게
    },
  });

  onAuthStateChanged(auth, (user) => {
    api.user = user;
    api.onAuth(user);
    emit('cloud-auth', user);
  });

  try {
    await getRedirectResult(auth);   // 리다이렉트 로그인에서 돌아온 경우
  } catch (e) {
    api.error = e.code || e.message;
    console.warn('[cloud] 리다이렉트 로그인 실패:', api.error);
  }

  if (!auth.currentUser) await signInAnonymously(auth);
} catch (e) {
  api.available = false;
  api.error = e && e.message ? e.message : String(e);
  console.warn('[cloud] 사용 불가, 로컬 저장으로 동작합니다:', api.error);
}

emit('cloud-ready', api);
