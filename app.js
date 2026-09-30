'use strict';

// ---------- Données (stockées sur le téléphone) ----------
const KEY = 'biblio-v1';
const EMPTY = { members: ['Moi'], books: {}, loans: [], dropped: {}, finished: {} }; // finished[série] = nombre total de tomes
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

// EAN-13 valide (ISBN 978/979, ou code-barres de DVD) ; préfixe 2 = étiquettes internes, ignorées
const eanOk = c => /^[013-9]\d{12}$/.test(c) &&
  [...c].reduce((s, d, i) => s + +d * (i % 2 ? 3 : 1), 0) % 10 === 0;
const isDvd = b => b?.type === 'dvd';

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
    const words = norm(`${b.title} ${b.author} ${b.series} ${b.tome ? `t${b.tome} tome ${b.tome}` : ''} ${isDvd(b) ? 'dvd' : ''}`).split(' ');
    return toks.every(t => words.some(w => w.startsWith(t) || (t.length >= 4 && near(t, w))));
  }).sort(bySeries);
}

function findBook({ isbn, title, tome }) {
  return (isbn && books().find(b => hasIsbn(b, isbn))) ||
    (title && books().find(b => norm(b.title) === norm(title) && String(b.tome || '') === String(tome || '') &&
      (!isbn || !b.isbn)));
}

async function fetchMeta(isbn) {
  const book = /^97[89]/.test(isbn); // sinon : DVD ou autre produit, inconnu de Google Books
  const [m, bnf] = await Promise.all([book ? fetchMetaWeb(isbn) : null,
    bnfSearch(`bib.ean all "${isbn}" or bib.isbn all "${isbn}"`).then(r => r[0]).catch(() => null)]);
  if (!bnf) return m;
  const out = m || { title: bnf.title, author: bnf.author, cover: '', tome: '', series: '' };
  if (bnf.series) Object.assign(out, { series: bnf.series, tome: bnf.tome || out.tome });
  out.type = bnf.dvd || !book ? 'dvd' : '';
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
      dvd: /images anim/i.test(sub(fields('200')[0], 'b')), // « Texte imprimé » / « Images animées »
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
  let recs = [], exact = [];
  for (const q of queries) {
    recs = (a ? await bnfSearch(q + by) : []);
    if (!recs.length) recs = await bnfSearch(q);
    if (!exact.length) exact = recs.filter(r => norm(r.title) === norm(b.title));
    recs = recs.filter(r => r.series && (norm(r.title) === norm(b.title) || norm(r.series) === norm(b.title)));
    if (recs.length) break;
  }
  // DVD seulement si toutes les notices au même titre sont des vidéos (un roman peut avoir son film)
  const dvd = exact.length > 0 && exact.every(r => r.dvd);
  if (!recs.length) return exact.length ? { series: '', tome: '', author: '', isbns: [], dvd } : null;
  const same = recs.filter(r => b.tome && r.tome === +b.tome);
  if (same.length) recs = same;
  // Tome connu mais introuvable : on garde la série, jamais le numéro ni les ISBN d'un autre tome
  else if (b.tome) recs = recs.map(r => ({ ...r, tome: '', isbns: [] }));
  const count = {};
  for (const r of recs) count[norm(r.series)] = (count[norm(r.series)] || 0) + 1;
  const key = Object.keys(count).sort((x, y) => count[y] - count[x])[0];
  const best = recs.filter(r => norm(r.series) === key);
  return { series: best[0].series, tome: best.find(r => r.tome)?.tome || '', author: best[0].author,
    isbns: [...new Set(best.flatMap(r => r.isbns))], dvd: dvd || best.every(r => r.dvd) };
}

let bnfRunning = false;
const BNF_V = 2; // 2 : détection du support (livre / DVD) ajoutée — les documents déjà vérifiés le sont à nouveau
async function completeSeries() {
  if (bnfRunning) return;
  if (!navigator.onLine) return alert('Connexion Internet nécessaire.');
  bnfRunning = true;
  const todo = books().filter(b => (b.bnf || 0) < BNF_V);
  let found = 0, i = 0;
  const show = msg => { const el = $('#bnf-st'); if (el) el.textContent = msg; };
  try {
    for (const b of todo) {
      show(`${++i} / ${todo.length} — ${found} série(s) trouvée(s)…`);
      const r = await bnfFind(b);
      b.bnf = BNF_V;
      if (r?.dvd && !b.type) b.type = 'dvd';
      if (r?.series) {
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
    show(`Terminé : ${found} série(s) trouvée(s) sur ${todo.length} document(s).`);
  } catch {
    show(`Interrompu (connexion ?) après ${i - 1} livre(s). Relancez pour continuer.`);
  }
  bnfRunning = false;
  if (view !== 'settings') render();
}

// ---------- Rendu ----------
const READ = { true: '📖 Lu', false: '🚫 Pas lu', null: '❔ Lu ?' };
const SEEN = { true: '📺 Vu', false: '🚫 Pas vu', null: '❔ Vu ?' };
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
      <button class="chip" data-act="read" data-id="${b.id}" data-m="${esc(m)}">${(isDvd(b) ? SEEN : READ)[r.read]}</button>
      <button class="chip" data-act="like" data-id="${b.id}" data-m="${esc(m)}">${LIKE[r.liked]}</button></span>`;
  }).join('')}</div>`;
}

// Série en tête (bien visible), titre du tome dessous ; titre masqué s'il répète la série (« Mortelle Adèle. 14 »)
function bookInfo(b) {
  const icon = isDvd(b) ? '💿 ' : '';
  if (!b.series) return `<b>${icon}${esc(b.title)}</b><small>${esc(b.author)}</small>`;
  const bare = b.title.replace(TOME_RE, '').replace(/[\s.\-–:,]+$/, '');
  return `<div class="series">${icon}${esc(b.series)}${b.tome ? ` <span class="tome-badge">T${b.tome}</span>` : ''}</div>
    ${norm(bare) === norm(b.series) ? '' : `<div class="vol">${esc(b.title)}</div>`}
    <small>${esc(b.author)}</small>`;
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
  pending = { ...(m || {}), isbn, type: m?.type ?? (/^97[89]/.test(isbn) ? '' : 'dvd') };
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

// ---------- Collection : séries (2 tomes ou plus) et livres seuls ----------
const coll = { tab: 'series', q: '', st: 'active', sort: 'date', t: '', m: '', r: '', soloSort: 'date', open: new Set() };
const lastDate = bs => bs.flatMap(b => loansOf(b.id).map(l => l.date)).sort().at(-1) || '';
const matchQ = (text, q) => { const t = norm(text); return norm(q).split(' ').filter(Boolean).every(w => t.includes(w)); };

function collGroups() {
  const groups = {}, solo = [];
  for (const b of books()) if (b.series) (groups[norm(b.series)] ||= { name: b.series, books: [] }).books.push(b);
  const series = [];
  for (const [k, g] of Object.entries(groups)) {
    if (g.books.length > 1) series.push({ k, ...g, last: lastDate(g.books) });
    else solo.push(g.books[0]);
  }
  return { series, solo: solo.concat(books().filter(b => !b.series)) };
}

function pills(g) {
  const have = new Set(g.books.filter(b => loansOf(b.id).length && b.tome).map(b => +b.tome));
  const max = Math.max(0, ...have), total = db.finished[g.k] || 0;
  const end = total ? Math.max(total, max) : max + 1; // série terminée : pas de « prochain » tome
  const from = end > 13 ? end - 12 : 1; // longues séries : seulement les derniers tomes
  let html = from > 1 ? '<span class="pill more">…</span>' : '';
  for (let n = from; n <= end; n++)
    html += `<span class="pill ${have.has(n) ? 'on' : !total && n > max ? 'next' : 'gap'}">${n}</span>`;
  const gaps = [];
  for (let n = 1; n <= (total || max); n++) if (!have.has(n)) gaps.push(n);
  return { html, max, gaps, total };
}

function readSummary(bs) {
  return db.members.map(m => {
    const rs = bs.map(b => readOf(b, m));
    const read = rs.filter(r => r.read === true).length, up = rs.filter(r => r.liked === true).length,
      down = rs.filter(r => r.liked === false).length, no = rs.filter(r => r.read === false).length;
    if (!read && !up && !down && !no) return '';
    return `<span class="who"><b>${esc(m)}</b> ${read ? `📖 ${read}` : ''}${no ? ` 🚫 ${no}` : ''}${up ? ` 👍 ${up}` : ''}${down ? ` 👎 ${down}` : ''}</span>`;
  }).filter(Boolean).join(' · ');
}

function tomeRow(b) {
  const ls = loansOf(b.id);
  const bare = b.title.replace(TOME_RE, '').replace(/[\s.\-–:,]+$/, '');
  return `<div class="trow">
      <span class="tome-badge">${b.tome ? 'T' + b.tome : '?'}</span>
      <span class="ttl">${norm(bare) === norm(b.series) ? '' : esc(b.title)}</span>
      <small>${ls.length ? `${isBuy(ls[0]) ? '🛒' : '📚'} ${fmt(ls[0].date)}` : 'jamais emprunté'}</small>
      <button class="chip" data-act="edit" data-id="${b.id}">✏️</button>
    </div>${readers(b)}`;
}

function seriesCard(g) {
  const p = pills(g), dropped = !!db.dropped[g.k], open = coll.open.has(g.k), sum = readSummary(g.books);
  const missing = p.gaps.length ? `<span class="gaps"> · ⚠️ Manquants : ${ranges(p.gaps)}</span>` : '';
  return `<div class="card scard ${dropped ? 'dropped' : ''}">
    <div class="info">
      <div class="shead" data-act="toggle" data-k="${esc(g.k)}">
        <span class="series">${esc(g.name)}</span><small>${fmt(g.last)} ${open ? '▴' : '▾'}</small>
      </div>
      <div class="pills" data-act="toggle" data-k="${esc(g.k)}">${p.html}</div>
      ${dropped ? '<div class="muted">✋ Série abandonnée</div>'
        : p.total ? `<div class="next">🏁 Terminée (${p.total} tomes)${missing || ' · ✅ Complète'}</div>`
        : `<div class="next">➡️ Prochain : tome ${p.max + 1}${missing}</div>`}
      ${sum ? `<small>${sum}</small>` : ''}
      ${open ? `<div class="tomes">${[...g.books].sort(bySeries).map(tomeRow).join('')}
        <button class="chip" data-act="finish" data-k="${esc(g.k)}" data-max="${p.max}">${p.total ? '↩️ Pas terminée' : '🏁 Série terminée'}</button>
        <button class="chip" data-act="drop" data-k="${esc(g.k)}">${dropped ? '↩️ Reprendre la série' : '✋ Abandonner la série'}</button></div>` : ''}
    </div></div>`;
}

function soloRow(b) {
  const ls = loansOf(b.id), key = 'b:' + b.id;
  if (coll.open.has(key)) return `<div class="solo-open">${bookCard(b)}<button class="chip" data-act="toggle" data-k="${key}">▴ Réduire</button></div>`;
  const sum = readSummary([b]);
  return `<div class="card solo" data-act="toggle" data-k="${key}"><div class="info">
      ${bookInfo(b)}
      <small>${ls.length ? `${ls.some(l => !isBuy(l)) ? '📚' : ''}${ls.some(isBuy) ? '🛒' : ''} ${fmt(ls[0].date)}` : 'jamais emprunté'}${sum ? ' · ' + sum : ''}</small>
    </div></div>`;
}

function renderSeries() {
  const el = $('#v-series');
  if (!$('#coll-q')) el.innerHTML = `
    <div class="subtabs">
      <button data-act="ctab" data-v="series">📚 Séries</button><button data-act="ctab" data-v="solo">📖 Livres seuls</button>
    </div>
    <input id="coll-q" type="search" placeholder="🔎 Filtrer…" autocomplete="off">
    <div class="row filters" id="coll-f-series">
      <select data-c="st">${opts({ active: 'En cours', finished: '🏁 Terminées', dropped: '✋ Abandonnées', all: 'Toutes' }, coll.st)}</select>
      <select data-c="sort">${opts({ date: 'Tri : dernier emprunt', title: 'Tri : A → Z' }, coll.sort)}</select>
    </div>
    <div id="coll-f-solo">
      <div class="row filters">
        <select data-c="t">${opts({ '': 'Livres et DVD', book: '📖 Livres', dvd: '💿 DVD' }, coll.t)}</select>
        <select data-c="soloSort">${opts({ date: 'Tri : dernier emprunt', title: 'Tri : A → Z' }, coll.soloSort)}</select>
      </div>
      <div class="row filters">
        <select data-c="m">${opts({ '': 'Tout le monde', ...Object.fromEntries(db.members.map(m => [m, m])) }, coll.m)}</select>
        <select data-c="r">${opts({ '': 'Lus ou non', true: '📖 Lus', false: '🚫 Pas lus', null: '❔ Non renseigné' }, coll.r)}</select>
      </div>
    </div>
    <div id="coll-body"></div>`;
  for (const b of el.querySelectorAll('.subtabs button')) b.classList.toggle('on', b.dataset.v === coll.tab);
  $('#coll-f-series').hidden = coll.tab !== 'series';
  $('#coll-f-solo').hidden = coll.tab !== 'solo';
  renderCollBody();
}

function renderCollBody() {
  const { series, solo } = collGroups(), body = $('#coll-body');
  const byTitle = (a, b) => norm(a).localeCompare(norm(b));
  if (coll.tab === 'series') {
    const status = g => db.dropped[g.k] ? 'dropped' : db.finished[g.k] ? 'finished' : 'active';
    const list = series.filter(g => (coll.st === 'all' || coll.st === status(g)) &&
      matchQ(g.name + ' ' + g.books.map(b => b.title).join(' '), coll.q))
      .sort((a, b) => coll.sort === 'title' ? byTitle(a.name, b.name) : b.last.localeCompare(a.last));
    body.innerHTML = `<p class="muted">${list.length} série(s)</p>` + (list.map(seriesCard).join('') ||
      '<p class="muted">Aucune série ici. Une série apparaît dès que deux tomes ont le même champ « Série ».</p>');
  } else {
    const who = coll.m ? [coll.m] : db.members;
    const st = (b, m) => String(readOf(b, m).read);
    const list = solo.filter(b => (!coll.t || (coll.t === 'dvd') === isDvd(b)) &&
      (!coll.r || (coll.r === 'null' ? who.every(m => st(b, m) === 'null') : who.some(m => st(b, m) === coll.r))) &&
      matchQ(`${b.title} ${b.author} ${b.series}`, coll.q))
      .sort((a, b) => coll.soloSort === 'title' ? byTitle(a.series || a.title, b.series || b.title)
        : lastDate([b]).localeCompare(lastDate([a])));
    body.innerHTML = `<p class="muted">${list.length} document(s)</p>` + (list.slice(0, 300).map(soloRow).join('') ||
      '<p class="muted">Aucun document.</p>');
  }
}

const hist = { m: '', k: '', r: '', t: '' };
const opts = (o, cur) => Object.entries(o).map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
function renderHistory() {
  const who = hist.m ? [hist.m] : db.members;
  const st = (b, m) => String(readOf(b, m).read);
  const list = books().filter(b => {
    const ls = loansOf(b.id);
    if (!ls.length || (hist.k && !ls.some(l => (hist.k === 'buy') === isBuy(l)))) return false;
    if (hist.t && (hist.t === 'dvd') !== isDvd(b)) return false;
    if (!hist.r) return true;
    return hist.r === 'null' ? who.every(m => st(b, m) === 'null') : who.some(m => st(b, m) === hist.r);
  }).sort((a, b) => loansOf(b.id)[0].date.localeCompare(loansOf(a.id)[0].date));
  $('#v-history').innerHTML = `
    <select id="h-m" data-h="m">${opts({ '': 'Tout le monde', ...Object.fromEntries(db.members.map(m => [m, m])) }, hist.m)}</select>
    <div class="row filters">
      <select data-h="t">${opts({ '': 'Livres et DVD', book: '📖 Livres', dvd: '💿 DVD' }, hist.t)}</select>
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
    <button data-act="bnf">🔎 Retrouver les séries</button> <span id="bnf-st" class="muted">${books().filter(b => (b.bnf || 0) < BNF_V).length} document(s) à vérifier</span>

    ${typeof cloudHtml === 'function' ? cloudHtml() : ''}

    <h2>Sauvegarde</h2>
    <p class="muted">Les données restent uniquement sur ce téléphone. Exportez-les régulièrement.</p>
    <button data-act="export">⬇️ Exporter (sauvegarde)</button>
    <button data-act="exportcsv">📊 Exporter en CSV (tableur)</button>
    <label class="btn">⬆️ Restaurer<input type="file" accept=".json,application/json" id="imp-json" hidden></label>

    <h2>Importer l'historique de la bibliothèque</h2>
    <p class="muted">Export CSV de votre compte bibliothèque (Iguana), ou fichier avec des colonnes titre, auteur, ISBN, date.</p>
    <p><label class="btn">📄 Choisir le fichier CSV<input type="file" accept=".csv,.txt,text/csv" id="imp-csv" hidden></label></p>

    <p class="muted">${books().filter(b => !isDvd(b)).length} livre(s) · ${books().filter(isDvd).length} DVD · ${db.loans.filter(l => !isBuy(l)).length} emprunt(s) · ${db.loans.filter(isBuy).length} achat(s)</p>`;
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
  for (const k of ['id', 'title', 'author', 'series', 'tome', 'isbn', 'cover', 'type']) f.elements[k].value = book?.[k] ?? '';
  f.elements.date.value = today();
  f.elements.kind.value = kind;
  $('#f-h').textContent = !loan ? 'Modifier' : kind === 'buy' ? 'Nouvel achat' : 'Nouvel emprunt';
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
    isbn: isbn || b.isbn || '', cover: v('cover') || b.cover || '', type: v('type') });
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
      const c = (await det.detect(video)).find(c => eanOk(c.rawValue));
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
    return [isBuy(l) ? 'Achat' : 'Emprunt', isDvd(b) ? 'DVD' : 'Livre', fmt(l.date), b.title, b.author, b.series, b.tome, b.isbn,
      ...db.members.flatMap(m => { const r = readOf(b, m); return [txt(r.read, 'oui', 'non'), txt(r.liked, 'aimé', 'pas aimé')]; })];
  });
  const head = ['Type', 'Support', 'Date', 'Titre', 'Auteur', 'Série', 'Tome', 'ISBN', ...db.members.flatMap(m => [`${m} - lu`, `${m} - avis`])];
  return '\uFEFF' + [head, ...rows]
    .map(r => r.map(cell).join(';')).join('\r\n');
}

function importCsv(text) {
  // Connecté mais données en ligne pas encore reçues : importer maintenant créerait des doublons
  if (typeof cloud !== 'undefined' && cloud.user && !cloud.ready)
    return alert('Synchronisation en cours, réessayez dans quelques secondes.');
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
  const cs = col('serie'), cn = h.indexOf('tome'), ck = h.indexOf('type'), cu = h.indexOf('support');
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
    m.type = cu >= 0 && norm(r[cu]) === 'dvd' ? 'dvd' : '';
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
    case 'drop': db.dropped[t.dataset.k] = !db.dropped[t.dataset.k]; delete db.finished[t.dataset.k]; break;
    case 'finish': {
      const k = t.dataset.k;
      if (db.finished[k]) { delete db.finished[k]; break; }
      const n = prompt('Série terminée. Nombre total de tomes ?', t.dataset.max);
      if (n === null) return;
      db.finished[k] = Math.max(1, parseInt(n) || +t.dataset.max || 1);
      delete db.dropped[k];
      break;
    }
    case 'ctab': coll.tab = t.dataset.v; return renderSeries();
    case 'toggle': {
      const k = t.dataset.k;
      coll.open.has(k) ? coll.open.delete(k) : coll.open.add(k);
      return renderCollBody();
    }
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
  if (t.dataset.c) { coll[t.dataset.c] = t.value; return renderCollBody(); }
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
document.addEventListener('input', e => { if (e.target.id === 'coll-q') { coll.q = e.target.value; renderCollBody(); } });
$('#scan').onclick = scan;
render();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
