/* ================= Expenzo SPA ================= */

const state = {
  token: localStorage.getItem('expenzo_token') || null,
  user: null,
  meta: null,          // { currencies, categories }
  accounts: [],
  txType: 'expense',
  txAccount: null,
  txCategory: null,
  liabAccount: null,
  receivableAccount: null,
  regCurrency: 'AFN',
  chat: []
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function api(path, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Timezone-Offset': String(new Date().getTimezoneOffset())
  };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch('/api' + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.user) { doLogout(); }
    throw new Error(data.error || 'Something went wrong');
  }
  return data;
}

// ---------- toasts ----------
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 4200);
}

// ---------- formatting ----------
const curOf = (code) => state.meta?.currencies?.[code] || { symbol: code + ' ' };
function fmtBase(usd) {
  const c = curOf(state.user.currency);
  return c.symbol + (usd).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function fmtNative(amount, code) {
  return curOf(code).symbol + amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function transactionMeta(transaction) {
  const special = {
    money_owed_to_user: { label: 'owed to you', icon: '🤝', tone: 'amber', rowClass: 'owed' },
    money_returned: { label: 'paid back', icon: '↩️', tone: 'cyan', rowClass: 'paid-back' },
    liability_payment: { label: 'debt payment', icon: '🧾', tone: 'violet', rowClass: 'debt-payment' }
  }[transaction.ledgerKind];
  return special || (transaction.type === 'income'
    ? { label: 'income', icon: '💰', tone: 'green', rowClass: 'income' }
    : { label: 'expense', icon: '💸', tone: 'red', rowClass: 'expense' });
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const todayStr = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
function prettyDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function md(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^- /gm, '• '); }

// ================= CUSTOM DROPDOWN (styled select) =================
function customSelect(mount, { options, value, onChange, placeholder = 'Select…' }) {
  const api = {
    _options: options || [],
    _value: value ?? null,
    _open: false,
    setOptions(options) { this._options = options; if (!options.some((o) => o.value === this._value)) this._value = options[0]?.value ?? null; render(); },
    setValue(v) { this._value = v; render(); },
    get value() { return this._value; }
  };

  mount.innerHTML = '';
  mount.classList.add('csel');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'csel-btn';
  const list = document.createElement('div');
  list.className = 'csel-list';
  mount.append(btn, list);

  function render() {
    const cur = api._options.find((o) => o.value === api._value);
    btn.innerHTML = cur
      ? `<span>${cur.icon ? `<span class="csel-ico">${cur.icon}</span>` : ''}<span><b>${esc(cur.label)}</b>${cur.sub ? `<small>${esc(cur.sub)}</small>` : ''}</span></span><span class="csel-arrow">▾</span>`
      : `<span class="csel-ph">${esc(placeholder)}</span><span class="csel-arrow">▾</span>`;
    list.innerHTML = api._options.map((o) => `
      <button type="button" class="csel-it ${o.value === api._value ? 'on' : ''}" data-v="${esc(o.value)}">
        ${o.icon ? `<span class="csel-ico">${o.icon}</span>` : ''}
        <span><b>${esc(o.label)}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</span>
        ${o.value === api._value ? '<span class="csel-check">✓</span>' : ''}
      </button>`).join('');
    list.style.display = api._open ? 'block' : 'none';
    btn.classList.toggle('open', api._open);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllSelects(mount);
    api._open = !api._open;
    render();
  });
  list.addEventListener('click', (e) => {
    const it = e.target.closest('.csel-it');
    if (!it) return;
    e.stopPropagation();
    let v = it.dataset.v;
    const opt = api._options.find((o) => String(o.value) === String(v));
    if (opt && opt.value !== undefined) v = opt.value;
    api._value = v;
    api._open = false;
    render();
    onChange?.(v);
  });
  render();
  return api;
}
function closeAllSelects(except) {
  $$('.csel').forEach((m) => {
    if (m === except) return;
    const l = m.querySelector('.csel-list');
    if (l) l.style.display = 'none';
  });
}
document.addEventListener('click', () => closeAllSelects());

// ================= AUTH =================
function switchAuth(which) {
  $('#tabLogin').classList.toggle('on', which === 'login');
  $('#tabRegister').classList.toggle('on', which === 'register');
  $('#loginForm').style.display = which === 'login' ? '' : 'none';
  $('#registerForm').style.display = which === 'register' ? '' : 'none';
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { token, user } = await api('/login', { method: 'POST', body: { email: $('#li_email').value, password: $('#li_pass').value } });
    state.token = token; localStorage.setItem('expenzo_token', token);
    await enterApp(user);
    toast('welcome back, ' + esc(user.name.split(' ')[0]) + ' 💜', 'ok');
  } catch (err) { toast(esc(err.message), 'err'); }
});

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/register', { method: 'POST', body: {
      name: $('#rg_name').value, email: $('#rg_email').value,
      password: $('#rg_pass').value, currency: state.regCurrency
    }});
    toast(esc(r.message), 'ok');
    switchAuth('login');
    $('#li_email').value = $('#rg_email').value;
  } catch (err) { toast(esc(err.message), 'err'); }
});

async function logout() { try { await api('/logout', { method: 'POST' }); } catch {} doLogout(); }
function doLogout() {
  state.token = null;
  state.user = null;
  state.accounts = [];
  state.chat = [];
  state.txAccount = null;
  state.txCategory = null;
  state.liabAccount = null;
  state.receivableAccount = null;
  txAccountSel = null;
  txCategorySel = null;
  liabAccountSel = null;
  receivableAccountSel = null;
  receiveAccountSel = null;
  receivablesCache = [];
  liabilitiesCache = [];
  acCurrencySel = null;
  window.__alerts = null;
  window.__summary = null;
  localStorage.removeItem('expenzo_token');
  $('#appView').classList.remove('on');
  $('#authView').style.display = 'grid';
}

// ================= BOOT =================
async function boot() {
  state.meta = await fetch('/api/meta').then((r) => r.json());
  renderRegCurrency();

  if (state.token) {
    try {
      const { user } = await api('/me');
      await enterApp(user);
      return;
    } catch { state.token = null; localStorage.removeItem('expenzo_token'); }
  }
  $('#authView').style.display = 'grid';
}

function renderRegCurrency() {
  customSelect($('#rg_currency'), {
    options: Object.entries(state.meta.currencies).map(([code, c]) => ({
      value: code, label: `${code} — ${c.name}`, icon: c.symbol
    })),
    value: state.regCurrency,
    onChange: (v) => { state.regCurrency = v; }
  });
}

async function enterApp(user) {
  state.user = user;
  $('#authView').style.display = 'none';
  $('#appView').classList.add('on');
  const roleText = user.role === 'admin' ? 'admin 🛡️' : user.currency + ' account';
  $('#userName').textContent = user.name;
  $('#userRole').textContent = roleText;
  $('#userAvatar').textContent = user.name[0].toUpperCase();
  // mobile account bar (sidebar is hidden on small screens)
  $('#mUserName').textContent = user.name;
  $('#mUserRole').textContent = roleText;
  $('#mAvatar').textContent = user.name[0].toUpperCase();
  $('#navAdmin').style.display = user.role === 'admin' ? '' : 'none';
  $('#navAdminBottom').style.display = user.role === 'admin' ? '' : 'none';
  await refreshAccounts();
  if (!location.hash || location.hash === '#/') location.hash = '#/dashboard';
  route();
  refreshBadges();
  setInterval(refreshBadges, 60000);
}

async function refreshAccounts() {
  try {
    const accs = await api('/accounts');
    state.accounts = accs.accounts;
  } catch {}
}

// ================= ROUTER =================
const routes = {
  dashboard:   { title: 'Dashboard',   sub: 'your money at a glance ✨',    render: renderDashboard },
  transactions:{ title: 'Transactions', sub: 'every buck, tracked 💳',      render: renderTransactions },
  receivables: { title: 'Money with others', sub: 'track what people owe you 👥', render: renderReceivables },
  liabilities: { title: 'Liabilities',  sub: 'debts & due dates 🧾',         render: renderLiabilities },
  forecast:    { title: 'Forecast',     sub: 'the future, predicted 📈',     render: renderForecast },
  assistant:   { title: 'Zeno AI',      sub: 'your financial bestie 🤖',     render: renderAssistant },
  admin:       { title: 'Admin',        sub: 'verify your users 🛡️',         render: renderAdmin }
};

async function route() {
  const name = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  const r = routes[name] || routes.dashboard;
  if (name === 'admin' && state.user?.role !== 'admin') { location.hash = '#/dashboard'; return; }
  $$('.view').forEach((v) => (v.style.display = 'none'));
  const target = $('#view-' + name);
  (target || $('#view-dashboard')).style.display = '';
  $('#pageTitle').textContent = r.title;
  $('#pageSub').textContent = r.sub;
  $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));
  try { await r.render(); } catch (e) { toast(esc(e.message), 'err'); }
  if (name === 'assistant') setTimeout(() => $('#chatInput')?.focus(), 100);
}
window.addEventListener('hashchange', route);

// ================= BADGES / BELL =================
async function refreshBadges() {
  try {
    const s = await api('/summary');
    const n = s.alerts.all.length;
    $('#bellDot').style.display = n ? '' : 'none';
    $('#navLiabDot').style.display = n ? '' : 'none';
    $('#navLiabDot').textContent = n;
    if (state.user.role === 'admin') {
      const st = await api('/admin/stats');
      $('#navAdminDot').style.display = st.pending ? '' : 'none';
      $('#navAdminDot').textContent = st.pending;
    }
    window.__alerts = s.alerts;
    window.__summary = s;
  } catch {}
}

function toggleBell(e) {
  e.stopPropagation();
  const pop = $('#bellPop');
  const a = window.__alerts || { overdue: [], dueSoon: [] };
  let html = '<div style="font-weight:700;font-family:var(--font-head);margin-bottom:8px">Due-date alerts ⏰</div>';
  if (!a.all?.length) html += '<div class="it" style="color:var(--muted)">nothing due this week. stay glowing ✨</div>';
  for (const l of [...(a.overdue || []), ...(a.dueSoon || [])]) {
    html += `<div class="it">${l.level === 'overdue' ? '🔴' : '🟡'} <div><b>${esc(l.name)}</b> — ${fmtNative(l.nativeAmount ?? l.amount, l.currency)}<small>${l.level === 'overdue' ? `overdue by ${-l.daysLeft} day${-l.daysLeft !== 1 ? 's' : ''}` : `due in ${l.daysLeft} day${l.daysLeft !== 1 ? 's' : ''}`} (${prettyDate(l.dueDate)})</small></div></div>`;
  }
  pop.innerHTML = html;
  pop.classList.toggle('on');
}
document.addEventListener('click', (e) => { if (!e.target.closest('.bell')) $('#bellPop')?.classList.remove('on'); });

// ================= DASHBOARD =================
async function renderDashboard() {
  const [s, f] = await Promise.all([api('/summary'), api('/forecast')]);
  state.accounts = s.accounts;
  const months = [...f.history.slice(-5), ...(f.future.slice(0, 1))];
  const maxBar = Math.max(...months.map((m) => Math.max(m.expense, 1)), 1);

  const accCard = (a) => `
    <div class="card acc-card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <h3 style="font-size:15px">${esc(a.name)}</h3>
        <span class="pill cyan">${a.currency}</span>
      </div>
      <div class="amt">${fmtNative(a.nativeBalance, a.currency)}</div>
      <div class="due">Balance kept in ${a.currency} only</div>
      ${state.accounts.length > 1 ? `<button class="icon-btn acc-del" title="delete wallet" onclick="delAccount(${a.id})">🗑</button>` : ''}
    </div>`;

  const alertsHtml = s.alerts.all.length
    ? s.alerts.overdue.map((l) => `
        <div class="alert-item overdue">🔴 <div><b>${esc(l.name)}</b> — overdue by ${-l.daysLeft}d · ${fmtNative(l.nativeAmount ?? l.amount, l.currency)}<br/><small>due ${prettyDate(l.dueDate)}</small></div>
        <button class="btn sm danger" style="margin-left:auto" onclick="payLiab(${l.id})">Pay</button></div>`).join('')
      + s.alerts.dueSoon.map((l) => `
        <div class="alert-item due-soon">🟡 <div><b>${esc(l.name)}</b> — due in ${l.daysLeft}d · ${fmtNative(l.nativeAmount ?? l.amount, l.currency)}<br/><small>${prettyDate(l.dueDate)}</small></div>
        <button class="btn sm ghost" style="margin-left:auto" onclick="payLiab(${l.id})">Pay</button></div>`).join('')
    : `<div class="alert-item" style="background:rgba(52,211,153,.07);border:1px solid rgba(52,211,153,.25)">🧼 <div><b>All clear!</b><br/><small>no overdue or upcoming liabilities in the next 7 days</small></div></div>`;

  const txRow = (t) => {
    const acc = state.accounts.find((a) => a.id === t.accountId);
    const meta = transactionMeta(t);
    return `
    <div class="tx-row">
      <div class="tx-ico ${meta.rowClass}">${meta.icon}</div>
      <div class="tx-mid"><div class="t">${esc(t.note || t.category)}</div>
      <div class="s">${esc(acc?.name || 'wallet')} · ${meta.label} · ${prettyDate(t.date)}${t.isFuture ? ' · <span style="color:var(--cyan)">scheduled</span>' : ''}</div></div>
      <div class="tx-amt ${meta.rowClass}">${t.type === 'income' ? '+' : '−'}${fmtNative(t.amount, t.currency)}</div>
    </div>`;
  };

  const liabilitySummary = s.liabilityTotals.length
    ? s.liabilityTotals.map((group) => fmtNative(group.amount, group.currency)).join(' · ')
    : fmtNative(0, state.user.currency);
  const receivableSummary = s.receivableTotals.length
    ? s.receivableTotals.map((group) => fmtNative(group.amount, group.currency)).join(' · ')
    : fmtNative(0, state.user.currency);

  $('#view-dashboard').innerHTML = `
    <div class="dash-actions fade-in">
      <button class="btn sm" onclick="openTxModalFor('expense')">＋ Expense</button>
      <button class="btn sm ghost" onclick="openTxModalFor('income')">＋ Income</button>
      <a class="btn sm ghost" href="#/receivables">👥 Track owed</a>
      <a class="btn sm ghost" href="#/liabilities">🧾 Add liability</a>
    </div>

    <div class="dash-overview fade-in">
      <div class="card glow dash-balance">
        <div class="dash-balance-top">
          <div>
            <div class="eyebrow">Available balance</div>
            <div class="amount grad-text">${fmtBase(s.balance)}</div>
          </div>
          <span class="pill violet">${state.user.currency}</span>
        </div>
        <div class="balance-note">Across ${s.accounts.filter((a) => a.currency === state.user.currency).length} ${state.user.currency} wallet${s.accounts.filter((a) => a.currency === state.user.currency).length !== 1 ? 's' : ''}. Other currencies stay separate.</div>
        <div class="spark compact">${months.map((m) => `
          <div class="bar-w"><div class="bar" style="height:${Math.max(6, (m.expense / maxBar) * 100)}%" title="${m.label}: ${fmtBase(m.expense)} cash outflow"></div><div class="bl">${m.label.split(' ')[0]}</div></div>`).join('')}
        </div>
      </div>

      <div class="dash-metrics">
        <div class="card dash-metric income-metric">
          <div class="metric-icon">↗</div><div><div class="k">Income this month</div><div class="v">${fmtBase(s.incomeThisMonth)}</div><div class="d">${fmtBase(s.incomeAll)} all-time</div></div>
        </div>
        <div class="card dash-metric expense-metric">
          <div class="metric-icon">↘</div><div><div class="k">Spent this month</div><div class="v">${fmtBase(s.expenseThisMonth)}</div><div class="d">${fmtBase(s.expenseAll)} all-time</div></div>
        </div>
        <a class="card dash-metric owed-metric" href="#/receivables">
          <div class="metric-icon">🤝</div><div><div class="k">Owed to you</div><div class="v">${receivableSummary}</div><div class="d">${s.receivablesCount} open record${s.receivablesCount === 1 ? '' : 's'}</div></div>
        </a>
        <a class="card dash-metric liability-metric" href="#/liabilities">
          <div class="metric-icon">🧾</div><div><div class="k">You owe</div><div class="v">${liabilitySummary}</div><div class="d">${s.liabilitiesCount} open liabilit${s.liabilitiesCount === 1 ? 'y' : 'ies'}</div></div>
        </a>
      </div>
    </div>

    <div class="sec-head dash-section-head">
      <div><h3>Wallets</h3><p>Each currency keeps its own balance</p></div>
      <span class="lnk" onclick="openAccountModal()">＋ New wallet</span>
    </div>
    <div class="liab-grid dash-wallets fade-in">${s.accounts.map(accCard).join('')}</div>

    <div class="dash-content fade-in">
      <section>
        <div class="sec-head dash-section-head"><div><h3>Recent activity</h3><p>Your latest wallet movements</p></div><a href="#/transactions">View all →</a></div>
        <div class="card activity-card">${s.recent.length ? s.recent.map(txRow).join('') : '<div class="empty"><div class="big">🪙</div>Nothing yet — add your first transaction.</div>'}</div>
      </section>
      <aside>
        <div class="sec-head dash-section-head"><div><h3>Due soon</h3><p>Liability reminders</p></div><a href="#/liabilities">View all →</a></div>
        <div class="alert-band">${alertsHtml}</div>
      </aside>
    </div>

    ${s.scheduledTx.length ? `<div class="dash-scheduled fade-in">
      <div class="sec-head dash-section-head"><div><h3>Older scheduled entries</h3><p>Future-dated records from an earlier version</p></div></div>
      <div class="card">${s.scheduledTx.map(txRow).join('')}</div>
    </div>` : ''}`;
}

function openTxModalFor(type) {
  state.txType = type;
  openTxModal();
}

// ---------- wallets ----------
let acCurrencySel = null;
function openAccountModal() {
  const used = new Set(state.accounts.map((a) => a.currency));
  const firstFree = Object.keys(state.meta.currencies).find((c) => !used.has(c)) || state.user.currency;
  acCurrencySel = customSelect($('#ac_currency'), {
    options: Object.entries(state.meta.currencies).map(([code, c]) => ({
      value: code, label: `${code} — ${c.name}`, icon: c.symbol
    })),
    value: firstFree
  });
  $('#accountModal').classList.add('on');
  $('#ac_name').focus();
}

async function saveAccount() {
  try {
    await api('/accounts', { method: 'POST', body: { name: $('#ac_name').value, currency: acCurrencySel?.value } });
    closeModal('accountModal');
    $('#ac_name').value = '';
    await refreshAccounts();
    toast('wallet created 🪙 it shows up on your dashboard now', 'ok');
    route();
  } catch (e) { toast(esc(e.message), 'err'); }
}

async function delAccount(id) {
  if (!confirm('Delete this wallet?')) return;
  try { await api('/accounts/' + id, { method: 'DELETE' }); await refreshAccounts(); toast('wallet deleted', 'ok'); route(); }
  catch (e) { toast(esc(e.message), 'err'); }
}

// ================= TRANSACTIONS =================
let txFilters = { type: '', q: '' };
async function renderTransactions() {
  const qs = new URLSearchParams();
  if (txFilters.type) qs.set('type', txFilters.type);
  if (txFilters.q) qs.set('q', txFilters.q);
  const { transactions } = await api('/transactions?' + qs.toString());

  $('#view-transactions').innerHTML = `
    <div class="filters fade-in">
      <select id="fltType" onchange="txFilters.type=this.value;route()">
        <option value="">All types</option><option value="income">💰 Income</option><option value="expense">💸 Expense</option>
      </select>
      <input id="fltQ" placeholder="🔍 search note or category…" value="${esc(txFilters.q)}" onkeydown="if(event.key==='Enter'){txFilters.q=this.value;route()}"/>
      <button class="btn" onclick="openTxModal()">＋ New transaction</button>
    </div>
    <div class="card tbl-wrap mobile-table-wrap fade-in">
      ${transactions.length ? `
      <table class="tbl mobile-card-table transaction-table">
        <thead><tr><th>Date</th><th>Type</th><th>Wallet</th><th>Category</th><th>Note</th><th class="right">Amount</th><th></th></tr></thead>
        <tbody>${transactions.map((t) => {
          const acc = state.accounts.find((a) => a.id === t.accountId);
          const meta = transactionMeta(t);
          return `
          <tr>
            <td data-label="Date" class="mono">${prettyDate(t.date)}${t.isFuture ? ' <span class="pill cyan">scheduled</span>' : ''}</td>
            <td data-label="Type"><span class="pill ${meta.tone}">${meta.label}</span></td>
            <td data-label="Wallet">${esc(acc?.name || '—')} <span class="pill gray">${t.currency}</span></td>
            <td data-label="Category">${t.ledgerKind ? '—' : esc(t.category)}</td>
            <td data-label="Note" style="color:var(--muted)">${esc(t.note || '—')}</td>
            <td data-label="Amount" class="right mono" style="font-weight:700;color:var(--text)">${t.type === 'income' ? '+' : '−'}${fmtNative(t.amount, t.currency)}</td>
            <td data-label="Actions"><div class="row-actions"><button class="icon-btn" title="delete" onclick="delTx(${t.id})">🗑</button></div></td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : '<div class="empty"><div class="big">🗃️</div>no transactions match. add one!</div>'}
    </div>`;
  $('#fltType').value = txFilters.type;
}

let txAccountSel = null, txCategorySel = null;

async function openTxModal() {
  await refreshAccounts();
  setTxType(state.txType || 'expense');
  $('#tx_date').value = todayStr();
  $('#tx_date').max = todayStr();
  $('#txModal').classList.add('on');
  $('#tx_amount').focus();
  updateBalanceHint();
}
function closeModal(id) { $('#' + id).classList.remove('on'); }
$$('.modal-bg').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('on'); }));

function setTxType(t, keepAccount = false) {
  state.txType = t;
  $('#segIncome').classList.toggle('on', t === 'income');
  $('#segExpense').classList.toggle('on', t === 'expense');
  const cats = state.meta.categories[t];
  const acc = state.accounts.find((a) => a.id === (txAccountSel?.value ?? state.txAccount));
  txCategorySel = customSelect($('#tx_category'), {
    options: cats.map((c) => ({ value: c, label: c, icon: c === 'Liability' ? '🧾' : '' })),
    value: state.txCategory && cats.includes(state.txCategory) ? state.txCategory : cats[0],
    onChange: (v) => { state.txCategory = v; }
  });
  state.txCategory = txCategorySel.value;

  if (!keepAccount || !txAccountSel) {
    const def = acc || state.accounts[0];
    txAccountSel = customSelect($('#tx_account'), {
      options: state.accounts.map((a) => ({
        value: a.id, label: a.name, icon: curOf(a.currency).symbol,
        sub: `${a.currency} · balance ${fmtNative(a.nativeBalance, a.currency)}`
      })),
      value: def?.id ?? null,
      onChange: (v) => { state.txAccount = v; updateBalanceHint(); }
    });
    state.txAccount = txAccountSel.value;
  }
  updateBalanceHint();
}

async function updateBalanceHint() {
  try {
    const acc = state.accounts.find((a) => a.id === Number(txAccountSel?.value ?? state.txAccount));
    if (!acc) { $('#tx_balanceHint').textContent = ''; return; }
    $('#tx_balanceHint').innerHTML = `<b style="color:var(--green)">${esc(acc.name)}</b> has <b style="color:var(--green)">${fmtNative(acc.nativeBalance, acc.currency)}</b> · entries save in <b>${acc.currency}</b> · expenses can't overdraw the wallet 🚫`;
  } catch {}
}
document.addEventListener('change', (e) => { if (e.target.id === 'tx_date') { /* max already enforced */ } });

async function saveTx() {
  try {
    const localToday = todayStr();
    $('#tx_date').max = localToday;
    if (!$('#tx_date').value || $('#tx_date').value > localToday) {
      throw new Error("Dates can't be in the future — pick today or earlier 📅");
    }
    const body = {
      type: state.txType,
      amount: $('#tx_amount').value,
      accountId: txAccountSel?.value ?? state.txAccount,
      category: txCategorySel?.value,
      date: $('#tx_date').value,
      note: $('#tx_note').value
    };
    const { transaction } = await api('/transactions', { method: 'POST', body });
    closeModal('txModal');
    ['#tx_amount', '#tx_note'].forEach((s) => ($(s).value = ''));
    toast(`${transaction.type === 'income' ? '💰 income' : '💸 expense'} saved — ${fmtNative(transaction.amount, transaction.currency)}`, 'ok');
    route(); refreshBadges();
  } catch (e) { toast(esc(e.message), 'err'); }
}

async function delTx(id) {
  if (!confirm('Delete this transaction?')) return;
  try { await api('/transactions/' + id, { method: 'DELETE' }); toast('transaction deleted', 'ok'); route(); refreshBadges(); }
  catch (e) { toast(esc(e.message), 'err'); }
}

// ================= MONEY WITH OTHERS =================
let receivableAccountSel = null;
let receiveAccountSel = null;
let receivableReturnId = null;
let receivablesCache = [];
let receivableSaving = false;
let receivablePaymentSaving = false;

async function renderReceivables() {
  await refreshAccounts();
  const { receivables } = await api('/receivables');
  receivablesCache = receivables;
  const accountName = (id) => state.accounts.find((a) => a.id === id)?.name || 'wallet';
  const outstanding = receivables.filter((r) => r.status === 'outstanding');
  const returned = receivables.filter((r) => r.status === 'returned');
  const totals = Object.values(outstanding.reduce((all, item) => {
    const group = all[item.currency] ||= { currency: item.currency, amount: 0, count: 0 };
    group.amount += item.remainingAmount;
    group.count += 1;
    return all;
  }, {}));
  const card = (item) => `
    <div class="card liab-card ${item.status === 'returned' ? 'paid' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <h3 style="font-size:16px">${esc(item.person)}</h3>
        ${item.status === 'returned' ? '<span class="pill green">✓ paid back</span>' : '<span class="pill amber">waiting</span>'}
      </div>
      <div class="amt">${fmtNative(item.status === 'returned' ? item.amount : item.remainingAmount, item.currency)}${item.status === 'outstanding' ? ' remaining' : ''}</div>
      <div class="due">${esc(item.reason)}</div>
      <div class="due">original ${fmtNative(item.amount, item.currency)} · paid ${fmtNative(item.paidAmount, item.currency)}</div>
      <div class="due">given ${prettyDate(item.date)} from ${esc(accountName(item.sourceAccountId))}${item.returnedDate ? ` · fully returned ${prettyDate(item.returnedDate)}` : ''}</div>
      ${item.payments.length ? `<div class="payment-history">${item.payments.map((p) =>
        `<span>${prettyDate(p.date)} · +${fmtNative(p.amount, item.currency)} to ${esc(accountName(p.accountId))}</span>`).join('')}</div>` : ''}
      <div class="acts">
        ${item.status === 'outstanding'
          ? `<button class="btn sm" onclick="openReceiveMoney(${item.id})">Add payment</button>` : ''}
        ${item.paidAmount > 0 ? `<button class="btn sm ghost" onclick="reopenReceivable(${item.id})">Undo last payment</button>` : ''}
        <button class="btn sm ghost" onclick="deleteReceivable(${item.id})">Delete</button>
      </div>
    </div>`;
  $('#view-receivables').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:16px" class="fade-in">
      <button class="btn" onclick="openReceivableModal()">＋ Add money record</button>
    </div>
    ${totals.length ? `<div class="grid cols-3 fade-in" style="margin-bottom:20px">${totals.map((t) => `
      <div class="card stat"><div class="k">Owed to you · ${t.currency}</div><div class="v">${fmtNative(t.amount, t.currency)}</div><div class="d">${t.count} open record${t.count === 1 ? '' : 's'}</div></div>`).join('')}</div>` : ''}
    ${outstanding.length ? `<div class="liab-grid fade-in">${outstanding.map(card).join('')}</div>`
      : `<div class="empty fade-in"><div class="big">🤝</div>no money is currently with other people</div>`}
    ${returned.length ? `<div class="sec-head"><h3>Paid back</h3></div><div class="liab-grid fade-in">${returned.map(card).join('')}</div>` : ''}`;
}

async function openReceivableModal() {
  await refreshAccounts();
  receivableAccountSel = customSelect($('#rc_account'), {
    options: state.accounts.map((a) => ({
      value: a.id, label: a.name, icon: curOf(a.currency).symbol,
      sub: `${a.currency} · balance ${fmtNative(a.nativeBalance, a.currency)}`
    })),
    value: state.receivableAccount ?? state.accounts[0]?.id ?? null,
    onChange: (v) => { state.receivableAccount = v; }
  });
  state.receivableAccount = receivableAccountSel.value;
  const localToday = todayStr();
  $('#rc_date').value = localToday;
  $('#rc_date').max = localToday;
  $('#receivableModal').classList.add('on');
  $('#rc_person').focus();
}

async function saveReceivable() {
  if (receivableSaving) return;
  receivableSaving = true;
  const saveButton = $('#saveReceivableBtn');
  if (saveButton) saveButton.disabled = true;
  try {
    const localToday = todayStr();
    $('#rc_date').max = localToday;
    if (!$('#rc_date').value || $('#rc_date').value > localToday) {
      throw new Error("Dates can't be in the future — pick today or earlier 📅");
    }
    await api('/receivables', { method: 'POST', body: {
      person: $('#rc_person').value,
      reason: $('#rc_reason').value,
      amount: $('#rc_amount').value,
      accountId: receivableAccountSel?.value,
      date: $('#rc_date').value
    }});
    closeModal('receivableModal');
    ['#rc_person', '#rc_reason', '#rc_amount'].forEach((s) => ($(s).value = ''));
    toast('record saved — amount subtracted from the wallet', 'ok');
    route(); refreshBadges();
  } catch (e) {
    toast(esc(e.message), 'err');
  } finally {
    receivableSaving = false;
    if (saveButton) saveButton.disabled = false;
  }
}

async function openReceiveMoney(id) {
  const item = receivablesCache.find((r) => r.id === id);
  if (!item) return;
  await refreshAccounts();
  const matching = state.accounts.filter((a) => a.currency === item.currency);
  if (!matching.length) return toast(`Create a ${item.currency} wallet before receiving this money`, 'err');
  receivableReturnId = id;
  $('#receiveMoneyText').textContent = `${item.person} still owes ${fmtNative(item.remainingAmount, item.currency)}. Enter the amount received.`;
  $('#rc_receive_amount').value = item.remainingAmount;
  $('#rc_receive_amount').max = item.remainingAmount;
  receiveAccountSel = customSelect($('#rc_receive_account'), {
    options: matching.map((a) => ({
      value: a.id, label: a.name, icon: curOf(a.currency).symbol,
      sub: `${a.currency} · balance ${fmtNative(a.nativeBalance, a.currency)}`
    })),
    value: matching.find((a) => a.id === item.sourceAccountId)?.id ?? matching[0].id,
    onChange: () => {}
  });
  $('#receiveMoneyModal').classList.add('on');
}

async function confirmReceivablePaid() {
  if (receivablePaymentSaving) return;
  receivablePaymentSaving = true;
  const paymentButton = $('#confirmReceivablePaidBtn');
  if (paymentButton) paymentButton.disabled = true;
  try {
    await api('/receivables/' + receivableReturnId, {
      method: 'PATCH', body: {
        status: 'returned',
        amount: $('#rc_receive_amount').value,
        accountId: receiveAccountSel?.value
      }
    });
    closeModal('receiveMoneyModal');
    toast('payment added to the selected wallet balance 💰', 'ok');
    route(); refreshBadges();
  } catch (e) {
    toast(esc(e.message), 'err');
  } finally {
    receivablePaymentSaving = false;
    if (paymentButton) paymentButton.disabled = false;
  }
}

async function reopenReceivable(id) {
  try {
    await api('/receivables/' + id, { method: 'PATCH', body: { status: 'outstanding' } });
    toast('last payment undone — linked income removed', 'ok');
    route(); refreshBadges();
  } catch (e) { toast(esc(e.message), 'err'); }
}

async function deleteReceivable(id) {
  if (!confirm('Delete this money record and its linked wallet entries?')) return;
  try {
    await api('/receivables/' + id, { method: 'DELETE' });
    toast('money record deleted', 'ok');
    route(); refreshBadges();
  } catch (e) { toast(esc(e.message), 'err'); }
}

// ================= LIABILITIES =================
let liabAccountSel = null;
let liabPayWalletSel = null;
let liabilitiesCache = [];
let activeLiabilityId = null;
let liabPaymentSaving = false;

async function renderLiabilities() {
  await refreshAccounts();
  const { liabilities } = await api('/liabilities');
  liabilitiesCache = liabilities;
  const accName = (id) => state.accounts.find((a) => a.id === id)?.name || 'wallet';
  const card = (l) => {
    const badge = l.status === 'paid' ? '<span class="pill green">✓ paid</span>'
      : l.daysLeft < 0 ? `<span class="pill red">🔴 overdue ${-l.daysLeft}d</span>`
      : l.daysLeft <= 7 ? `<span class="pill amber">🟡 due in ${l.daysLeft}d</span>`
      : `<span class="pill cyan">📅 due ${prettyDate(l.dueDate)}</span>`;
    return `
      <div class="card liab-card ${l.status === 'paid' ? 'paid' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <h3 style="font-size:16px">${esc(l.name)}</h3>${badge}
        </div>
        <div class="amt">${fmtNative(l.status === 'paid' ? l.amount : l.remainingAmount, l.currency)}${l.status === 'unpaid' ? ' remaining' : ''}</div>
        <div class="due">to: ${esc(l.creditor || 'Not specified')} · ${esc(l.name)}</div>
        <div class="due">original ${fmtNative(l.amount, l.currency)} · paid ${fmtNative(l.paidAmount, l.currency)}</div>
        <div class="due">wallet: ${esc(accName(l.accountId))} · due ${prettyDate(l.dueDate)}${l.status === 'paid' && l.paidDate ? ` · paid ${prettyDate(l.paidDate)}` : ''}</div>
        ${l.payments.length ? `<div class="payment-history">${l.payments.map((p) =>
          `<span>${prettyDate(p.date)} · −${fmtNative(p.amount, l.currency)} from ${esc(accName(p.accountId))}</span>`).join('')}</div>` : ''}
        <div class="acts">
          ${l.status === 'unpaid' ? `<button class="btn sm" onclick="payLiab(${l.id})">Add payment</button>` : ''}
          ${l.paidAmount > 0 ? `<button class="btn sm ghost" onclick="unpayLiab(${l.id})">Undo last payment</button>` : ''}
          <button class="btn sm ghost" onclick="openLiabDueDate(${l.id})">Adjust due date</button>
          <button class="btn sm ghost" onclick="delLiab(${l.id})">Delete</button>
        </div>
      </div>`;
  };
  const unpaid = liabilities.filter((l) => l.status === 'unpaid');
  const paid = liabilities.filter((l) => l.status === 'paid');
  $('#view-liabilities').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:16px" class="fade-in">
      <button class="btn" onclick="openLiabModal()">＋ New liability</button>
    </div>
    ${unpaid.length ? `<div class="liab-grid fade-in">${unpaid.map(card).join('')}</div>`
      : `<div class="empty fade-in"><div class="big">🧼</div>no open liabilities — you're debt-free!</div>`}
    ${paid.length ? `<div class="sec-head"><h3>Paid off</h3></div><div class="liab-grid fade-in">${paid.map(card).join('')}</div>` : ''}`;
}

function openLiabModal() {
  liabAccountSel = customSelect($('#lb_account'), {
    options: state.accounts.map((a) => ({
      value: a.id, label: a.name, icon: curOf(a.currency).symbol,
      sub: `${a.currency} · balance ${fmtNative(a.nativeBalance, a.currency)}`
    })),
    value: state.accounts[0]?.id ?? null,
    onChange: () => {}
  });
  $('#lb_due').value = todayStr();
  $('#liabModal').classList.add('on');
  $('#lb_creditor').focus();
}

async function saveLiab() {
  try {
    await api('/liabilities', { method: 'POST', body: {
      creditor: $('#lb_creditor').value, name: $('#lb_name').value, amount: $('#lb_amount').value,
      accountId: liabAccountSel?.value, dueDate: $('#lb_due').value
    }});
    closeModal('liabModal');
    ['#lb_creditor', '#lb_name', '#lb_amount'].forEach((s) => ($(s).value = ''));
    toast('liability added — you\'ll get alerts before it\'s due ⏰', 'ok');
    route(); refreshBadges();
  } catch (e) { toast(esc(e.message), 'err'); }
}

async function payLiab(id) {
  await refreshAccounts();
  let liability = liabilitiesCache.find((l) => l.id === id);
  if (!liability) {
    const result = await api('/liabilities');
    liabilitiesCache = result.liabilities;
    liability = liabilitiesCache.find((l) => l.id === id);
  }
  if (!liability) return toast('Liability not found', 'err');
  const account = state.accounts.find((a) => a.id === liability.accountId);
  if (!account) return toast('Liability wallet not found', 'err');
  activeLiabilityId = id;
  $('#liabPayText').textContent = `${liability.creditor || 'Creditor'} · ${fmtNative(liability.remainingAmount, liability.currency)} remaining`;
  $('#lb_pay_amount').value = liability.remainingAmount;
  $('#lb_pay_amount').max = liability.remainingAmount;
  liabPayWalletSel = customSelect($('#lb_pay_wallet'), {
    options: [{
      value: account.id, label: account.name, icon: curOf(account.currency).symbol,
      sub: `${account.currency} · balance ${fmtNative(account.nativeBalance, account.currency)}`
    }],
    value: account.id,
    onChange: () => {}
  });
  $('#liabPayModal').classList.add('on');
  $('#lb_pay_amount').focus();
}

async function saveLiabPayment() {
  if (liabPaymentSaving) return;
  liabPaymentSaving = true;
  const button = $('#saveLiabPaymentBtn');
  if (button) button.disabled = true;
  try {
    await api('/liabilities/' + activeLiabilityId, {
      method: 'PATCH', body: { status: 'paid', amount: $('#lb_pay_amount').value }
    });
    closeModal('liabPayModal');
    toast('liability payment recorded as a wallet expense', 'ok');
    route(); refreshBadges();
  } catch (e) {
    toast(esc(e.message), 'err');
  } finally {
    liabPaymentSaving = false;
    if (button) button.disabled = false;
  }
}
async function unpayLiab(id) {
  try {
    await api('/liabilities/' + id, { method: 'PATCH', body: { status: 'unpaid' } });
    toast('last payment undone — linked expense removed', 'ok');
    route(); refreshBadges();
  } catch (e) { toast(esc(e.message), 'err'); }
}
function openLiabDueDate(id) {
  const liability = liabilitiesCache.find((l) => l.id === id);
  if (!liability) return;
  activeLiabilityId = id;
  $('#lb_new_due').value = liability.dueDate;
  $('#liabDueModal').classList.add('on');
}
async function saveLiabDueDate() {
  try {
    await api('/liabilities/' + activeLiabilityId, {
      method: 'PATCH', body: { dueDate: $('#lb_new_due').value }
    });
    closeModal('liabDueModal');
    toast('due date updated 📅', 'ok');
    route(); refreshBadges();
  } catch (e) { toast(esc(e.message), 'err'); }
}
async function delLiab(id) {
  if (!confirm('Delete this liability?')) return;
  try { await api('/liabilities/' + id, { method: 'DELETE' }); toast('liability deleted', 'ok'); route(); refreshBadges(); }
  catch (e) { toast(esc(e.message), 'err'); }
}

// ================= FORECAST =================
async function renderForecast() {
  const f = await api('/forecast');
  const all = [...f.history, ...f.future];
  const W = 760, H = 300, pad = { l: 56, r: 16, t: 18, b: 34 };
  const maxV = Math.max(...all.map((m) => Math.max(m.income, m.expense)), 1) * 1.15;
  const n = all.length;
  const x = (i) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / maxV) * (H - pad.t - pad.b);

  const line = (key) => {
    const hist = all.map((m, i) => ({ i, v: m[key], proj: !!m.projected })).filter((p) => !p.proj);
    const full = all.map((m, i) => ({ i, v: m[key], proj: !!m.projected }));
    const pts = (arr) => arr.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    let path = `<polyline points="${pts(hist)}" fill="none" stroke="url(#lg${key})" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    const joint = hist.slice(-1).concat(full.filter((p) => p.proj));
    if (joint.length > 1) path += `<polyline points="${pts(joint)}" fill="none" stroke="url(#lg${key})" stroke-width="3" stroke-dasharray="7 7" stroke-linecap="round" opacity=".75"/>`;
    for (const p of full) path += `<circle cx="${x(p.i)}" cy="${y(p.v)}" r="3.4" fill="#0b0b14" stroke="${key === 'income' ? '#34d399' : '#fb7185'}" stroke-width="2"/>`;
    return path;
  };

  const gridY = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const v = maxV * (1 - t) / 1.15;
    const yy = pad.t + t * (H - pad.t - pad.b);
    return `<line x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}" stroke="rgba(255,255,255,.07)"/>
      <text x="${pad.l - 10}" y="${yy + 4}" fill="#9d9cb5" font-size="10" text-anchor="end">${fmtBase(Math.round(v)).replace(/\.\d+$/, '')}</text>`;
  }).join('');

  const labels = all.map((m, i) => `<text x="${x(i)}" y="${H - 10}" fill="#9d9cb5" font-size="10" text-anchor="middle">${m.label.split(' ')[0]}</text>`).join('');

  const catBars = f.nextMonth.byCategory.slice(0, 6).map((c) => {
    const pct = (c.amount / Math.max(f.nextMonth.expense, 1)) * 100;
    return `<div class="catbar"><div class="row1"><b>${esc(c.category)}</b><span class="mono">~${fmtBase(c.amount)}</span></div>
      <div class="track"><div class="fill" style="width:${Math.max(3, pct)}%"></div></div></div>`;
  }).join('');

  $('#view-forecast').innerHTML = `
    <div class="grid cols-3 fade-in" style="margin-bottom:18px">
      <div class="card stat"><span class="k">Projected income · next month</span><div class="v" style="color:var(--green)">${fmtBase(f.nextMonth.income)}</div></div>
      <div class="card stat"><span class="k">Projected cash outflow · next month</span><div class="v" style="color:var(--red)">${fmtBase(f.nextMonth.expense)}</div><div class="d">includes ${fmtBase(f.nextMonth.liabilityDue)} known liabilities due</div></div>
      <div class="card stat"><span class="k">Projected net</span><div class="v" style="color:${f.nextMonth.net >= 0 ? 'var(--green)' : 'var(--red)'}">${f.nextMonth.net >= 0 ? '+' : ''}${fmtBase(f.nextMonth.net)}</div>
        <div class="d">avg monthly cash outflow ${fmtBase(f.monthlyAvgExpense)}</div></div>
    </div>
    <div class="card fade-in">
      <h3 style="margin-bottom:6px">Cash-flow trend & projection <span class="pill gray" style="margin-left:6px">${state.user.currency} wallets only</span></h3>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="lgincome" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#67e8f9"/></linearGradient>
          <linearGradient id="lgexpense" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fb7185"/><stop offset="1" stop-color="#e879f9"/></linearGradient>
        </defs>
        ${gridY}
        <line x1="${pad.l}" y1="${y(0)}" x2="${W - pad.r}" y2="${y(0)}" stroke="rgba(255,255,255,.14)"/>
        ${line('income')}${line('expense')}
        ${labels}
      </svg>
      <div class="legend">
        <span><span class="sw" style="background:linear-gradient(90deg,#34d399,#67e8f9)"></span>income</span>
        <span><span class="sw" style="background:linear-gradient(90deg,#fb7185,#e879f9)"></span>cash outflow (spending + debt payments)</span>
        <span><span class="sw" style="background:repeating-linear-gradient(90deg,#c4b5fd 0 5px,transparent 5px 10px)"></span>dashed = projection (trend-damped)</span>
      </div>
    </div>
    <div class="grid cols-2" style="margin-top:18px">
      <div class="card fade-in"><h3 style="margin-bottom:12px">Where next month's cash goes</h3>
        ${catBars || '<div class="empty">log some expenses to unlock this 🔮</div>'}</div>
      <div class="card fade-in"><h3 style="margin-bottom:12px">3-month outlook</h3>
        <table class="tbl"><thead><tr><th>Month</th><th class="right">Income</th><th class="right">Cash outflow</th><th class="right">Net</th></tr></thead>
        <tbody>${f.future.map((m) => `<tr><td>${esc(m.label)}</td>
          <td class="right mono" style="color:var(--green)">+${fmtBase(m.income)}</td>
          <td class="right mono" style="color:var(--red)">−${fmtBase(m.expense)}</td>
          <td class="right mono" style="font-weight:700;color:${m.net >= 0 ? 'var(--green)' : 'var(--red)'}">${m.net >= 0 ? '+' : ''}${fmtBase(m.net)}</td></tr>`).join('')}</tbody></table>
        <div style="font-size:12px;color:var(--muted);margin-top:10px">Other currency wallets are kept separate.</div>
      </div>
    </div>`;
}

// ================= ASSISTANT =================
async function renderAssistant() {
  const sugg = ['Financial summary', 'Who owes me?', 'What do I owe?', 'How much can I spend?', 'Forecast next month', 'Where did my money go?', 'Give me advice'];
  $('#view-assistant').innerHTML = `
    <div class="card chat-wrap fade-in">
      <div class="chat-log" id="chatLog">
        <div class="msg ai">yo ${esc(state.user.name.split(' ')[0])} 👋 i'm <b>Zeno</b> — i read your live data, so everything i say is real. ask me anything about your money 💸</div>
      </div>
      <div class="sugg">${sugg.map((s) => `<button onclick="askZeno('${s.replace(/'/g, "\\'")}')">${s}</button>`).join('')}</div>
      <div class="chat-input">
        <input id="chatInput" placeholder="ask zeno anything… e.g. how much did i spend on food?" onkeydown="if(event.key==='Enter')askZeno()"/>
        <button class="btn" onclick="askZeno()">Send 🚀</button>
      </div>
    </div>`;
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); askZeno(); } });
  renderChatLog();
}

function renderChatLog() {
  const log = $('#chatLog');
  if (!log) return;
  log.innerHTML = `<div class="msg ai">yo ${esc(state.user.name.split(' ')[0])} 👋 i'm <b>Zeno</b> — i read your live data, so everything i say is real. ask me anything about your money 💸</div>` +
    state.chat.map((m) => `<div class="msg ${m.who}">${md(m.text)}</div>`).join('');
  log.scrollTop = log.scrollHeight;
}

async function askZeno(preset) {
  const input = $('#chatInput');
  const text = (preset || input.value).trim();
  if (!text) return;
  input.value = '';
  state.chat.push({ who: 'me', text });
  renderChatLog();

  const log = $('#chatLog');
  const typing = document.createElement('div');
  typing.className = 'msg ai';
  typing.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  log.appendChild(typing);
  log.scrollTop = log.scrollHeight;

  try {
    const { reply } = await api('/chat', { method: 'POST', body: { message: text } });
    state.chat.push({ who: 'ai', text: reply });
  } catch (e) {
    state.chat.push({ who: 'ai', text: 'ugh, my brain glitched 😵‍💫 try again?' });
  }
  renderChatLog();
}

// ================= ADMIN =================
async function renderAdmin() {
  const [{ users }, st] = await Promise.all([api('/admin/users'), api('/admin/stats')]);

  const row = (u) => {
    const badge = u.status === 'active' ? '<span class="pill green">✓ verified</span>'
      : u.status === 'pending' ? '<span class="pill amber">⏳ pending</span>'
      : '<span class="pill red">✕ rejected</span>';
    return `
      <tr>
        <td data-label="User"><div style="display:flex;align-items:center;gap:10px;min-width:0">
          <div class="avatar" style="width:32px;height:32px;font-size:12px">${esc(u.name[0].toUpperCase())}</div>
          <div><div style="font-weight:600">${esc(u.name)}${u.id === state.user.id ? ' <span class="pill gray">you</span>' : ''}</div>
          <div style="font-size:12px;color:var(--muted)">${esc(u.email)}</div></div>
        </div></td>
        <td data-label="Role">${u.role === 'admin' ? '<span class="pill violet">🛡️ admin</span>' : '<span class="pill gray">user</span>'}</td>
        <td data-label="Base currency" class="mono">${u.currency}</td>
        <td data-label="Status">${badge}</td>
        <td data-label="Actions"><div class="row-actions">
          ${u.status !== 'active' ? `<button class="btn sm" onclick="setUserStatus(${u.id},'active')">Verify ✓</button>` : ''}
          ${u.status === 'active' && u.role !== 'admin' ? `<button class="btn sm ghost" onclick="setUserStatus(${u.id},'rejected')">Reject</button>` : ''}
          ${u.status === 'pending' ? `<button class="btn sm ghost" onclick="setUserStatus(${u.id},'rejected')">Reject</button>` : ''}
          ${u.role !== 'admin' ? `<button class="icon-btn" title="delete user" onclick="delUser(${u.id})">🗑</button>` : ''}
        </div></td>
      </tr>`;
  };

  $('#view-admin').innerHTML = `
    <div class="statline fade-in">
      <div class="card mini"><div class="v">${st.total}</div><div class="k">total users</div></div>
      <div class="card mini"><div class="v" style="color:var(--amber)">${st.pending}</div><div class="k">pending</div></div>
      <div class="card mini"><div class="v" style="color:var(--green)">${st.active}</div><div class="k">verified</div></div>
      <div class="card mini"><div class="v" style="color:var(--red)">${st.rejected}</div><div class="k">rejected</div></div>
      <div class="card mini"><div class="v">${st.transactions}</div><div class="k">transactions</div></div>
    </div>
    <div class="card tbl-wrap mobile-table-wrap fade-in">
      ${st.pending ? `<div class="alert-item due-soon" style="margin-bottom:14px">⏳ <div><b>${st.pending} user${st.pending > 1 ? 's' : ''} waiting for verification</b><br/><small>new sign-ups can't log in until you approve them</small></div></div>` : ''}
      <table class="tbl mobile-card-table admin-table">
        <thead><tr><th>User</th><th>Role</th><th>Base currency</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map(row).join('')}</tbody>
      </table>
    </div>`;
}

async function setUserStatus(id, status) {
  try {
    await api('/admin/users/' + id, { method: 'PATCH', body: { status } });
    toast(status === 'active' ? 'user verified ✓ they can log in now' : 'user status → ' + status, 'ok');
    route(); refreshBadges();
  } catch (e) { toast(esc(e.message), 'err'); }
}
async function delUser(id) {
  if (!confirm('Delete this user and all their data?')) return;
  try { await api('/admin/users/' + id, { method: 'DELETE' }); toast('user deleted', 'ok'); route(); refreshBadges(); }
  catch (e) { toast(esc(e.message), 'err'); }
}

// ================= THEME (light / dark) =================
function applyTheme(theme) {
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  const icon = theme === 'light' ? '☀️' : '🌙';
  const b = $('#themeBtn'); if (b) b.textContent = icon;
  const a = $('#themeBtnAuth'); if (a) a.textContent = icon;
  try { localStorage.setItem('expenzo_theme', theme); } catch {}
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
}
applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

// ================= PASSWORD (self) =================
function openPasswordModal() {
  ['#pw_current', '#pw_new', '#pw_confirm'].forEach((s) => ($(s).value = ''));
  $('#passModal').classList.add('on');
  $('#pw_current').focus();
}
async function savePassword() {
  const current = $('#pw_current').value, next = $('#pw_new').value, confirmPw = $('#pw_confirm').value;
  if (next !== confirmPw) return toast("new passwords don't match 😅", 'err');
  try {
    const r = await api('/me/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
    closeModal('passModal');
    toast(esc(r.message), 'ok');
  } catch (e) { toast(esc(e.message), 'err'); }
}

// ================= RECEIPT SCAN (upload + OCR) =================

async function openScan() {
  $('#scanResult').innerHTML = '';
  $('#scanProgress').style.display = 'none';
  $('#scanPreview').style.display = 'none';
  $('#dropzone').style.display = '';
  $('#scanFile').value = '';
  $('#scanModal').classList.add('on');
}

function closeScan() {
  $('#scanModal').classList.remove('on');
}

function setScanProgress(label, frac) {
  $('#scanProgress').style.display = '';
  $('#scanStatus').textContent = label;
  $('#scanBar').style.width = Math.round(Math.min(1, frac) * 100) + '%';
}

async function ensureTesseract() {
  if (window.Tesseract) return;
  setScanProgress('loading the OCR engine… (first time only)', 0.03);
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load the OCR engine — check your internet 📶 (you can still type it manually)"));
    document.head.appendChild(s);
  });
}

let scanWorker = null;
async function getOcrWorker() {
  if (scanWorker) return scanWorker;
  await ensureTesseract();
  scanWorker = await window.Tesseract.createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'loading language traineddata' || m.status === 'loading tesseract core') setScanProgress('loading the OCR engine… (first time only)', 0.05 + (m.progress || 0) * 0.3);
      else if (m.status === 'recognizing text') setScanProgress('reading the receipt…', 0.4 + (m.progress || 0) * 0.55);
    }
  });
  // receipts are one vertical column of text — this mode reads them far better
  await scanWorker.setParameters({ tessedit_pageseg_mode: '4', preserve_interword_spaces: '1' });
  return scanWorker;
}

// grayscale, upscale, and stretch contrast so the OCR sees crisp dark text on white
function preprocessImage(src) {
  const scale = Math.max(1, Math.min(3, 1700 / src.width));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const n = c.width * c.height;
  const gray = new Uint8ClampedArray(n);
  let min = 255, max = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    gray[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = Math.round(Math.pow((gray[p] - min) / range, 1.2) * 255);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function fileToCanvas(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const raw = document.createElement('canvas');
      raw.width = img.width;
      raw.height = img.height;
      raw.getContext('2d').drawImage(img, 0, 0);
      resolve(preprocessImage(raw));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error("couldn't read that image 😵 — try a JPG or PNG"));
    img.src = URL.createObjectURL(file);
  });
}

function acceptReceiptFile(file) {
  if (!file || !file.type.startsWith('image/')) return toast('please choose an image (JPG/PNG) 🖼', 'err');
  $('#dropzone').style.display = 'none';
  $('#scanResult').innerHTML = '';
  fileToCanvas(file).then((canvas) => {
    $('#scanPreview').src = canvas.toDataURL('image/png');
    $('#scanPreview').style.display = '';
    return runOcr(canvas);
  }).catch((e) => toast(esc(e.message || 'failed to process image'), 'err'));
}

async function runOcr(canvas) {
  try {
    const worker = await getOcrWorker();
    setScanProgress('reading the receipt…', 0.45);
    const { data } = await worker.recognize(canvas);
    setScanProgress('done ✨', 1);
    const parsed = parseReceipt(data.text || '');
    showScanResult(parsed, data.text || '');
    applyScan(parsed);
  } catch (e) {
    $('#scanProgress').style.display = 'none';
    toast(esc(e.message || 'scan failed 😵'), 'err');
  }
}

// pull the amount / date / merchant out of raw OCR text
function parseReceipt(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 1);

  // strip currency words/symbols so they can't bleed into the numbers
  const clean = (line) => line
    .replace(/(rs\.?|afn|pkr|usd|aed|inr|eur|gbp|irr|iqd|try|cny|sar|toman|rupees?|us\$|\$|€|£|₨|؋|﷼|تومان|ریال|افغانی)/gi, ' ');

  // OCR reads O as 0, I/l as 1, S as 5… fix letters inside number-ish tokens
  const digitify = (line) => line.replace(/[^\s\u0600-\u06FF]+/g, (tok) => {
    if (!/\d/.test(tok)) return tok;
    return tok
      .replace(/[OoQ]/g, '0').replace(/[lI|!]/g, '1').replace(/[Ss]/g, '5')
      .replace(/[Bb]/g, '8').replace(/[Zz]/g, '2').replace(/[Ggq]/g, '9');
  });

  // "1,720.50" | "1.720,50" | "1720" | "1 720,50" → number
  const toNum = (raw) => {
    let s = raw.replace(/[\s'\u00A0]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (s.includes(',')) {
      s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    } else if ((s.match(/\./g) || []).length > 1) {
      const parts = s.split('.');
      const last = parts.pop();
      s = parts.join('') + (last.length <= 2 ? '.' + last : '');
    }
    const m = s.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0]);
    return isFinite(n) ? n : null;
  };


  // ---- amount: score every plausible number, best score wins ----
  const round2 = (v) => Math.round(v * 100) / 100;
  const payRe = /(\bcash\b|\bpaid\b|\bpayment\b|\btender\b|\bchange\b|\bvisa\b|\bmaster\b|\bcard\b|\bbank\b|نقد|پرداخت)/i;
  const subRe = /(sub\s*-?\s*t[o0]t[a4]l|subtotal)/i;
  const taxRe = /(\bvat\b|\btax\b|مالیات)/i;
  const kwGuard = /(t[o0]t[a4]l|total|amount|payable|balance|مجموع|جمع|مبلغ)/i;
  const skipRe = /(discount|item|qty|quantity|change\s*due)/i;

  // numbers on a line (after cleanup, digit-fixes and space-thousand joins)
  const numsOnLine = (line) => {
    const prepared = digitify(clean(line)).replace(/(\d) (?=\d{3}(?!\d))/g, '$1');
    return (prepared.match(/\d[\d.,'\u00A0]*/g) || [])
      .map(toNum)
      .filter((v) => v != null && v > 0);
  };

  // subtotal & tax — used to verify the total arithmetically
  let subtotal = null, tax = null;
  for (const line of lines) {
    if (subRe.test(line)) {
      const ns = numsOnLine(line);
      if (ns.length) subtotal = Math.max(...ns);
    } else if (taxRe.test(line)) {
      const ns = numsOnLine(line);
      if (ns.length) tax = Math.max(...ns);
    }
  }
  const expected = subtotal != null ? round2(subtotal + (tax || 0)) : null;

  const cands = []; // { value, score }
  const pushCand = (value, score) => {
    if (!value || value <= 0) return;
    const v = round2(value);
    // arithmetic verification: total should equal subtotal (+tax) and exceed subtotal
    if (expected != null && Math.abs(v - expected) < 0.02) score += 60;
    if (subtotal != null && v > subtotal) score += 25;
    if (/\d\.\d{2}$/.test(String(v))) score += 10; // real prices usually carry cents
    const prev = cands.find((c) => c.value === v);
    if (prev) prev.score = Math.max(prev.score, score);
    else cands.push({ value: v, score });
  };

  for (const line of lines) {
    if (!kwGuard.test(line)) continue;
    if (subRe.test(line) || taxRe.test(line) || skipRe.test(line)) continue;
    const nums = numsOnLine(line);
    if (!nums.length) continue;
    let score = 20;
    if (/(grand\s*total|grand\s*sum|مجموع\s*کل)/i.test(line)) score = 100;
    else if (/(total\s*(due|payable)|amount\s*(due|payable)|balance\s*due|payable)/i.test(line)) score = 80;
    else if (/(t[o0]t[a4]l|total)/i.test(line)) score = 60;
    if (payRe.test(line)) score -= 60;
    const sorted = [...nums].sort((a, b) => b - a);
    pushCand(sorted[0], score);
    if (sorted.length === 1) pushCand(sorted[0], score + 15); // "TOTAL 1,800.00" — number straight after the keyword
    else pushCand(sorted[1], score - 15); // second number on the line, in case the biggest is a payment
  }

  // fallback (no keyword lines): biggest believable number anywhere
  if (!cands.length) {
    for (const line of lines) {
      for (const v of numsOnLine(line)) {
        const rawish = String(v);
        const looksLikeYear = v >= 1900 && v <= 2100 && !/\.\d{1,2}$/.test(rawish);
        const looksLikePhone = !/\.\d{1,2}$/.test(rawish) && String(Math.round(v)).length >= 9;
        if (!looksLikeYear && !looksLikePhone) pushCand(v, 10);
      }
    }
  }

  cands.sort((a, b) => b.score - a.score || b.value - a.value);
  const amount = cands.length ? cands[0].value : null;

  // date: YYYY-MM-DD, else DD/MM/YYYY (or MM/DD if unambiguous), else today
  let date = todayStr();
  const iso = text.match(/\b(20\d{2})[-./](\d{1,2})[-./](\d{1,2})\b/);
  const dmy = text.match(/\b(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})\b/);
  const mk = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  let parsedDate = null;
  if (iso) parsedDate = mk(+iso[1], +iso[2], +iso[3]);
  else if (dmy) {
    const y = +dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3];
    let day, month;
    if (+dmy[1] > 12) { day = +dmy[1]; month = +dmy[2]; }
    else if (+dmy[2] > 12) { month = +dmy[1]; day = +dmy[2]; }
    else { day = +dmy[1]; month = +dmy[2]; }
    parsedDate = mk(y, month, day);
  }
  if (parsedDate && parsedDate <= todayStr()) date = parsedDate;

  // merchant: first text-y line that isn't a number/date row
  let merchant = null;
  for (const line of lines) {
    if (/[a-zA-Z\u0600-\u06FF]{3,}/.test(line) && !/\d{1,2}[-./]\d{1,2}/.test(line) && !/total|invoice|receipt/i.test(line)) {
      merchant = line.replace(/\s{2,}/g, ' ').slice(0, 60);
      break;
    }
  }

  return { amount, candidates: cands.slice(0, 6).map((c) => c.value), date, merchant };
}

function showScanResult(parsed, raw) {
  const others = (parsed.candidates || []).filter((v) => v !== parsed.amount);
  const candChips = others.length
    ? `<div class="scan-cands"><span class="cand-lbl">not right? tap the amount you see on the receipt:</span>
        ${others.map((v) => `<button type="button" class="cand-chip" onclick="setCandAmount(${v})">${v.toLocaleString('en-US')}</button>`).join('')}</div>`
    : '';
  $('#scanResult').innerHTML = `
    <div class="scan-chips">
      ${parsed.amount != null ? `<span class="pill green">amount ${parsed.amount.toLocaleString('en-US')}</span>` : '<span class="pill gray">amount not found — pick or type it</span>'}
      <span class="pill cyan">date ${prettyDate(parsed.date)}</span>
      ${parsed.merchant ? `<span class="pill violet">${esc(parsed.merchant.slice(0, 26))}</span>` : ''}
    </div>
    ${candChips}
    <details class="scan-raw"><summary>see raw scanned text</summary><pre>${esc(raw.slice(0, 800))}</pre></details>
    <div class="scan-note">form prefilled below — double-check the numbers, then save ✅ <a class="lnk" style="color:#c4b5fd;cursor:pointer" onclick="openScan()">choose another image</a></div>`;
}

// tap a candidate amount from the receipt to use it
function setCandAmount(v) {
  $('#tx_amount').value = v;
  setTxType('expense');
  toast('amount set to ' + Number(v).toLocaleString('en-US'), 'ok');
}

function applyScan(parsed) {
  setTxType('expense');
  if (parsed.amount != null) $('#tx_amount').value = parsed.amount;
  $('#tx_date').value = parsed.date || todayStr();
  if (parsed.merchant) $('#tx_note').value = parsed.merchant;
  updateBalanceHint();
}

// wire up click / drag-drop / paste for the upload zone
(function wireScanDropzone() {
  const dz = document.getElementById('dropzone');
  const fileInput = document.getElementById('scanFile');
  if (!dz) return;
  dz.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => acceptReceiptFile(fileInput.files?.[0]));
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => acceptReceiptFile(e.dataTransfer?.files?.[0]));
  document.addEventListener('paste', (e) => {
    if (!$('#scanModal').classList.contains('on')) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) acceptReceiptFile(item.getAsFile());
  });
})();

// go 🚀
boot();
