import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  load, save, getDb, nextId, hashPassword, verifyPassword, newToken,
  CURRENCIES, CATEGORIES, toUSD, fromUSD, round2, round4, todayStr, createDefaultAccount,
  reload as reloadStore, cloudMode, getStoreStatus, pendingWrites
} from './src/store.js';
import { startRateRefresh, getRates, isLive } from './src/rates.js';
import { balanceUpToAccount, buildForecast, buildAlerts, chatReply } from './src/intelligence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

load();
startRateRefresh();

// cloud mode: pull the latest state from Redis before every API request, and
// hold back the JSON response until the handler's write has actually landed —
// otherwise serverless freezes could drop the write right after responding.
app.use('/api', async (req, res, next) => {
  try {
    await reloadStore();
    const json = res.json.bind(res);
    res.json = (body) => Promise.resolve(pendingWrites()).then(() => json(body));
    next();
  } catch (e) { next(e); }
});

// public diagnostic endpoint — helps debug a fresh deployment
app.get('/api/health', async (req, res) => {
  try { await reloadStore(); } catch {}
  const st = getStoreStatus();
  res.json({
    ...st,
    hint: st.cloudMode
      ? (st.ok ? 'cloud database connected and seeded ✅'
               : `database problem → check UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in Vercel → Settings → Environment Variables (${st.lastError || 'no users found'})`)
      : 'running in local file mode (env vars not set on this deployment)'
  });
});

// ---------- auth middleware ----------

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const db = getDb();
  const session = db.sessions[token];
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  const user = db.users.find((u) => u.id === session.userId);
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'Account not active' });
  req.user = user;
  req.token = token;
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, status: u.status,
  currency: u.currency, createdAt: u.createdAt
});

// ---------- rates ----------

app.get('/api/rates', (req, res) => {
  const { rates, updatedAt } = getRates();
  res.json({ base: 'USD', rates, updatedAt, live: isLive() });
});

// ---------- auth routes ----------

app.post('/api/register', (req, res) => {
  const { name, email, password, currency } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters' });
  const db = getDb();
  const emailNorm = String(email).toLowerCase().trim();
  if (db.users.some((u) => u.email === emailNorm)) return res.status(400).json({ error: 'That email is already registered' });
  if (!CURRENCIES[currency]) return res.status(400).json({ error: 'Pick a valid currency' });
  const { salt, hash } = hashPassword(String(password));
  const user = {
    id: nextId('user'),
    name: String(name).trim().slice(0, 60),
    email: emailNorm,
    passHash: hash,
    salt,
    role: 'user',
    status: 'pending', // an admin must verify
    currency, // becomes the locked base currency + first wallet's currency
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  createDefaultAccount(user.id, currency, 'Main');
  save();
  res.json({ ok: true, message: 'Account created — an admin has to verify you before you can log in. 🔒' });
});

app.post('/api/login', (req, res) => {
  const st = getStoreStatus();
  if (st.cloudMode && !st.ok && st.lastError) {
    const reason = st.lastError.includes('401') ? 'the TOKEN is wrong (or URL and token are from different databases)'
      : st.lastError.includes('404') ? 'the URL is wrong'
      : st.lastError.includes('fetch failed') ? 'the URL is not a valid https:// REST endpoint (did you paste a redis:// connection string?)'
      : 'unknown — see /api/health';
    return res.status(503).json({ error: `Database unreachable on the server (${reason}). Fix it in Vercel → Settings → Environment Variables → UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN, then redeploy.` });
  }
  const { email, password } = req.body || {};
  const db = getDb();
  const user = db.users.find((u) => u.email === String(email || '').toLowerCase().trim());
  if (!user || !verifyPassword(String(password || ''), user.salt, user.passHash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  if (user.status === 'pending') {
    return res.status(403).json({ error: 'Your account is waiting for admin verification. Come back soon! ⏳' });
  }
  if (user.status === 'rejected') {
    return res.status(403).json({ error: 'Your account was not approved by an admin.' });
  }
  const token = newToken();
  db.sessions[token] = { userId: user.id, createdAt: new Date().toISOString() };
  save();
  res.json({ token, user: publicUser(user) });
});

app.post('/api/logout', auth, (req, res) => {
  delete getDb().sessions[req.token];
  save();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// currency is locked after signup — users add extra-currency wallets instead
app.put('/api/me', auth, (req, res) => {
  if ((req.body || {}).currency && req.body.currency !== req.user.currency) {
    return res.status(400).json({ error: 'Your base currency is locked after signup — add a new wallet in another currency instead 🪙' });
  }
  res.json({ user: publicUser(req.user) });
});

// change your own password (users and admins)
app.post('/api/me/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(String(currentPassword || ''), req.user.salt, req.user.passHash)) {
    return res.status(400).json({ error: 'Current password is wrong' });
  }
  if (String(newPassword || '').length < 6) return res.status(400).json({ error: 'New password needs at least 6 characters' });
  const { salt, hash } = hashPassword(String(newPassword));
  req.user.salt = salt;
  req.user.passHash = hash;
  save();
  res.json({ ok: true, message: 'Password updated ✅' });
});

// admin sets a new password for any user
app.patch('/api/admin/users/:id/password', auth, adminOnly, (req, res) => {
  const db = getDb();
  const user = db.users.find((u) => u.id === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { newPassword } = req.body || {};
  if (String(newPassword || '').length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters' });
  const { salt, hash } = hashPassword(String(newPassword));
  user.salt = salt;
  user.passHash = hash;
  save();
  res.json({ ok: true, message: `Password reset for ${user.name} ✅` });
});

// ---------- meta ----------

app.get('/api/meta', (req, res) => {
  res.json({ currencies: CURRENCIES, categories: CATEGORIES });
});

// ---------- accounts (wallets) ----------

app.get('/api/accounts', auth, (req, res) => {
  const db = getDb();
  const today = todayStr();
  const accounts = db.accounts
    .filter((a) => a.userId === req.user.id)
    .map((a) => {
      const usd = db.transactions
        .filter((t) => t.accountId === a.id && t.date <= today)
        .reduce((s, t) => s + (t.type === 'income' ? t.usdAmount : -t.usdAmount), 0);
      return {
        ...a,
        usdBalance: usd,
        nativeBalance: round2(fromUSD(usd, a.currency)),
        baseBalance: round2(fromUSD(usd, req.user.currency)),
        ratePerUsd: getRates().rates[a.currency] || null
      };
    });
  res.json({ accounts });
});

app.post('/api/accounts', auth, (req, res) => {
  const { name, currency } = req.body || {};
  if (!CURRENCIES[currency]) return res.status(400).json({ error: 'Pick a valid currency' });
  const db = getDb();
  const acc = createDefaultAccount(req.user.id, currency, name || `${currency} wallet`);
  save();
  res.json({ account: acc });
});

app.delete('/api/accounts/:id', auth, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const acc = db.accounts.find((a) => a.id === id && a.userId === req.user.id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  const userAccounts = db.accounts.filter((a) => a.userId === req.user.id);
  if (userAccounts.length === 1) return res.status(400).json({ error: 'You need at least one wallet — add another before deleting this one' });
  const hasTx = db.transactions.some((t) => t.accountId === id) || db.liabilities.some((l) => l.accountId === id);
  if (hasTx) return res.status(400).json({ error: 'This wallet has transactions or liabilities — move/delete them first' });
  db.accounts = db.accounts.filter((a) => a.id !== id);
  save();
  res.json({ ok: true });
});

// ---------- summary / dashboard ----------

const decorateTx = (req) => (t) => ({
  ...t,
  baseAmount: round2(fromUSD(t.usdAmount, req.user.currency)),
  isFuture: t.date > todayStr()
});

app.get('/api/summary', auth, (req, res) => {
  const db = getDb();
  const today = todayStr();
  const txs = db.transactions.filter((t) => t.userId === req.user.id);
  const base = (usd) => round2(fromUSD(usd, req.user.currency));

  const settled = txs.filter((t) => t.date <= today);
  const scheduled = txs.filter((t) => t.date > today);
  const balance = settled.reduce((s, t) => s + (t.type === 'income' ? t.usdAmount : -t.usdAmount), 0);
  const thisMonth = today.slice(0, 7);
  const unpaid = db.liabilities.filter((l) => l.userId === req.user.id && l.status === 'unpaid');
  const schedIn = scheduled.filter((t) => t.type === 'income').reduce((s, t) => s + t.usdAmount, 0);
  const schedOut = scheduled.filter((t) => t.type === 'expense').reduce((s, t) => s + t.usdAmount, 0);

  const accounts = db.accounts.filter((a) => a.userId === req.user.id).map((a) => {
    const usd = settled.filter((t) => t.accountId === a.id)
      .reduce((s, t) => s + (t.type === 'income' ? t.usdAmount : -t.usdAmount), 0);
    return {
      id: a.id, name: a.name, currency: a.currency,
      usdBalance: usd,
      nativeBalance: round2(fromUSD(usd, a.currency)),
      baseBalance: base(usd)
    };
  });

  res.json({
    baseCurrency: req.user.currency,
    balance: base(balance),
    incomeAll: base(settled.filter((t) => t.type === 'income').reduce((s, t) => s + t.usdAmount, 0)),
    expenseAll: base(settled.filter((t) => t.type === 'expense').reduce((s, t) => s + t.usdAmount, 0)),
    incomeThisMonth: base(settled.filter((t) => t.type === 'income' && t.date.slice(0, 7) === thisMonth).reduce((s, t) => s + t.usdAmount, 0)),
    expenseThisMonth: base(settled.filter((t) => t.type === 'expense' && t.date.slice(0, 7) === thisMonth).reduce((s, t) => s + t.usdAmount, 0)),
    liabilitiesUnpaid: base(unpaid.reduce((s, l) => s + l.usdAmount, 0)),
    liabilitiesCount: unpaid.length,
    scheduledIn: base(schedIn),
    scheduledOut: base(schedOut),
    projected: base(balance + schedIn - schedOut),
    accounts,
    alerts: buildAlerts(req.user.id),
    recent: txs.slice().sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)).slice(0, 8).map(decorateTx(req)),
    scheduledTx: scheduled.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6).map(decorateTx(req))
  });
});

// ---------- transactions ----------

app.get('/api/transactions', auth, (req, res) => {
  const db = getDb();
  let txs = db.transactions.filter((t) => t.userId === req.user.id);
  const { type, from, to, q, account } = req.query;
  if (type === 'income' || type === 'expense') txs = txs.filter((t) => t.type === type);
  if (from) txs = txs.filter((t) => t.date >= from);
  if (to) txs = txs.filter((t) => t.date <= to);
  if (account) txs = txs.filter((t) => t.accountId === Number(account));
  if (q) {
    const needle = String(q).toLowerCase();
    txs = txs.filter((t) => (t.note || '').toLowerCase().includes(needle) || t.category.toLowerCase().includes(needle));
  }
  txs = txs.slice().sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  res.json({ transactions: txs.map(decorateTx(req)) });
});

app.post('/api/transactions', auth, (req, res) => {
  const { type, amount, accountId, category, date, note } = req.body || {};
  const amt = Number(amount);
  const db = getDb();

  if (!['income', 'expense'].includes(type)) return res.status(400).json({ error: 'Type must be income or expense' });
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Pick a valid date' });
  if (date > todayStr()) return res.status(400).json({ error: "Dates can't be in the future — pick today or earlier 📅" });

  const account = db.accounts.find((a) => a.id === Number(accountId) && a.userId === req.user.id);
  if (!account) return res.status(400).json({ error: 'Pick one of your wallets' });

  const usdAmount = round4(toUSD(amt, account.currency));

  // 🚫 over-balance guard: this wallet's balance as of the entry date can't go negative
  if (type === 'expense') {
    const projected = balanceUpToAccount(account.id, date) - usdAmount;
    if (projected < -0.0001) {
      const shortfall = round2(fromUSD(-projected, account.currency));
      return res.status(400).json({
        error: `Nope 💸 "${account.name}" would go negative by ${shortfall} ${account.currency}. Add income to that wallet first.`
      });
    }
  }

  const tx = {
    id: nextId('tx'),
    userId: req.user.id,
    accountId: account.id,
    type,
    amount: round2(amt),
    currency: account.currency,
    usdAmount,
    category: category || (type === 'income' ? 'Other Income' : 'Other'),
    date,
    note: String(note || '').slice(0, 140),
    createdAt: new Date().toISOString()
  };
  db.transactions.push(tx);
  save();
  res.json({ transaction: decorateTx(req)(tx) });
});

app.delete('/api/transactions/:id', auth, (req, res) => {
  const db = getDb();
  const idx = db.transactions.findIndex((t) => t.id === Number(req.params.id) && t.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Transaction not found' });
  db.transactions.splice(idx, 1);
  save();
  res.json({ ok: true });
});

// ---------- liabilities ----------

app.get('/api/liabilities', auth, (req, res) => {
  const db = getDb();
  const items = db.liabilities
    .filter((l) => l.userId === req.user.id)
    .map((l) => ({
      ...l,
      baseAmount: round2(fromUSD(l.usdAmount, req.user.currency)),
      nativeAmount: round2(l.amount),
      daysLeft: Math.round((new Date(l.dueDate) - new Date(todayStr())) / 86400000)
    }))
    .sort((a, b) => (a.status === b.status ? a.dueDate.localeCompare(b.dueDate) : a.status === 'unpaid' ? -1 : 1));
  res.json({ liabilities: items });
});

app.post('/api/liabilities', auth, (req, res) => {
  const { name, amount, accountId, dueDate } = req.body || {};
  const amt = Number(amount);
  const db = getDb();
  if (!name || !amt || amt <= 0) return res.status(400).json({ error: 'Name and a positive amount are required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate || '')) return res.status(400).json({ error: 'Pick a valid due date' });
  const account = db.accounts.find((a) => a.id === Number(accountId) && a.userId === req.user.id);
  if (!account) return res.status(400).json({ error: 'Pick one of your wallets' });
  const liab = {
    id: nextId('liability'),
    userId: req.user.id,
    accountId: account.id,
    name: String(name).trim().slice(0, 80),
    amount: round2(amt),
    currency: account.currency,
    usdAmount: round4(toUSD(amt, account.currency)),
    dueDate,
    status: 'unpaid',
    linkedTransactionId: null,
    createdAt: new Date().toISOString()
  };
  db.liabilities.push(liab);
  save();
  res.json({ liability: liab });
});

// mark paid / unpaid — paying records a linked expense on the wallet so balances stay true
app.patch('/api/liabilities/:id', auth, (req, res) => {
  const db = getDb();
  const liab = db.liabilities.find((l) => l.id === Number(req.params.id) && l.userId === req.user.id);
  if (!liab) return res.status(404).json({ error: 'Liability not found' });
  const { status } = req.body || {};

  if (status === 'paid' && liab.status !== 'paid') {
    const today = todayStr();
    const projected = balanceUpToAccount(liab.accountId, today) - liab.usdAmount;
    if (projected < -0.0001) {
      const acc = db.accounts.find((a) => a.id === liab.accountId);
      return res.status(400).json({ error: `Not enough balance in "${acc?.name || 'that wallet'}" to pay this off.` });
    }
    const tx = {
      id: nextId('tx'),
      userId: req.user.id,
      accountId: liab.accountId,
      type: 'expense',
      amount: liab.amount,
      currency: liab.currency,
      usdAmount: liab.usdAmount,
      category: 'Liability',
      date: today,
      note: `Paid: ${liab.name}`,
      createdAt: new Date().toISOString()
    };
    db.transactions.push(tx);
    liab.status = 'paid';
    liab.linkedTransactionId = tx.id;
    liab.paidDate = today;
  } else if (status === 'unpaid' && liab.status === 'paid') {
    const txIdx = db.transactions.findIndex((t) => t.id === liab.linkedTransactionId);
    if (txIdx !== -1) db.transactions.splice(txIdx, 1);
    liab.status = 'unpaid';
    liab.linkedTransactionId = null;
    delete liab.paidDate;
  } else {
    return res.status(400).json({ error: 'Invalid status change' });
  }
  save();
  res.json({ liability: liab });
});

app.delete('/api/liabilities/:id', auth, (req, res) => {
  const db = getDb();
  const idx = db.liabilities.findIndex((l) => l.id === Number(req.params.id) && l.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Liability not found' });
  const liab = db.liabilities[idx];
  if (liab.linkedTransactionId) {
    const txIdx = db.transactions.findIndex((t) => t.id === liab.linkedTransactionId);
    if (txIdx !== -1) db.transactions.splice(txIdx, 1);
  }
  db.liabilities.splice(idx, 1);
  save();
  res.json({ ok: true });
});

// ---------- forecast & chat ----------

app.get('/api/forecast', auth, (req, res) => res.json(buildForecast(req.user.id, req.user.currency)));

app.post('/api/chat', auth, (req, res) => {
  const message = String((req.body || {}).message || '').slice(0, 500);
  if (!message.trim()) return res.status(400).json({ error: 'Say something 🫥' });
  res.json({ reply: chatReply(req.user.id, message, req.user.currency) });
});

// ---------- admin ----------

app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  const db = getDb();
  res.json({
    users: db.users.map(publicUser).sort((a, b) => a.id - b.id)
  });
});

app.patch('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  const db = getDb();
  const user = db.users.find((u) => u.id === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { status } = req.body || {};
  if (!['active', 'pending', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (user.id === req.user.id && status !== 'active') return res.status(400).json({ error: "You can't demote yourself" });
  user.status = status;
  save();
  res.json({ user: publicUser(user) });
});

app.delete('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  const idx = db.users.findIndex((u) => u.id === id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  db.users.splice(idx, 1);
  db.transactions = db.transactions.filter((t) => t.userId !== id);
  db.liabilities = db.liabilities.filter((l) => l.userId !== id);
  db.accounts = db.accounts.filter((a) => a.userId !== id);
  for (const [tok, s] of Object.entries(db.sessions)) {
    if (s.userId === id) delete db.sessions[tok];
  }
  save();
  res.json({ ok: true });
});

app.get('/api/admin/stats', auth, adminOnly, (req, res) => {
  const db = getDb();
  res.json({
    total: db.users.length,
    pending: db.users.filter((u) => u.status === 'pending').length,
    active: db.users.filter((u) => u.status === 'active').length,
    rejected: db.users.filter((u) => u.status === 'rejected').length,
    transactions: db.transactions.length
  });
});

// ---------- static frontend ----------

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

// on Vercel the app is exported as a serverless handler — no listen() there
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    const { updatedAt, live } = getRates();
    console.log(`\n  ✦ Expenzo running →  http://localhost:${PORT}`);
    console.log(`  ✦ FX rates: ${live ? 'LIVE (open.er-api.com)' : 'offline fallback'} · updated ${new Date(updatedAt).toLocaleString()}`);
    console.log(`  ✦ admin login: ${process.env.ADMIN_EMAIL || 'habibullahanoosha2019@gmail.com'}`);
    console.log(`  ✦ storage: ${cloudMode ? 'Upstash Redis (cloud)' : 'local JSON file'}\n`);
  });
}

export default app;
