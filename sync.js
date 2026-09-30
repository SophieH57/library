'use strict';
// ---------- Sauvegarde en ligne (Firebase, compte Google) ----------
// Le téléphone reste la source d'affichage (localStorage) ; Firestore en garde une copie :
//   users/{uid}                 → { members, dropped }
//   users/{uid}/books/{bookId}  → livre + ses emprunts/achats (loans)
// Firestore met en file les écritures hors ligne et les envoie au retour du réseau.

const FB = 'https://www.gstatic.com/firebasejs/12.19.0/';
const cloud = { user: null, status: '', ready: false, synced: {}, fs: null, unsub: [] };

const bookDocs = () => {
  const byBook = {};
  for (const l of db.loans) (byBook[l.bookId] ||= []).push(l);
  const out = {};
  for (const b of Object.values(db.books)) out[b.id] = JSON.stringify({ ...b, loans: byBook[b.id] || [] });
  return out;
};
const metaDoc = () => JSON.stringify({ members: db.members, dropped: db.dropped });
const saveLocal = () => localStorage.setItem(KEY, JSON.stringify(db));

function cloudHtml() {
  if (!window.FIREBASE_CONFIG) return '';
  return `<h2>Sauvegarde en ligne</h2>
    ${cloud.user
      ? `<p>☁️ Connectée : <b>${esc(cloud.user.email)}</b><br><span class="muted" id="cloud-st">${esc(cloud.status)}</span></p>
         <button data-act="logout">Se déconnecter</button>`
      : `<p class="muted">Copie automatique de vos données sur votre compte Google : rien n'est perdu en cas de changement de téléphone.</p>
         <button data-act="login" class="primary">Se connecter avec Google</button>`}`;
}

function setStatus(s) {
  cloud.status = s;
  const el = $('#cloud-st');
  if (el) el.textContent = s;
}

let pushTimer;
window.onSave = () => { clearTimeout(pushTimer); pushTimer = setTimeout(push, 500); };

function push() {
  if (!cloud.ready) return;
  const { doc, writeBatch } = cloud.fs, base = `users/${cloud.user.uid}`;
  const cur = bookDocs(), ops = [];
  for (const [id, j] of Object.entries(cur)) if (cloud.synced[id] !== j) ops.push(['set', `${base}/books/${id}`, j]);
  for (const id of Object.keys(cloud.synced)) if (id !== '_meta' && !(id in cur)) ops.push(['del', `${base}/books/${id}`]);
  const meta = metaDoc();
  if (cloud.synced._meta !== meta) ops.push(['set', base, meta]);
  if (!ops.length) return;
  cloud.synced = { ...cur, _meta: meta };
  for (let i = 0; i < ops.length; i += 400) { // max 500 opérations par lot
    const batch = writeBatch(cloud.db);
    for (const [op, path, j] of ops.slice(i, i + 400))
      op === 'del' ? batch.delete(doc(cloud.db, path)) : batch.set(doc(cloud.db, path), JSON.parse(j));
    batch.commit().catch(e => setStatus('⚠️ Erreur d\'envoi : ' + e.code));
  }
}

function listen(uid) {
  const { doc, collection, onSnapshot } = cloud.fs;
  // Prêt à envoyer seulement quand les deux copies en ligne sont arrivées (sinon un nouveau
  // téléphone écraserait la liste des membres avec « Moi »)
  const waiting = new Set(['meta', 'books']);
  const arrived = k => { if (waiting.delete(k) && !waiting.size) { cloud.ready = true; push(); } };
  cloud.unsub.push(onSnapshot(doc(cloud.db, `users/${uid}`), snap => {
    if (!snap.metadata.hasPendingWrites && snap.exists()) {
      const d = snap.data();
      db.members = d.members || db.members;
      db.dropped = d.dropped || {};
      cloud.synced._meta = metaDoc();
      saveLocal(); render();
    }
    arrived('meta');
  }));
  cloud.unsub.push(onSnapshot(collection(cloud.db, `users/${uid}/books`), { includeMetadataChanges: true }, snap => {
    let changed = false;
    for (const ch of snap.docChanges()) {
      const id = ch.doc.id;
      if (ch.type === 'removed') {
        if (db.books[id]) { delete db.books[id]; db.loans = db.loans.filter(l => l.bookId !== id); changed = true; }
        delete cloud.synced[id];
        continue;
      }
      if (ch.doc.metadata.hasPendingWrites) continue; // écho de nos propres modifications
      const { loans = [], ...book } = ch.doc.data();
      db.books[id] = book;
      db.loans = db.loans.filter(l => l.bookId !== id).concat(loans);
      changed = true;
    }
    if (changed) {
      const cur = bookDocs();
      for (const ch of snap.docChanges()) if (cur[ch.doc.id]) cloud.synced[ch.doc.id] = cur[ch.doc.id];
      saveLocal(); render();
    }
    setStatus(snap.metadata.hasPendingWrites ? '⏳ Modifications en attente d\'envoi'
      : snap.metadata.fromCache ? '📴 Hors ligne — envoi au retour du réseau' : '✅ Synchronisé');
    // Premier chargement : fusion — les livres présents seulement sur ce téléphone sont envoyés
    arrived('books');
  }));
}

async function initCloud() {
  if (!window.FIREBASE_CONFIG) return;
  const [{ initializeApp }, auth, fs] = await Promise.all(['app', 'auth', 'firestore'].map(m => import(`${FB}firebase-${m}.js`)));
  const app = initializeApp(window.FIREBASE_CONFIG);
  cloud.fs = fs;
  cloud.db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache() });
  cloud.auth = auth.getAuth(app);
  cloud.authMod = auth;
  auth.onAuthStateChanged(cloud.auth, user => {
    cloud.unsub.forEach(u => u());
    Object.assign(cloud, { user, unsub: [], ready: false, synced: {} });
    if (user) { setStatus('Connexion…'); listen(user.uid); }
    if (view === 'settings') render();
  });
}

document.addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!cloud.auth || (act !== 'login' && act !== 'logout')) return;
  try {
    if (act === 'login') await cloud.authMod.signInWithPopup(cloud.auth, new cloud.authMod.GoogleAuthProvider());
    else if (confirm('Se déconnecter ? Les données restent sur ce téléphone.')) await cloud.authMod.signOut(cloud.auth);
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user') alert('Connexion impossible : ' + (err.code || err.message));
  }
});

initCloud().catch(() => {}); // hors ligne au premier lancement : l'appli fonctionne sans la sauvegarde en ligne
