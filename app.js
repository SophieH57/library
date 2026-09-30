'use strict';

// ---------- Données (stockées sur le téléphone) ----------
const KEY = 'biblio-v1';
const EMPTY = { members: ['Moi'], books: {}, loans: [], dropped: {} };
let db = load();

function load() {
  try { return { ...structuredClone(EMPTY), ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return structuredClone(EMPTY); }
}
// Emprunt / achat = livre + date. La lecture (lu, avis) est propre à chaque personne : book.reads[prénom].
function save() { localStorage.setItem(KEY, JSON.stringify(db)); window.onSave?.(); }
navigator.storage?.persist?.();

// ---------- Utilitaires ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => new Date().toLocaleDateString('sv');
const fmt = d => d ? new Date(d + 'T12:00').toLocaleDateString('fr-FR') : '';
const books = () => Object.values(db.books);
const loansOf = id => db.loans.filter(l => l.bookId === id).sort((a, b) => b.date.localeCompare(a.date));
const isBuy = l => l.kind === 'buy';
const hasIsbn = (b, isbn) => b.isbn === isbn || !!b.isbns?.includes(isbn); // isbns : autres éditions (BnF)
const bySeries = (a, b) => norm(a.series || a.title).localeCompare(norm(b.series || b.title)) || (+a.tome || 0) - (+b.tome || 0);

function cleanIsbn(s) {
  s = String(s ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (s.length === 10) {
    const b = '978' + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += +b[i] * (i % 2 ? 3 : 1);
    s = b + ((10 - sum % 10) % 10);
  }
  return /^\d{13}$/.test(s) ? s : '';
}

const TOME_RE = /(?:\btome|\bt\.?|\bvol(?:ume)?\.?|n°|#)\s*(\d{1,3})\b/i;
function guessMeta(title, author = '', cover = '') {
  title = String(title ?? '').trim();
  author = String(author ?? '').replace(/\s*\d{4}-(\d{4}|\.+)?\s*$/, '').trim(); // « Falzar 1961-.... »
  const d = title.match(/^(.+?)\.\s*(\d{1,3})$/); // « Les Légendaires. 5 »
  if (d) return { title: d[1], author, cover, tome: +d[2], series: d[1] };
  const m = title.match(TOME_RE);
  const series = m ? title.slice(0, m.index).replace(/[\s\-–:,.(]+$/, '') : '';
  return { title, author, cover, tome: m ? +m[1] : '', series };
}

// Distance d'édition <= 1 (tolère une faute de frappe)
function near(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, e = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++e > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return e + (a.length - i) + (b.length - j) <= 1;
}

function searchBooks(q) {
  const toks = norm(q).split(' ').filter(Boolean);
  if (!toks.length) return [];
  return books().filter(b => {
    const words = norm(`${b.title} ${b.author} ${b.series} ${b.tome ? `t${b.tome} tome ${b.tome}` : ''}`).split(' ');
    return toks.every(t => words.some(w => w.startsWith(t) || (t.length >= 4 && near(t, w))));
  }).sort(bySeries);
}

function findBook({ isbn, title, tome }) {
  return (isbn && books().find(b => hasIsbn(b, isbn))) ||
    (title && books().find(b => norm(b.title) === norm(title) && String(b.tome || '') === String(tome || '') &&
      (!isbn || !b.isbn)));
}

async function fetchMeta(isbn) {
  const [m, bnf] = await Promise.all([fetchMetaWeb(isbn),
    bnfSearch(`bib.ean all "${isbn}" or bib.isbn all "${isbn}"`).then(r => r[0]).catch(() => null)]);
  if (!bnf) return m;
  const out = m || { title: bnf.title, author: bnf.author, cover: '', tome: '', series: '' };
  if (bnf.series) Object.assign(out, { series: bnf.series, tome: bnf.tome || out.tome });
  return out;
}

async function fetchMetaWeb(isbn) {
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`).then(r => r.json());
    const v = r.items?.[0]?.volumeInfo;
    if (v) return guessMeta(v.title + (v.subtitle ? ' - ' + v.subtitle : ''), (v.authors || []).join(', '),
      v.imageLinks?.thumbnail?.replace('http:', 'https:'));
  } catch {}
  try {
    const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`).then(r => r.json());
    const v = r['ISBN:' + isbn];
    if (v) return guessMeta(v.title + (v.subtitle ? ' - ' + v.subtitle : ''), (v.authors || []).map(a => a.name).join(', '), v.cover?.medium);
  } catch {}
  return null;
}

// ---------- BnF : série et ISBN (catalogue général, gratuit, sans clé) ----------
const xmlText = s => s.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (_, e) =>
  ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] ?? String.fromCharCode(+e.slice(1))));
const words = s => String(s ?? '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Notices UNIMARC : 200$a titre, 461$t/$v série et numéro, 700 auteur, 010/073 ISBN/EAN
async function bnfSearch(cql) {
  const url = 'https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&recordSchema=unimarcXchange&maximumRecords=10&query=' +
    encodeURIComponent(cql);
  const x = await fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); });
  return x.split('<srw:record>').slice(1).map(rec => {
    const fields = tag => [...rec.matchAll(new RegExp(`<mxc:datafield tag="${tag}"[^>]*>([\\s\\S]*?)</mxc:datafield>`, 'g'))].map(m => m[1]);
    const sub = (f, c) => xmlText(f?.match(new RegExp(`code="${c}">([^<]*)`))?.[1] || '');
    const f461 = fields('461')[0], au = fields('700')[0] || fields('701')[0];
    return {
      title: sub(fields('200')[0], 'a'),
      author: [sub(au, 'a'), sub(au, 'b')].filter(Boolean).join(' '),
      series: sub(f461, 't').replace(/[\s.;:,]+$/, ''),
      tome: +(sub(f461, 'v').match(/\d+/)?.[0]) || '',
      isbns: [...fields('010'), ...fields('073')].map(f => cleanIsbn(sub(f, 'a'))).filter(Boolean),
    };
  });
}

async function bnfFind(b) {
  const a = words(b.author), by = a ? ` and bib.author all "${a}"` : '';
  // Le numéro dans la requête retrouve le bon tome quand le titre est le nom de la série (« Mortelle Adèle. 14 »)
  const queries = [b.tome && `bib.title all "${words(b.title)} ${b.tome}"`, `bib.title all "${words(b.title)}"`].filter(Boolean);
  let recs = [];
  for (const q of queries) {
    recs = (a ? await bnfSearch(q + by) : []);
    if (!recs.length) recs = await bnfSearch(q);
    recs = recs.filter(r => r.series && (norm(r.title) === norm(b.title) || norm(r.series) === norm(b.title)));
    if (recs.length) break;
  }
  if (!recs.length) return null;
  const same = recs.filter(r => b.tome && r.tome === +b.tome);
  if (same.length) recs = same;
  // Tome connu mais introuvable : on garde la série, jamais le numéro ni les ISBN d'un autre tome
  else if (b.tome) recs = recs.map(r => ({ ...r, tome: '', isbns: [] }));
  const count = {};
  for (const r of recs) count[norm(r.series)] = (count[norm(r.series)] || 0) + 1;
  const key = Object.keys(count).sort((x, y) => count[y] - count[x])[0];
  const best = recs.filter(r => norm(r.series) === key);
  return { series: best[0].series, tome: best.find(r => r.tome)?.tome || '', author: best[0].author,
    isbns: [...new Set(best.flatMap(r => r.isbns))] };
}

let bnfRunning = false;
async function completeSeries() {
  if (bnfRunning) return;
  if (!navigator.onLine) return alert('Connexion Internet nécessaire.');
  bnfRunning = true;
  const todo = books().filter(b => !b.bnf);
  let found = 0, i = 0;
  const show = msg => { const el = $('#bnf-st'); if (el) el.textContent = msg; };
  try {
    for (const b of todo) {
      show(`${++i} / ${todo.length} — ${found} série(s) trouvée(s)…`);
      const r = await bnfFind(b);
      b.bnf = 1;
      if (r) {
        found++;
        // Ne remplace pas une série saisie à la main (seulement la série vide ou devinée depuis le titre)
        if (!b.series || norm(b.series) === norm(b.title)) b.series = r.series;
        if (r.tome && norm(b.series) === norm(r.series)) b.tome = r.tome;
        b.isbns = r.isbns.filter(x => x !== b.isbn);
        b.author ||= r.author;
      }
      save();
      await new Promise(r => setTimeout(r, 300)); // reste poli avec le serveur de la BnF
    }
    show(`Terminé : ${found} série(s) trouvée(s) sur ${todo.length} livre(s).`);
  } catch {
    show(`Interrompu (connexion ?) après ${i - 1} livre(s). Relancez pour continuer.`);
  }
  bnfRunning = false;
  if (view !== 'settings') render();
}

// ---------- Rendu ----------
const READ = { true: '📖 Lu', false: '🚫 Pas lu', null: '❔ Lu ?' };
const LIKE = { true: '👍', false: '👎', null: '🤷' };

const readOf = (b, m) => ({ read: null, liked: null, ...b.reads?.[m] });

function loanLine(l) {
  return `<div class="loan">${isBuy(l) ? '🛒 Acheté' : '📚 Emprunté'} le ${fmt(l.date)}
    <button class="chip" data-act="delloan" data-id="${l.id}">🗑</button></div>`;
}

function readers(b) {
  return `<div class="readers">${db.members.map(m => {
    const r = readOf(b, m);
    return `<span class="loan"><b>${esc(m)}</b>
      <button class="chip" data-act="read" data-id="${b.id}" data-m="${esc(m)}">${READ[r.read]}</button>
      <button class="chip" data-act="like" data-id="${b.id}" data-m="${esc(m)}">${LIKE[r.liked]}</button></span>`;
  }).join('')}</div>`;
}

function bookInfo(b) {
  return `<b>${esc(b.title)}</b><small>${esc(b.author)}${b.series ? ` · ${esc(b.series)}${b.tome ? ' T' + b.tome : ''}` : ''}</small>`;
}

function bookCard(b) {
  const loans = loansOf(b.id);
  const st = [loans.some(l => !isBuy(l)) && '✅ Déjà emprunté', loans.some(isBuy) && '🛒 Acheté'].filter(Boolean);
  return `<div class="card ${loans.length ? 'yes' : 'no'}">
    ${b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy">` : ''}
    <div class="info">
      <div class="status">${st.length ? st.join(' · ') : '❌ Jamais emprunté ni acheté'}</div>
      ${bookInfo(b)}
      ${loans.map(loanLine).join('')}
      ${readers(b)}
      <button data-act="loan" data-id="${b.id}">+ Emprunter</button>
      <button data-act="buy" data-id="${b.id}">+ Acheté</button>
      <button data-act="edit" data-id="${b.id}">✏️</button>
    </div></div>`;
}

let pending = null; // livre scanné pas encore enregistré

async function showIsbn(isbn) {
  const res = $('#result'), q = $('#q').value;
  const b = books().find(b => hasIsbn(b, isbn));
  if (b) { res.innerHTML = bookCard(b); return; }
  res.innerHTML = `<div class="card no"><div class="info"><div class="status">❌ Jamais emprunté</div>
    <small>ISBN ${isbn}${navigator.onLine ? ' — recherche des infos…' : ''}</small></div></div>`;
  const m = navigator.onLine ? await fetchMeta(isbn) : null;
  if ($('#q').value !== q) return;
  pending = { ...(m || {}), isbn };
  // Même livre, autre édition (ISBN différent) ?
  const rest = m?.tome ? m.title.slice(m.title.search(TOME_RE)).replace(TOME_RE, '').replace(/^[\s\-–:,.]+/, '') : '';
  const sims = m ? [...new Set([
    ...searchBooks(m.series && m.tome ? `${m.series} t${m.tome}` : m.title),
    ...(rest ? searchBooks(rest) : []),
  ])].filter(b => loansOf(b.id).length) : [];
  res.innerHTML = `<div class="card no">
    ${m?.cover ? `<img src="${esc(m.cover)}" alt="">` : ''}
    <div class="info"><div class="status">❌ Jamais emprunté ni acheté</div>
      ${m ? bookInfo(m) : `<small>ISBN ${isbn} — infos introuvables${navigator.onLine ? '' : ' (hors ligne)'}</small>`}
      ${sims.length ? `<div class="sims">⚠️ Peut-être déjà emprunté ou acheté (autre édition) :${sims.slice(0, 3).map(s =>
        `<br>• ${esc(s.title)}${s.tome ? ' T' + s.tome : ''} — ${fmt(loansOf(s.id)[0].date)}
        ${s.isbn ? '' : `<button class="chip" data-act="link" data-id="${s.id}">C'est ce livre</button>`}`).join('')}</div>` : ''}
      <button data-act="new" class="primary">+ Emprunt</button>
      <button data-act="newbuy" class="primary">+ Achat</button>
    </div></div>`;
}

function renderHome() {
  const q = $('#q').value.trim(), res = $('#result');
  if (!q) {
    const recent = [...new Set([...db.loans].sort((a, b) => b.date.localeCompare(a.date)).map(l => l.bookId))].slice(0, 5);
    res.innerHTML = recent.length
      ? '<h2>Derniers ajouts</h2>' + recent.map(id => db.books[id] && bookCard(db.books[id])).join('')
      : '<p class="muted">Scannez un livre ou tapez un titre pour savoir s\'il a déjà été emprunté ou acheté.</p>';
    return;
  }
  if (/^[\d\s-]+[Xx]?$/.test(q)) {
    const isbn = cleanIsbn(q);
    if (isbn) return showIsbn(isbn);
    res.innerHTML = '<p class="muted">ISBN incomplet…</p>';
    return;
  }
  const found = searchBooks(q);
  res.innerHTML = (found.length ? '' : '<div class="card no"><div class="info"><div class="status">❌ Aucun livre trouvé</div></div></div>') +
    found.slice(0, 30).map(bookCard).join('') +
    `<button data-act="newq" class="big">+ Ajouter « ${esc(q)} »</button>`;
}

const ranges = ns => ns.reduce((a, n) => {
  const l = a[a.length - 1];
  if (l && n === l[1] + 1) l[1] = n; else a.push([n, n]);
  return a;
}, []).map(([a, b]) => a === b ? a : `${a}–${b}`).join(', ');

function renderSeries() {
  const groups = {};
  for (const b of books()) if (b.series) (groups[norm(b.series)] ||= { name: b.series, books: [] }).books.push(b);
  const rows = Object.entries(groups).map(([k, g]) => {
    const rs = g.books.flatMap(b => db.members.map(m => readOf(b, m)));
    const tomes = [...new Set(g.books.filter(b => loansOf(b.id).length && b.tome).map(b => +b.tome))].sort((a, b) => a - b);
    const max = tomes.at(-1) || 0;
    const gaps = [];
    for (let i = 1; i < max; i++) if (!tomes.includes(i)) gaps.push(i);
    return { k, g, tomes, max, gaps, dropped: !!db.dropped[k],
      likes: rs.filter(r => r.liked === true).length, dislikes: rs.filter(r => r.liked === false).length,
      unread: rs.filter(r => r.read === false).length };
  }).sort((a, b) => a.dropped - b.dropped || norm(a.g.name).localeCompare(norm(b.g.name)));

  $('#v-series').innerHTML = rows.length ? `<ul class="list">${rows.map(r => `
    <li class="${r.dropped ? 'dropped' : ''}">
      <div class="name" data-act="goseries" data-s="${esc(r.g.name)}">${esc(r.g.name)}</div>
      <small>Tomes empruntés ou achetés : ${r.tomes.length ? ranges(r.tomes) : '—'}</small>
      ${r.dropped ? '<div class="muted">Série abandonnée</div>'
        : `<div class="next">➡️ Prochain : tome ${r.max + 1}</div>${r.gaps.length ? `<small>Manquants : ${ranges(r.gaps)}</small>` : ''}`}
      <small>👍 ${r.likes} · 👎 ${r.dislikes} · 🚫 ${r.unread} non lu(s)</small>
      <button class="chip" data-act="drop" data-k="${r.k}">${r.dropped ? '↩️ Reprendre' : '✋ Abandonner'}</button>
    </li>`).join('')}</ul>`
    : '<p class="muted">Aucune série. Renseignez le champ « Série » et le tome lors d\'un emprunt.</p>';
}

const hist = { m: '', k: '', r: '' };
const opts = (o, cur) => Object.entries(o).map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
function renderHistory() {
  const who = hist.m ? [hist.m] : db.members;
  const st = (b, m) => String(readOf(b, m).read);
  const list = books().filter(b => {
    const ls = loansOf(b.id);
    if (!ls.length || (hist.k && !ls.some(l => (hist.k === 'buy') === isBuy(l)))) return false;
    if (!hist.r) return true;
    return hist.r === 'null' ? who.every(m => st(b, m) === 'null') : who.some(m => st(b, m) === hist.r);
  }).sort((a, b) => loansOf(b.id)[0].date.localeCompare(loansOf(a.id)[0].date));
  $('#v-history').innerHTML = `
    <select id="h-m" data-h="m">${opts({ '': 'Tout le monde', ...Object.fromEntries(db.members.map(m => [m, m])) }, hist.m)}</select>
    <div class="row filters">
      <select data-h="k">${opts({ '': 'Emprunts et achats', loan: '📚 Emprunts', buy: '🛒 Achats' }, hist.k)}</select>
      <select data-h="r">${opts({ '': 'Lus ou non', true: '📖 Lus', false: '🚫 Pas lus', null: '❔ Non renseigné' }, hist.r)}</select>
    </div>
    <p class="muted">${list.length} livre(s)</p>
    ${list.slice(0, 200).map(bookCard).join('')}`;
}

function renderSettings() {
  $('#v-settings').innerHTML = `
    <h2>Famille</h2>
    <ul class="list">${db.members.map(m => `<li>${esc(m)} <button class="chip" data-act="delmember" data-m="${esc(m)}">🗑</button></li>`).join('')}</ul>
    <form id="addm" class="bar"><input name="n" placeholder="Prénom" required><button class="primary">Ajouter</button></form>

    <h2>Séries</h2>
    <p class="muted">Cherche dans le catalogue de la BnF la série et le numéro de chaque livre
      (ex. « L'or de Boavista » → Marsupilami, tome 7), ainsi que ses ISBN pour le reconnaître au scan.
      Seuls les livres pas encore vérifiés sont traités.</p>
    <button data-act="bnf">🔎 Retrouver les séries</button> <span id="bnf-st" class="muted">${books().filter(b => !b.bnf).length} livre(s) à vérifier</span>

    ${typeof cloudHtml === 'function' ? cloudHtml() : ''}

    <h2>Sauvegarde</h2>
    <p class="muted">Les données restent uniquement sur ce téléphone. Exportez-les régulièrement.</p>
    <button data-act="export">⬇️ Exporter (sauvegarde)</button>
    <button data-act="exportcsv">📊 Exporter en CSV (tableur)</button>
    <label class="btn">⬆️ Restaurer<input type="file" accept=".json,application/json" id="imp-json" hidden></label>

    <h2>Importer l'historique de la bibliothèque</h2>
    <p class="muted">Export CSV de votre compte bibliothèque (Iguana), ou fichier avec des colonnes titre, auteur, ISBN, date.</p>
    <p><label class="btn">📄 Choisir le fichier CSV<input type="file" accept=".csv,.txt,text/csv" id="imp-csv" hidden></label></p>

    <p class="muted">${books().length} livre(s) · ${db.loans.filter(l => !isBuy(l)).length} emprunt(s) · ${db.loans.filter(isBuy).length} achat(s)</p>`;
}

const VIEWS = { home: renderHome, series: renderSeries, history: renderHistory, settings: renderSettings };
let view = 'home';
function render() { VIEWS[view](); }
function go(v) {
  view = v;
  for (const s of document.querySelectorAll('.view')) s.hidden = s.id !== 'v-' + v;
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('on', b.dataset.view === v);
  render();
  scrollTo(0, 0);
}

// ---------- Formulaire ----------
function openForm(book, loan = true, kind = 'loan') {
  const f = $('#bookform');
  f.reset();
  for (const k of ['id', 'title', 'author', 'series', 'tome', 'isbn', 'cover']) f.elements[k].value = book?.[k] ?? '';
  f.elements.date.value = today();
  f.elements.kind.value = kind;
  $('#f-h').textContent = !loan ? 'Modifier le livre' : kind === 'buy' ? 'Nouvel achat' : 'Nouvel emprunt';
  $('#f-loan').hidden = !loan;
  $('#f-del').hidden = loan || !book?.id;
  $('#serieslist').innerHTML = [...new Set(books().map(b => b.series).filter(Boolean))].map(s => `<option value="${esc(s)}">`).join('');
  $('#form').showModal();
}

$('#bookform').addEventListener('submit', e => {
  if (e.submitter?.value !== 'ok') return;
  const f = e.target, v = k => f.elements[k].value.trim();
  const isbn = cleanIsbn(v('isbn'));
  let b = db.books[v('id')] || findBook({ isbn, title: v('title'), tome: v('tome') });
  if (!b) { b = { id: uid() }; db.books[b.id] = b; }
  Object.assign(b, { title: v('title'), author: v('author'), series: v('series'), tome: v('tome') ? +v('tome') : '',
    isbn: isbn || b.isbn || '', cover: v('cover') || b.cover || '' });
  if (!$('#f-loan').hidden) db.loans.push({ id: uid(), bookId: b.id, kind: f.elements.kind.value, date: v('date') || today() });
  save();
  if (view === 'home') $('#q').value = b.isbn || b.title;
  render();
});

$('#f-del').onclick = () => {
  const id = $('#bookform').elements.id.value;
  if (!confirm('Supprimer ce livre et tout son historique ?')) return;
  delete db.books[id];
  db.loans = db.loans.filter(l => l.bookId !== id);
  save(); $('#form').close(); render();
};

// ---------- Scanner (BarcodeDetector, natif sur Chrome Android) ----------
async function scan() {
  if (!('BarcodeDetector' in window)) return alert('Scan non supporté par ce navigateur. Utilisez Chrome sur Android, ou tapez l\'ISBN.');
  const det = new BarcodeDetector({ formats: ['ean_13'] });
  const dlg = $('#scanner'), video = $('#video');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
  catch (e) { return alert('Caméra inaccessible : ' + e.message); }
  video.srcObject = stream;
  dlg.showModal();
  await video.play();
  let on = true;
  const stop = () => { on = false; stream.getTracks().forEach(t => t.stop()); if (dlg.open) dlg.close(); };
  dlg.onclose = stop;
  $('#scan-cancel').onclick = stop;
  while (on) {
    try {
      const c = (await det.detect(video)).find(c => /^97[89]\d{10}$/.test(c.rawValue));
      if (c) { stop(); navigator.vibrate?.(100); $('#q').value = c.rawValue; go('home'); return; }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
}

// ---------- Import / export ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function parseCsv(text) {
  const first = text.split(/\r?\n/)[0];
  const sep = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

const MONTHS = ['janv', 'fev', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sep', 'oct', 'nov', 'dec'];
function toIso(s) {
  s = String(s ?? '');
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  m = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (!m) {
    const f = norm(s).match(/(\d{1,2}) ([a-z]+) (\d{4})/); // « 26 sept. 2026 »
    const mo = f && MONTHS.findIndex(p => f[2].startsWith(p)) + 1;
    return mo ? `${f[3]}-${String(mo).padStart(2, '0')}-${f[1].padStart(2, '0')}` : '';
  }
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// Séparateur « ; » et BOM UTF-8 : s'ouvre directement dans Excel (version française) et LibreOffice
function exportCsv() {
  const cell = v => /[;"\n]/.test(v = String(v ?? '')) ? `"${v.replace(/"/g, '""')}"` : v;
  const txt = (v, yes, no) => v === true ? yes : v === false ? no : '';
  const rows = [...db.loans].sort((a, b) => b.date.localeCompare(a.date)).map(l => {
    const b = db.books[l.bookId] || {};
    return [isBuy(l) ? 'Achat' : 'Emprunt', fmt(l.date), b.title, b.author, b.series, b.tome, b.isbn,
      ...db.members.flatMap(m => { const r = readOf(b, m); return [txt(r.read, 'oui', 'non'), txt(r.liked, 'aimé', 'pas aimé')]; })];
  });
  const head = ['Type', 'Date', 'Titre', 'Auteur', 'Série', 'Tome', 'ISBN', ...db.members.flatMap(m => [`${m} - lu`, `${m} - avis`])];
  return '\uFEFF' + [head, ...rows]
    .map(r => r.map(cell).join(';')).join('\r\n');
}

function importCsv(text) {
  let rows = parseCsv(text.replace(/^﻿/, ''));
  const hi = rows.slice(0, 3).findIndex(r => r.some(x => /^(titre|title|isbn)/.test(norm(x))));
  const raw = hi >= 0 ? rows[hi].map(x => x.trim()) : [];
  const h = raw.map(norm);
  rows = rows.slice(hi + 1);
  const col = (...keys) => h.findIndex(x => keys.some(k => x.includes(k)));
  let ci = col('isbn', 'ean'), ct = col('titre', 'title'), ca = col('auteur', 'author'), cd = col('date', 'pret', 'emprunt');
  if (hi < 0) { // sans en-tête (export Iguana) : titre ; auteur ; … ; date du prêt
    rows = rows.filter(r => r.length > 1);
    ct = 0; ca = 1;
    const n = j => rows.filter(r => toIso(r[j])).length;
    cd = [...Array(Math.max(0, ...rows.map(r => r.length))).keys()].reduce((a, j) => n(j) > n(a) ? j : a, 0);
    if (!n(cd)) cd = -1;
  }
  // Colonnes présentes dans l'export CSV de l'appli
  const cs = col('serie'), cn = h.indexOf('tome'), ck = h.indexOf('type');
  const rcols = raw.map((x, j) => x.match(/^(.+) - (lu|avis)$/i) && [j, ...x.match(/^(.+) - (lu|avis)$/i).slice(1)]).filter(Boolean);
  const yesNo = (v, yes, no) => norm(v) === yes ? true : norm(v) === no ? false : null;
  if (ct < 0 && ci < 0) return alert('Colonnes « titre » ou « isbn » introuvables dans la première ligne.');
  let n = 0;
  for (const r of rows) {
    const isbn = ci >= 0 ? cleanIsbn(r[ci]) : '';
    const m = guessMeta(ct >= 0 ? r[ct] : '', ca >= 0 ? (r[ca] || '').trim() : '');
    if (!m.title && !isbn) continue;
    if (cs >= 0 && r[cs]?.trim()) m.series = r[cs].trim();
    if (cn >= 0 && +r[cn]) m.tome = +r[cn];
    const date = toIso(cd >= 0 ? r[cd] : '') || today();
    let b = findBook({ isbn, title: m.title, tome: m.tome });
    if (!b) { b = { id: uid(), ...m, title: m.title || 'ISBN ' + isbn, isbn }; db.books[b.id] = b; }
    const kind = ck >= 0 && norm(r[ck]) === 'achat' ? 'buy' : 'loan';
    for (const [j, who, what] of rcols) {
      const v = what.toLowerCase() === 'lu' ? yesNo(r[j], 'oui', 'non') : yesNo(r[j], 'aime', 'pas aime');
      if (v === null) continue;
      if (!db.members.includes(who)) db.members.push(who);
      (b.reads ||= {})[who] = { ...readOf(b, who), [what.toLowerCase() === 'lu' ? 'read' : 'liked']: v };
    }
    if (db.loans.some(l => l.bookId === b.id && l.date === date && (l.kind || 'loan') === kind)) continue;
    db.loans.push({ id: uid(), bookId: b.id, kind, date });
    n++;
  }
  save(); render();
  alert(`${n} entrée(s) importée(s).`);
}

// ---------- Événements ----------
const cycle = v => v === null ? true : v === true ? false : null;

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-view]');
  if (!t) return;
  if (t.dataset.view) return go(t.dataset.view);
  const id = t.dataset.id, loan = db.loans.find(l => l.id === id);
  switch (t.dataset.act) {
    case 'loan': return openForm(db.books[id]);
    case 'buy': return openForm(db.books[id], true, 'buy');
    case 'newbuy': return openForm(pending, true, 'buy');
    case 'link': { // livre importé sans ISBN : on lui attache l'ISBN scanné
      const b = db.books[id];
      b.isbn = pending.isbn; b.cover ||= pending.cover || ''; b.author ||= pending.author || '';
      break;
    }
    case 'edit': return openForm(db.books[id], false);
    case 'new': return openForm(pending);
    case 'newq': return openForm(guessMeta($('#q').value));
    case 'read': case 'like': {
      const b = db.books[id], m = t.dataset.m, r = readOf(b, m), k = t.dataset.act === 'read' ? 'read' : 'liked';
      r[k] = cycle(r[k]);
      (b.reads ||= {})[m] = r;
      break;
    }
    case 'delloan':
      if (!confirm(`Supprimer cet ${isBuy(loan) ? 'achat' : 'emprunt'} ?`)) return;
      db.loans = db.loans.filter(l => l !== loan); break;
    case 'drop': db.dropped[t.dataset.k] = !db.dropped[t.dataset.k]; break;
    case 'goseries': $('#q').value = t.dataset.s; return go('home');
    case 'delmember':
      if (!confirm(`Retirer ${t.dataset.m} ? (son historique est conservé)`)) return;
      db.members = db.members.filter(m => m !== t.dataset.m); break;
    case 'bnf': return completeSeries();
    case 'export': return download(`emprunts-${today()}.json`, JSON.stringify(db, null, 1), 'application/json');
    case 'exportcsv': return download(`emprunts-${today()}.csv`, exportCsv(), 'text/csv');
    default: return;
  }
  save(); render();
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'addm') return;
  e.preventDefault();
  const n = e.target.elements.n.value.trim();
  if (n && !db.members.includes(n)) db.members.push(n);
  save(); render();
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.h) { hist[t.dataset.h] = t.value; render(); }
  if (!t.files?.[0]) return;
  // Les exports de bibliothèque sont souvent en Latin-1 plutôt qu'en UTF-8
  const buf = await t.files[0].arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
  t.value = '';
  if (t.id === 'imp-csv') importCsv(text);
  if (t.id === 'imp-json') {
    try {
      const d = JSON.parse(text);
      if (!d.books || !d.loans) throw 0;
      if (!confirm('Remplacer toutes les données actuelles par cette sauvegarde ?')) return;
      db = { ...structuredClone(EMPTY), ...d }; save(); render();
    } catch { alert('Fichier de sauvegarde invalide.'); }
  }
});

$('#q').addEventListener('input', renderHome);
$('#scan').onclick = scan;
render();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
