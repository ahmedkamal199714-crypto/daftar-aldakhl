/* دفتر الدخل — app logic (Firebase Auth + Firestore, local fallback until wired) */
import { firebaseConfig, OWNER_EMAIL } from './firebase-config.js';

const FB_READY = !firebaseConfig.apiKey.startsWith('REPLACE');
let fb = null;
if (FB_READY) {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
  const authMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
  const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  const app = initializeApp(firebaseConfig);
  fb = { app, authMod, fsMod, auth: authMod.getAuth(app), db: fsMod.getFirestore(app) };
}

/* ---------- constants ---------- */
const TYPES = {
  transfer:        { label: 'تحويل',              badge: 'green', needsAmount: true },
  withdraw_sameh:  { label: 'سحب سامح',           badge: 'red',   needsAmount: true },
  rent_pay:        { label: 'دفع إيجار المحل',    badge: 'amber', needsAmount: true },
  priv_pay:        { label: 'دفع مبلغ خاص بسامح', badge: 'blue',  needsAmount: true },
  expense:         { label: 'مصروفات أخرى',       badge: 'red',   needsAmount: true, needsBearer: true },
  capital_add:     { label: 'إضافة رأس مال',      badge: 'green', needsAmount: true, needsPerson: true },
  capital_withdraw:{ label: 'سحب رأس مال',        badge: 'red',   needsAmount: true, needsPerson: true },
  opening:         { label: 'رصيد افتتاحي',       badge: 'grey',  needsAmount: false }
};
const PARTIES = [
  { id: 'ahmed', label: 'أحمد' },
  { id: 'sameh', label: 'سامح' },
  { id: 'rent',  label: 'الإيجار' },
  { id: 'priv',  label: 'المبلغ الخاص بسامح' },
  { id: 'cash',  label: 'النقدية' }
];
const SPLIT = { sameh: 300, rent: 130, priv: 100 };
const BEARER_LABEL = { ahmed: 'أحمد', sameh: 'سامح', both: 'الاثنين بالنصف' };

/* ---------- helpers ---------- */
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = n => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US');
const fmtDate = iso => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' });
};
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36);

function toast(msg, kind='') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toast-root').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/* ---------- state ---------- */
const state = {
  user: null,          // { email, name, role: 'owner'|'viewer' }
  movements: [],       // sorted by date asc then createdAt
  partners: [],        // emails with view access
  loaded: false
};
const isOwner = () => state.user && state.user.role === 'owner';

/* ---------- data layer ---------- */
/* Movement: { id, date, type, label, amount, note, bearer, person,
   dAhmed, dSameh, dRent, dPriv, createdAt, createdBy, updatedAt } */

const localStore = {
  read() { try { return JSON.parse(localStorage.getItem('daftar_movements') || '[]'); } catch { return []; } },
  write(rows) { localStorage.setItem('daftar_movements', JSON.stringify(rows)); }
};

async function loadMovements() {
  if (FB_READY && fb) {
    const { collection, getDocs, query, orderBy } = fb.fsMod;
    const snap = await getDocs(query(collection(fb.db, 'movements'), orderBy('date'), orderBy('createdAt')));
    state.movements = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } else {
    state.movements = localStore.read().sort((a,b) => a.date.localeCompare(b.date) || (a.createdAt||0)-(b.createdAt||0));
  }
  state.loaded = true;
}

async function saveMovement(m, isNew) {
  m.updatedAt = Date.now();
  if (FB_READY && fb) {
    const { collection, doc, setDoc, addDoc } = fb.fsMod;
    if (isNew) {
      m.createdAt = Date.now();
      m.createdBy = state.user?.email || '';
      const ref = await addDoc(collection(fb.db, 'movements'), m);
      m.id = ref.id;
    } else {
      const { id, ...data } = m;
      await setDoc(doc(fb.db, 'movements', id), data);
    }
  } else {
    if (isNew) { m.id = uid(); m.createdAt = Date.now(); }
    const rows = localStore.read().filter(r => r.id !== m.id);
    rows.push(m); localStore.write(rows);
  }
  await audit(isNew ? 'إضافة' : 'تعديل', `${m.label || TYPES[m.type]?.label} — ${fmt(m.amount)} — ${m.date}`);
  await loadMovements();
}

async function removeMovement(m) {
  if (FB_READY && fb) {
    const { doc, deleteDoc } = fb.fsMod;
    await deleteDoc(doc(fb.db, 'movements', m.id));
  } else {
    localStore.write(localStore.read().filter(r => r.id !== m.id));
  }
  await audit('حذف', `${m.label || TYPES[m.type]?.label} — ${fmt(m.amount)} — ${m.date}`);
  await loadMovements();
}

async function audit(action, summary) {
  const entry = { ts: Date.now(), by: state.user?.email || 'محلي', action, summary };
  if (FB_READY && fb) {
    try {
      const { collection, addDoc } = fb.fsMod;
      await fb.fsMod.addDoc(collection(fb.db, 'audit'), entry);
    } catch {}
  } else {
    const rows = JSON.parse(localStorage.getItem('daftar_audit') || '[]');
    rows.push(entry); localStorage.setItem('daftar_audit', JSON.stringify(rows));
  }
}

async function loadAudit() {
  if (FB_READY && fb) {
    const { collection, getDocs, query, orderBy, limit } = fb.fsMod;
    const snap = await getDocs(query(collection(fb.db, 'audit'), orderBy('ts', 'desc'), limit(200)));
    return snap.docs.map(d => d.data());
  }
  return JSON.parse(localStorage.getItem('daftar_audit') || '[]').sort((a,b) => b.ts - a.ts);
}

async function loadPartners() {
  if (FB_READY && fb) {
    const { doc, getDoc } = fb.fsMod;
    const d = await getDoc(fb.fsMod.doc(fb.db, 'meta', 'partners'));
    state.partners = d.exists() ? (d.data().emails || []) : [];
  } else {
    state.partners = JSON.parse(localStorage.getItem('daftar_partners') || '[]');
  }
}
async function savePartners(emails) {
  state.partners = emails;
  if (FB_READY && fb) {
    const { doc, setDoc } = fb.fsMod;
    await setDoc(doc(fb.db, 'meta', 'partners'), { emails });
  } else {
    localStorage.setItem('daftar_partners', JSON.stringify(emails));
  }
}

/* ---------- balances ---------- */
function balances(movs = state.movements) {
  const b = { ahmed: 0, sameh: 0, rent: 0, priv: 0 };
  for (const m of movs) {
    b.ahmed += m.dAhmed || 0; b.sameh += m.dSameh || 0;
    b.rent  += m.dRent  || 0; b.priv  += m.dPriv  || 0;
  }
  b.cash = b.ahmed + b.sameh + b.rent + b.priv;
  return b;
}

/* Build the effect deltas for a movement being created/edited */
function deltasFor(type, amount, bearer) {
  const d = { dAhmed: 0, dSameh: 0, dRent: 0, dPriv: 0 };
  const a = Number(amount) || 0;
  if (type === 'transfer') {
    d.dSameh = SPLIT.sameh; d.dRent = SPLIT.rent; d.dPriv = SPLIT.priv;
    d.dAhmed = a - SPLIT.sameh - SPLIT.rent - SPLIT.priv;
  } else if (type === 'withdraw_sameh') d.dSameh = -a;
  else if (type === 'rent_pay') d.dRent = -a;
  else if (type === 'priv_pay') d.dPriv = -a;
  else if (type === 'expense') {
    if (bearer === 'sameh') d.dSameh = -a;
    else if (bearer === 'both') { d.dAhmed = -a/2; d.dSameh = -a/2; }
    else d.dAhmed = -a;
  }
  return d;
}

/* ---------- seed (real data from his Whacka ledger, Nov 10–23 2026) ---------- */
const SEED = [
  { date: '2026-11-10', type: 'opening', note: 'أرصدة افتتاحية', dAhmed: 65200, dSameh: -850, dRent: 390, dPriv: 0 },
  { date: '2026-11-11', type: 'transfer', amount: 1830 },
  { date: '2026-11-12', type: 'transfer', amount: 1830 },
  { date: '2026-11-12', type: 'expense', amount: 15000, bearer: 'both', note: 'تامين للمحل' },
  { date: '2026-11-13', type: 'transfer', amount: 1830 },
  { date: '2026-11-16', type: 'transfer', amount: 1130 },
  { date: '2026-11-17', type: 'transfer', amount: 1380 },
  { date: '2026-11-18', type: 'transfer', amount: 1380 },
  { date: '2026-11-19', type: 'transfer', amount: 1130 },
  { date: '2026-11-20', type: 'transfer', amount: 1130 },
  { date: '2026-11-21', type: 'transfer', amount: 1380 },
  { date: '2026-11-21', type: 'withdraw_sameh', amount: 10000, note: 'سحب سامح' },
  { date: '2026-11-22', type: 'transfer', amount: 1830, note: 'تحويل سامح يوم 22 نوفمبر' },
  { date: '2026-11-23', type: 'transfer', amount: 1580, note: 'تحويل سامح يوم 23 نوفمبر' }
];

async function runSeed() {
  for (const s of SEED) {
    const d = s.type === 'opening'
      ? { dAhmed: s.dAhmed, dSameh: s.dSameh, dRent: s.dRent, dPriv: s.dPriv }
      : deltasFor(s.type, s.amount, s.bearer);
    const m = { date: s.date, type: s.type, label: TYPES[s.type].label, amount: s.amount ?? null,
      bearer: s.bearer || null, note: s.note || '', ...d };
    await saveMovement(m, true);
  }
}

/* ---------- auth ---------- */
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}
async function showApp(user) {
  state.user = user;
  $('#login-view').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-name').textContent = user.name || 'أحمد كمال';
  $('#user-role').textContent = user.role === 'owner' ? 'مدير النظام' : 'شريك — عرض فقط';
  $('#sidebar-email').textContent = user.email || 'وضع محلي';
  await loadPartners();
  if (FB_READY && fb && state.user.email && state.user.email !== OWNER_EMAIL && state.partners.includes(state.user.email)) {
    state.user.role = 'viewer';
    $('#user-role').textContent = 'شريك — عرض فقط';
  }
  await loadMovements();
  route();
}

function initAuth() {
  if (FB_READY && fb) {
    const { GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut } = fb.authMod;
    $('#login-btn').onclick = async () => {
      $('#login-error').textContent = '';
      try {
        await signInWithPopup(fb.auth, new GoogleAuthProvider());
      } catch (e) {
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/popup-closed-by-user') {
          try { await signInWithRedirect(fb.auth, new GoogleAuthProvider()); } catch (e2) {
            $('#login-error').textContent = 'تعذر تسجيل الدخول، حاول مرة أخرى';
          }
        } else {
          $('#login-error').textContent = 'تعذر تسجيل الدخول، حاول مرة أخرى';
        }
      }
    };
    onAuthStateChanged(fb.auth, async u => {
      if (u) await showApp({ email: u.email, name: u.displayName, role: u.email === OWNER_EMAIL ? 'owner' : 'viewer' });
      else showLogin();
    });
    $('#logout-btn').onclick = () => signOut(fb.auth);
  } else {
    $('#login-btn').textContent = 'الدخول (وضع محلي — البيانات على هذا المتصفح)';
    $('#login-btn').onclick = () => showApp({ email: '', name: 'أحمد كمال', role: 'owner' });
    $('#logout-btn').onclick = () => location.reload();
  }
}

/* ---------- router ---------- */
const ROUTES = { '': 'home', '/': 'home', '/movements': 'movements', '/statement': 'statement',
  '/reports': 'reports', '/capital': 'capital', '/audit': 'audit', '/admin': 'admin' };
function route() {
  const page = ROUTES[location.hash.replace('#', '')] ?? 'home';
  $$('#side-nav a, #bottom-nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  ({ home: renderHome, movements: renderMovements, statement: renderStatement,
     reports: renderReports, capital: renderCapital, audit: renderAudit, admin: renderAdmin })[page]();
  $('#page').scrollTop = 0; window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

/* ---------- home ---------- */
function renderHome() {
  const b = balances();
  const recent = [...state.movements].filter(m => m.type !== 'opening').slice(-7).reverse();
  $('#page').innerHTML = `
    <div class="page-head">
      <div><h1>الرئيسية</h1><div class="sub">نظرة عامة على أرصدة الدفتر — ${fmtDate(todayISO())}</div></div>
      <div class="actions">${isOwner() ? `<button class="btn btn-green" data-act="add-transfer"><svg><use href="#i-plus"/></svg>إضافة تحويل</button>` : ''}</div>
    </div>
    <div class="cards">
      <div class="card stat cash"><div class="lbl"><svg><use href="#i-wallet"/></svg>النقدية</div>
        <div class="val">${fmt(b.cash)} <small>جنيه</small></div>
        <div class="hint">مجموع أرصدة: أحمد + سامح + الإيجار + الخاص</div></div>
      <div class="card stat"><div class="lbl"><div class="dot green"><svg><use href="#i-user"/></svg></div>أحمد</div>
        <div class="val">${fmt(b.ahmed)}</div><div class="hint">جنيه</div></div>
      <div class="card stat ${b.sameh < 0 ? 'negative' : ''}"><div class="lbl"><div class="dot ${b.sameh<0?'red':'green'}"><svg><use href="#i-user"/></svg></div>سامح</div>
        <div class="val">${fmt(b.sameh)}</div><div class="hint">جنيه ${b.sameh < 0 ? '(عليه)' : ''}</div></div>
      <div class="cards c2" style="grid-template-columns:1fr 1fr;gap:14px;margin:0">
        <div class="card stat"><div class="lbl"><div class="dot amber"><svg><use href="#i-doc"/></svg></div>الإيجار</div>
          <div class="val">${fmt(b.rent)}</div><div class="hint">جنيه</div></div>
        <div class="card stat"><div class="lbl"><div class="dot blue"><svg><use href="#i-coin"/></svg></div>الخاص بسامح</div>
          <div class="val">${fmt(b.priv)}</div><div class="hint">جنيه</div></div>
      </div>
    </div>
    ${isOwner() ? `
    <div class="section card">
      <h2>إجراءات سريعة</h2><div class="sub">العمليات اليومية المعتادة</div>
      <div class="quick">
        <button class="qa" data-act="add-transfer"><span class="ic dot green"><svg><use href="#i-swap"/></svg></span><b>إضافة تحويل</b><span>إيجار 130 · سامح 300 · خاص 100 · الباقي أحمد</span></button>
        <button class="qa" data-act="add-withdraw"><span class="ic dot red"><svg><use href="#i-down"/></svg></span><b>سحب سامح</b><span>خصم من رصيد سامح</span></button>
        <button class="qa" data-act="add-rent"><span class="ic dot amber"><svg><use href="#i-doc"/></svg></span><b>دفع إيجار المحل</b><span>خصم من رصيد الإيجار</span></button>
        <button class="qa" data-act="add-expense"><span class="ic dot blue"><svg><use href="#i-up"/></svg></span><b>مصروفات أخرى</b><span>أحمد / سامح / الاثنين بالنصف</span></button>
      </div>
    </div>` : ''}
    <div class="section card">
      <div class="section-head"><h2>آخر الحركات</h2><a href="#/movements" class="btn btn-ghost btn-sm">عرض الكل</a></div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>التاريخ</th><th>البيان</th><th>النوع</th><th>المبلغ</th></tr></thead>
        <tbody>${recent.map(m => `<tr>
          <td class="muted">${fmtDate(m.date)}</td>
          <td>${esc(m.note) || TYPES[m.type].label}${m.bearer ? ` <span class="tiny">(${BEARER_LABEL[m.bearer]})</span>` : ''}</td>
          <td><span class="badge ${TYPES[m.type].badge}">${TYPES[m.type].label}</span></td>
          <td class="num">${m.amount != null ? fmt(m.amount) : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">لا توجد حركات بعد</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

/* ---------- movements ---------- */
let movFilter = 'all';
function renderMovements() {
  const filters = [['all','الكل'],['transfer','تحويلات'],['withdraw_sameh','سحب سامح'],['rent_pay','إيجار'],['priv_pay','خاص بسامح'],['expense','مصروفات']];
  let rows = state.movements.filter(m => m.type !== 'opening' && !m.type.startsWith('capital'));
  if (movFilter !== 'all') rows = rows.filter(m => m.type === movFilter);
  rows = [...rows].reverse();
  $('#page').innerHTML = `
    <div class="page-head">
      <div><h1>الحركات</h1><div class="sub">كل التحويلات والمصروفات والمدفوعات المسجلة</div></div>
      <div class="actions">
        <button class="btn btn-ghost" data-act="export-xlsx"><svg><use href="#i-backup"/></svg>تصدير Excel</button>
        ${isOwner() ? `<button class="btn btn-green" data-act="add-transfer"><svg><use href="#i-plus"/></svg>إضافة تحويل</button>` : ''}
      </div>
    </div>
    <div class="chips">${filters.map(([v,l]) => `<button class="chip ${movFilter===v?'active':''}" data-filter="${v}">${l}</button>`).join('')}</div>
    <div class="card" style="padding:6px"><div class="tbl-wrap" style="border:none">
      <table><thead><tr><th>التاريخ</th><th>البيان</th><th>النوع</th><th>أحمد</th><th>سامح</th><th>الإيجار</th><th>الخاص</th><th>المبلغ</th>${isOwner()?'<th></th>':''}</tr></thead>
      <tbody>${rows.map(m => `<tr>
        <td class="muted" style="white-space:nowrap">${fmtDate(m.date)}</td>
        <td>${esc(m.note) || TYPES[m.type].label}${m.bearer ? ` <span class="tiny">(${BEARER_LABEL[m.bearer]})</span>` : ''}</td>
        <td><span class="badge ${TYPES[m.type].badge}">${TYPES[m.type].label}</span></td>
        <td class="num ${m.dAhmed>0?'pos':m.dAhmed<0?'neg':''}">${m.dAhmed ? fmt(m.dAhmed) : '—'}</td>
        <td class="num ${m.dSameh>0?'pos':m.dSameh<0?'neg':''}">${m.dSameh ? fmt(m.dSameh) : '—'}</td>
        <td class="num ${m.dRent>0?'pos':m.dRent<0?'neg':''}">${m.dRent ? fmt(m.dRent) : '—'}</td>
        <td class="num ${m.dPriv>0?'pos':m.dPriv<0?'neg':''}">${m.dPriv ? fmt(m.dPriv) : '—'}</td>
        <td class="num">${m.amount != null ? fmt(m.amount) : '—'}</td>
        ${isOwner() ? `<td><div class="row-actions">
          <button class="iconbtn" data-edit="${m.id}" title="تعديل"><svg width="14" height="14"><use href="#i-edit"/></svg></button>
          <button class="iconbtn" data-del="${m.id}" title="حذف"><svg width="14" height="14"><use href="#i-trash"/></svg></button>
        </div></td>` : ''}</tr>`).join('') || '<tr><td colspan="9" class="empty">لا توجد حركات مطابقة</td></tr>'}</tbody>
      </table></div></div>`;
  $$('.chip[data-filter]').forEach(c => c.onclick = () => { movFilter = c.dataset.filter; renderMovements(); });
}

/* ---------- statement (كشف الحساب) ---------- */
let stParty = 'ahmed', stPeriod = 'month', stFrom = '', stTo = '';
function statementRows(party, from, to) {
  const field = { ahmed:'dAhmed', sameh:'dSameh', rent:'dRent', priv:'dPriv' }[party];
  let run = 0; const out = [];
  for (const m of state.movements) {
    if (from && m.date < from) { if (m.type !== 'opening' && field) run += (m[field]||0); else if (party==='cash') run += (m.dAhmed||0)+(m.dSameh||0)+(m.dRent||0)+(m.dPriv||0); else if (m.type==='opening') run += field ? (m[field]||0) : 0; continue; }
    if (to && m.date > to) continue;
    let delta = party === 'cash' ? (m.dAhmed||0)+(m.dSameh||0)+(m.dRent||0)+(m.dPriv||0) : (m[field]||0);
    if (m.type === 'opening') delta = party === 'cash' ? (m.dAhmed||0)+(m.dSameh||0)+(m.dRent||0)+(m.dPriv||0) : (m[field]||0);
    if (!delta && m.type !== 'opening') continue;
    run += delta;
    out.push({ date: m.date, label: esc(m.note) || TYPES[m.type].label, inn: delta > 0 ? delta : 0, out: delta < 0 ? -delta : 0, bal: run, opening: m.type === 'opening' });
  }
  return out;
}
function renderStatement() {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  let from = '', to = '';
  if (stPeriod === 'day') { from = to = todayISO(); }
  else if (stPeriod === 'month') { from = monthStart; to = todayISO(); }
  else { from = stFrom; to = stTo; }
  const rows = statementRows(stParty, from, to);
  const totIn = rows.reduce((s,r) => s + r.inn, 0), totOut = rows.reduce((s,r) => s + r.out, 0);
  const bal = balances();
  const partyLabel = PARTIES.find(p => p.id === stParty).label;
  const partyBal = stParty === 'cash' ? bal.cash : bal[{ahmed:'ahmed',sameh:'sameh',rent:'rent',priv:'priv'}[stParty]];
  $('#page').innerHTML = `
    <div class="page-head">
      <div><h1>كشف الحساب</h1><div class="sub">حركة كل طرف مع الرصيد المتحرك</div></div>
      <div class="actions">
        <button class="btn btn-ghost" data-act="export-xlsx"><svg><use href="#i-backup"/></svg>Excel</button>
        <button class="btn btn-navy" data-act="print"><svg><use href="#i-print"/></svg>طباعة / PDF</button>
      </div>
    </div>
    <div class="chips">${PARTIES.map(p => `<button class="chip ${stParty===p.id?'active':''}" data-party="${p.id}">${p.label}</button>`).join('')}</div>
    <div class="chips">
      <button class="chip ${stPeriod==='day'?'active green':''}" data-period="day">يومي</button>
      <button class="chip ${stPeriod==='month'?'active green':''}" data-period="month">شهري</button>
      <button class="chip ${stPeriod==='custom'?'active green':''}" data-period="custom">فترة</button>
      <button class="chip ${stPeriod==='all'?'active green':''}" data-period="all">الكل</button>
      ${stPeriod === 'custom' ? `<input type="date" id="st-from" value="${stFrom}"> <input type="date" id="st-to" value="${stTo}">` : ''}
    </div>
    <div class="cards c3">
      <div class="card stat"><div class="lbl">رصيد ${partyLabel}</div><div class="val ${partyBal<0?'':''}" ${partyBal<0?'style="color:var(--red)"':''}>${fmt(partyBal)}</div><div class="hint">جنيه</div></div>
      <div class="card stat"><div class="lbl">إجمالي داخل (الفترة)</div><div class="val" style="color:var(--green)">${fmt(totIn)}</div><div class="hint">جنيه</div></div>
      <div class="card stat"><div class="lbl">إجمالي خارج (الفترة)</div><div class="val" style="color:var(--red)">${fmt(totOut)}</div><div class="hint">جنيه</div></div>
    </div>
    <div class="card" style="padding:6px"><div class="tbl-wrap" style="border:none">
      <table><thead><tr><th>التاريخ</th><th>البيان</th><th>داخل</th><th>خارج</th><th>الرصيد</th></tr></thead>
      <tbody>${rows.map(r => `<tr${r.opening?' style="background:#f8fafc"':''}>
        <td class="muted" style="white-space:nowrap">${fmtDate(r.date)}</td><td>${r.label}</td>
        <td class="num pos">${r.inn ? fmt(r.inn) : '—'}</td>
        <td class="num neg">${r.out ? fmt(r.out) : '—'}</td>
        <td class="num" ${r.bal<0?'style="color:var(--red)"':''}>${fmt(r.bal)}</td></tr>`).join('')
        || '<tr><td colspan="5" class="empty">لا توجد حركات في هذه الفترة</td></tr>'}</tbody>
      </table></div></div>`;
  $$('.chip[data-party]').forEach(c => c.onclick = () => { stParty = c.dataset.party; renderStatement(); });
  $$('.chip[data-period]').forEach(c => c.onclick = () => { stPeriod = c.dataset.period; renderStatement(); });
  const f = $('#st-from'), t = $('#st-to');
  if (f) f.onchange = () => { stFrom = f.value; renderStatement(); };
  if (t) t.onchange = () => { stTo = t.value; renderStatement(); };
}

/* ---------- reports ---------- */
let repPeriod = 'month';
function renderReports() {
  const now = new Date();
  const ms = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const prev = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const pms = `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}-01`;
  const pme = ms;
  let from = '', to = '';
  if (repPeriod === 'month') { from = ms; to = todayISO(); }
  else if (repPeriod === 'prev') { from = pms; to = pme; }
  const rows = state.movements.filter(m => m.type !== 'opening' && !m.type.startsWith('capital')
    && (!from || m.date >= from) && (!to || m.date <= to));
  const t = rows.filter(m => m.type === 'transfer');
  const sum = a => a.reduce((s,m) => s + (m.amount||0), 0);
  const transfers = sum(t);
  const expenses = sum(rows.filter(m => m.type === 'expense'));
  const withdrawals = sum(rows.filter(m => m.type === 'withdraw_sameh'));
  const rentPaid = sum(rows.filter(m => m.type === 'rent_pay'));
  const privPaid = sum(rows.filter(m => m.type === 'priv_pay'));
  const dist = {
    ahmed: t.reduce((s,m) => s + (m.dAhmed||0), 0), sameh: t.reduce((s,m) => s + (m.dSameh||0), 0),
    rent: t.reduce((s,m) => s + (m.dRent||0), 0), priv: t.reduce((s,m) => s + (m.dPriv||0), 0)
  };
  const distTotal = Math.max(dist.ahmed + dist.sameh + dist.rent + dist.priv, 1);
  const colors = { ahmed: 'var(--green)', sameh: 'var(--blue)', rent: 'var(--amber)', priv: 'var(--navy)' };
  $('#page').innerHTML = `
    <div class="page-head">
      <div><h1>التقارير</h1><div class="sub">ملخص التحويلات والمصروفات حسب الفترة</div></div>
      <div class="actions"><button class="btn btn-ghost" data-act="export-xlsx"><svg><use href="#i-backup"/></svg>تصدير Excel</button></div>
    </div>
    <div class="chips">
      <button class="chip ${repPeriod==='month'?'active':''}" data-rep="month">هذا الشهر</button>
      <button class="chip ${repPeriod==='prev'?'active':''}" data-rep="prev">الشهر الماضي</button>
      <button class="chip ${repPeriod==='all'?'active':''}" data-rep="all">كل الفترات</button>
    </div>
    <div class="cards">
      <div class="card stat"><div class="lbl"><div class="dot green"><svg><use href="#i-swap"/></svg></div>التحويلات</div>
        <div class="val">${fmt(transfers)}</div><div class="hint">${t.length} تحويل</div></div>
      <div class="card stat"><div class="lbl"><div class="dot red"><svg><use href="#i-up"/></svg></div>المصروفات</div>
        <div class="val">${fmt(expenses)}</div><div class="hint">جنيه</div></div>
      <div class="card stat"><div class="lbl"><div class="dot red"><svg><use href="#i-down"/></svg></div>سحوبات سامح</div>
        <div class="val">${fmt(withdrawals)}</div><div class="hint">جنيه</div></div>
      <div class="card stat"><div class="lbl"><div class="dot amber"><svg><use href="#i-doc"/></svg></div>مدفوعات الإيجار</div>
        <div class="val">${fmt(rentPaid + privPaid)}</div><div class="hint">إيجار ${fmt(rentPaid)} · خاص ${fmt(privPaid)}</div></div>
    </div>
    <div class="section card">
      <h2>توزيع التحويلات</h2>
      <div class="sub">كيف توزعت مبالغ التحويلات على الأطراف — إجمالي ${fmt(distTotal)} جنيه</div>
      <div class="report-bar">
        ${[['أحمد',dist.ahmed,'ahmed'],['سامح',dist.sameh,'sameh'],['الإيجار',dist.rent,'rent'],['الخاص بسامح',dist.priv,'priv']].map(([nm,v,k]) => `
        <div class="rb-row"><span class="nm">${nm}</span>
          <div class="bar"><i style="width:${Math.max(v/distTotal*100,0)}%;background:${colors[k]}"></i></div>
          <span class="num">${fmt(v)}</span></div>`).join('')}
      </div>
    </div>`;
  $$('.chip[data-rep]').forEach(c => c.onclick = () => { repPeriod = c.dataset.rep; renderReports(); });
}

/* ---------- capital (رأس المال) ---------- */
function renderCapital() {
  const rows = state.movements.filter(m => m.type.startsWith('capital'));
  const totals = { ahmed: 0, sameh: 0 };
  for (const m of rows) {
    const v = (m.type === 'capital_add' ? 1 : -1) * (m.amount || 0);
    totals[m.person || 'ahmed'] += v;
  }
  const ledger = state.movements.filter(m => !m.type.startsWith('capital') && m.type !== 'opening');
  const ahmedIn = ledger.reduce((s,m) => s + (m.dAhmed||0), 0);
  $('#page').innerHTML = `
    <div class="page-head">
      <div><h1>رأس المال</h1><div class="sub">رؤوس الأموال المودعة والمسحوبة — منفصلة عن أرباح الدفتر</div></div>
      <div class="actions">${isOwner() ? `<button class="btn btn-green" data-act="add-capital"><svg><use href="#i-plus"/></svg>حركة رأس مال</button>` : ''}</div>
    </div>
    <div class="cards c3">
      <div class="card stat"><div class="lbl"><div class="dot green"><svg><use href="#i-coin"/></svg></div>رأس مال أحمد</div>
        <div class="val">${fmt(totals.ahmed)}</div><div class="hint">جنيه</div></div>
      <div class="card stat"><div class="lbl"><div class="dot blue"><svg><use href="#i-coin"/></svg></div>رأس مال سامح</div>
        <div class="val">${fmt(totals.sameh)}</div><div class="hint">جنيه</div></div>
      <div class="card stat cash"><div class="lbl">إجمالي رأس المال</div>
        <div class="val">${fmt(totals.ahmed + totals.sameh)} <small>جنيه</small></div>
        <div class="hint">صافي أرباح الدفتر حتى الآن: ${fmt(ahmedIn)} جنيه</div></div>
    </div>
    <div class="section card">
      <div class="section-head"><h2>حركات رأس المال</h2></div>
      <div class="tbl-wrap"><table><thead><tr><th>التاريخ</th><th>الطرف</th><th>النوع</th><th>المبلغ</th><th>ملاحظة</th>${isOwner()?'<th></th>':''}</tr></thead>
      <tbody>${[...rows].reverse().map(m => `<tr>
        <td class="muted">${fmtDate(m.date)}</td><td>${BEARER_LABEL[m.person] || m.person || '—'}</td>
        <td><span class="badge ${TYPES[m.type].badge}">${TYPES[m.type].label}</span></td>
        <td class="num">${fmt(m.amount)}</td><td class="muted">${esc(m.note) || '—'}</td>
        ${isOwner() ? `<td><div class="row-actions"><button class="iconbtn" data-del="${m.id}"><svg width="14" height="14"><use href="#i-trash"/></svg></button></div></td>` : ''}</tr>`).join('')
        || '<tr><td colspan="6" class="empty">لا توجد حركات رأس مال مسجلة</td></tr>'}</tbody></table></div>
    </div>`;
}

/* ---------- audit page ---------- */
async function renderAudit() {
  $('#page').innerHTML = `<div class="page-head"><div><h1>سجل التدقيق</h1><div class="sub">كل إضافة وتعديل وحذف على الدفتر</div></div></div>
    <div class="section card" id="audit-list"><div class="empty">جاري التحميل…</div></div>`;
  const rows = await loadAudit();
  const icon = { 'إضافة': 'green', 'تعديل': 'amber', 'حذف': 'red' };
  const glyph = { 'إضافة': 'i-plus', 'تعديل': 'i-edit', 'حذف': 'i-trash' };
  $('#audit-list').innerHTML = `<h2>آخر العمليات</h2><div class="sub">${rows.length} عملية مسجلة</div>` +
    (rows.map(r => `<div class="audit-item">
      <span class="ic dot ${icon[r.action] || 'blue'}"><svg><use href="#${glyph[r.action] || 'i-clock'}"/></svg></span>
      <div class="tx"><b>${r.action}: ${esc(r.summary)}</b>
      <span>${new Date(r.ts).toLocaleString('ar-EG-u-nu-latn')} — ${esc(r.by)}</span></div></div>`).join('')
    || '<div class="empty">لا يوجد سجل بعد</div>');
}

/* ---------- admin ---------- */
function renderAdmin() {
  const b = balances();
  $('#page').innerHTML = `
    <div class="page-head"><div><h1>الإدارة</h1><div class="sub">الشركاء والنسخ الاحتياطي وإعدادات الدفتر</div></div></div>
    <div class="section card">
      <h2>الشركاء</h2>
      <div class="sub">دعوة شريك للاطلاع على الدفتر (عرض فقط، بدون تعديل)</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <input id="partner-email" type="email" placeholder="بريد الشريك (جيميل)" style="flex:1;min-width:220px;padding:10px 13px;border:1px solid var(--line);border-radius:10px;font-family:inherit">
        <button class="btn btn-navy" data-act="add-partner">إضافة</button>
      </div>
      <div>${state.partners.map(e => `<span class="badge blue" style="margin-left:6px">${esc(e)} <a href="javascript:void 0" data-rm-partner="${esc(e)}" style="font-weight:700">×</a></span>`).join('') || '<span class="tiny">لا يوجد شركاء بعد</span>'}</div>
    </div>
    <div class="section card">
      <h2>النسخ الاحتياطي</h2>
      <div class="sub">تنزيل نسخة كاملة من بيانات الدفتر أو استعادتها</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" data-act="export-xlsx"><svg><use href="#i-backup"/></svg>نسخة Excel</button>
        <button class="btn btn-ghost" data-act="backup-json"><svg><use href="#i-backup"/></svg>نسخة JSON احتياطية</button>
        <label class="btn btn-ghost" style="cursor:pointer">استعادة من ملف<input type="file" id="restore-file" accept=".json" hidden></label>
      </div>
    </div>
    <div class="section card">
      <h2>ملخص الأرصدة الحالية</h2>
      <div class="cap-row"><span>أحمد</span><b>${fmt(b.ahmed)} جنيه</b></div>
      <div class="cap-row"><span>سامح</span><b ${b.sameh<0?'style="color:var(--red)"':''}>${fmt(b.sameh)} جنيه</b></div>
      <div class="cap-row"><span>الإيجار</span><b>${fmt(b.rent)} جنيه</b></div>
      <div class="cap-row"><span>المبلغ الخاص بسامح</span><b>${fmt(b.priv)} جنيه</b></div>
      <div class="cap-row"><span>النقدية</span><b>${fmt(b.cash)} جنيه</b></div>
    </div>
    ${isOwner() && state.movements.length === 0 ? `
    <div class="section card">
      <h2>البيانات الأولية</h2>
      <div class="sub">الدفتر فارغ — زرع الأرصدة الافتتاحية وحركات نوفمبر المأخوذة من الدفتر الحالي</div>
      <button class="btn btn-green" data-act="seed">زرع البيانات الأولية</button>
    </div>` : ''}`;
  const rf = $('#restore-file');
  if (rf) rf.onchange = restoreJSON;
}

/* ---------- movement modal ---------- */
function openMovementModal(kind, existing) {
  const presets = {
    'add-transfer': 'transfer', 'add-withdraw': 'withdraw_sameh', 'add-rent': 'rent_pay',
    'add-expense': 'expense', 'add-capital': 'capital_add'
  };
  const type = existing ? existing.type : presets[kind] || 'transfer';
  const t = TYPES[type];
  const m = existing || { date: todayISO(), amount: '', note: '', bearer: 'ahmed', person: 'ahmed' };
  const isCap = type.startsWith('capital');
  $('#modal-root').innerHTML = `
    <div class="modal-overlay" id="mov-overlay"><div class="modal">
      <div class="modal-head"><h3>${existing ? 'تعديل' : 'إضافة'} ${isCap ? 'حركة رأس مال' : t.label}</h3>
        <button class="iconbtn" id="mov-close"><svg width="15" height="15"><use href="#i-x"/></svg></button></div>
      <div class="modal-body">
        ${isCap ? `<div class="field"><label>النوع</label><div class="seg" id="f-captype">
          <button data-v="capital_add" class="${type==='capital_add'?'active':''}">إضافة رأس مال</button>
          <button data-v="capital_withdraw" class="${type==='capital_withdraw'?'active':''}">سحب رأس مال</button></div></div>` : ''}
        <div class="field"><label>التاريخ</label><input type="date" id="f-date" value="${m.date}"></div>
        <div class="field"><label>المبلغ (جنيه)</label><input type="number" id="f-amount" min="0" step="any" value="${m.amount ?? ''}" placeholder="0"></div>
        ${t.needsBearer ? `<div class="field"><label>من يتحمل المصروف؟</label><div class="seg" id="f-bearer">
          <button data-v="ahmed" class="${m.bearer==='ahmed'?'active':''}">أحمد</button>
          <button data-v="sameh" class="${m.bearer==='sameh'?'active':''}">سامح</button>
          <button data-v="both" class="${m.bearer==='both'?'active':''}">الاثنين بالنصف</button></div></div>` : ''}
        ${t.needsPerson ? `<div class="field"><label>الطرف</label><div class="seg" id="f-person">
          <button data-v="ahmed" class="${(m.person||'ahmed')==='ahmed'?'active':''}">أحمد</button>
          <button data-v="sameh" class="${m.person==='sameh'?'active':''}">سامح</button></div></div>` : ''}
        <div class="field"><label>البيان / ملاحظة</label><input type="text" id="f-note" value="${esc(m.note || '')}" placeholder="${type==='transfer'?'تحويل سامح يوم …':''}"></div>
        ${type === 'transfer' ? `<div class="split-preview" id="split-preview"></div>` : ''}
        ${t.needsBearer ? `<div class="split-preview" id="split-preview"></div>` : ''}
      </div>
      <div class="modal-foot">
        <button class="btn btn-green" id="mov-save">${existing ? 'حفظ التعديل' : 'إضافة'}</button>
        <button class="btn btn-ghost" id="mov-cancel">إلغاء</button>
      </div>
    </div></div>`;
  let curType = type, curBearer = m.bearer || 'ahmed', curPerson = m.person || 'ahmed';
  const close = () => $('#modal-root').innerHTML = '';
  $('#mov-close').onclick = close; $('#mov-cancel').onclick = close;
  $('#mov-overlay').onclick = e => { if (e.target.id === 'mov-overlay') close(); };
  const bindSeg = (id, fn) => { const el = $(id); if (!el) return;
    [...el.children].forEach(b => b.onclick = () => { [...el.children].forEach(x => x.classList.remove('active')); b.classList.add('active'); fn(b.dataset.v); preview(); }); };
  bindSeg('#f-captype', v => curType = v);
  bindSeg('#f-bearer', v => curBearer = v);
  bindSeg('#f-person', v => curPerson = v);
  const preview = () => {
    const el = $('#split-preview'); if (!el) return;
    const a = Number($('#f-amount').value) || 0;
    if (curType === 'transfer') {
      const d = deltasFor('transfer', a);
      el.innerHTML = `<div class="rowline"><span>سامح</span><b>${fmt(SPLIT.sameh)}</b></div>
        <div class="rowline"><span>الإيجار</span><b>${fmt(SPLIT.rent)}</b></div>
        <div class="rowline"><span>الخاص بسامح</span><b>${fmt(SPLIT.priv)}</b></div>
        <div class="rowline"><span>أحمد (الباقي)</span><b>${fmt(d.dAhmed)}</b></div>`;
    } else if (TYPES[curType]?.needsBearer) {
      const d = deltasFor('expense', a, curBearer);
      el.innerHTML = `<div class="rowline"><span>يخصم من أحمد</span><b>${fmt(-d.dAhmed)}</b></div>
        <div class="rowline"><span>يخصم من سامح</span><b>${fmt(-d.dSameh)}</b></div>`;
    }
  };
  $('#f-amount').oninput = preview; preview();
  $('#mov-save').onclick = async () => {
    const amount = Number($('#f-amount').value);
    if (!amount || amount <= 0) { toast('أدخل مبلغاً صحيحاً', 'error'); return; }
    const data = {
      date: $('#f-date').value || todayISO(), type: curType, label: TYPES[curType].label,
      amount, note: $('#f-note').value.trim(), bearer: curType === 'expense' ? curBearer : null,
      person: curType.startsWith('capital') ? curPerson : null,
      ...deltasFor(curType, amount, curBearer)
    };
    if (existing) Object.assign(existing, data); 
    await saveMovement(existing || data, !existing);
    close(); toast(existing ? 'تم حفظ التعديل' : 'تمت الإضافة', 'success'); route();
  };
}

/* ---------- export / print / backup ---------- */
function exportXlsx() {
  const wb = XLSX.utils.book_new();
  const b = balances();
  const rows = [...state.movements].reverse().map(m => ({
    'التاريخ': m.date, 'البيان': m.note || TYPES[m.type]?.label, 'النوع': TYPES[m.type]?.label,
    'أحمد': m.dAhmed || 0, 'سامح': m.dSameh || 0, 'الإيجار': m.dRent || 0, 'الخاص': m.dPriv || 0,
    'المبلغ': m.amount ?? '', 'المتحمل': m.bearer ? BEARER_LABEL[m.bearer] : '' }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'الحركات');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { 'الطرف': 'أحمد', 'الرصيد': b.ahmed }, { 'الطرف': 'سامح', 'الرصيد': b.sameh },
    { 'الطرف': 'الإيجار', 'الرصيد': b.rent }, { 'الطرف': 'الخاص بسامح', 'الرصيد': b.priv },
    { 'الطرف': 'النقدية', 'الرصيد': b.cash }]), 'الأرصدة');
  XLSX.writeFile(wb, `دفتر-الدخل-${todayISO()}.xlsx`);
  toast('تم تنزيل ملف Excel', 'success');
}
function backupJSON() {
  const blob = new Blob([JSON.stringify({ movements: state.movements, partners: state.partners }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `نسخة-احتياطية-دفتر-الدخل-${todayISO()}.json`;
  a.click();
  toast('تم تنزيل النسخة الاحتياطية', 'success');
}
async function restoreJSON(e) {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.movements)) throw 0;
    if (!confirm(`استعادة ${data.movements.length} حركة؟ سيتم دمجها مع البيانات الحالية.`)) return;
    for (const m of data.movements) {
      const { id, ...rest } = m;
      await saveMovement(rest, true);
    }
    toast('تمت الاستعادة', 'success'); route();
  } catch { toast('ملف غير صالح', 'error'); }
}

/* ---------- global click delegation ---------- */
document.addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act) {
    if (['add-transfer','add-withdraw','add-rent','add-expense','add-capital'].includes(act)) openMovementModal(act);
    else if (act === 'export-xlsx') exportXlsx();
    else if (act === 'backup-json') backupJSON();
    else if (act === 'print') window.print();
    else if (act === 'seed') {
      if (confirm('زرع الأرصدة الافتتاحية وحركات نوفمبر في الدفتر؟')) {
        toast('جاري زرع البيانات…');
        await runSeed(); toast('تم زرع البيانات الأولية', 'success'); route();
      }
    }
    else if (act === 'add-partner') {
      const v = $('#partner-email').value.trim();
      if (!v || !v.includes('@')) { toast('أدخل بريداً صحيحاً', 'error'); return; }
      await savePartners([...new Set([...state.partners, v])]);
      toast('تمت إضافة الشريك — يدخل بحساب جوجل الخاص به', 'success'); renderAdmin();
    }
    return;
  }
  const rm = e.target.closest('[data-rm-partner]')?.dataset.rmPartner;
  if (rm) { await savePartners(state.partners.filter(x => x !== rm)); renderAdmin(); return; }
  const editId = e.target.closest('[data-edit]')?.dataset.edit;
  if (editId) { const m = state.movements.find(x => x.id === editId); if (m) openMovementModal(null, m); return; }
  const delId = e.target.closest('[data-del]')?.dataset.del;
  if (delId) {
    const m = state.movements.find(x => x.id === delId);
    if (m && confirm(`حذف: ${m.label || TYPES[m.type].label} بمبلغ ${fmt(m.amount)}؟`)) {
      await removeMovement(m); toast('تم الحذف', 'success'); route();
    }
  }
});
$('#global-search').onclick = () => { location.hash = '#/movements'; };

/* ---------- boot ---------- */
initAuth();
