import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  load, save, getDb, nextId, hashPassword, verifyPassword, newToken,
  CURRENCIES, CATEGORIES, round2, todayStr, createDefaultAccount,
  reload as reloadStore, cloudMode, getStoreStatus, pendingWrites
} from './src/store.js';
import { balanceUpToAccount, buildForecast, buildAlerts, chatReply } from './src/intelligence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

load();

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

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Browsers send Date#getTimezoneOffset so "today" follows the user's local
// calendar day, including on phones near midnight. Invalid headers fall back
// to the server's UTC date.
function todayForRequest(req) {
  const offset = Number(req.get('x-timezone-offset'));
  if (!Number.isFinite(offset) || offset < -840 || offset > 840) return todayStr();
  return new Date(Date.now() - offset * 60000).toISOString().slice(0, 10);
}

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

// ---------- meta ----------

app.get('/api/meta', (req, res) => {
  res.json({ currencies: CURRENCIES, categories: CATEGORIES });
});

// ---------- accounts (wallets) ----------

app.get('/api/accounts', auth, (req, res) => {
  const db = getDb();
  const today = todayForRequest(req);
  const accounts = db.accounts
    .filter((a) => a.userId === req.user.id)
    .map((a) => {
      const balance = db.transactions
        .filter((t) => t.accountId === a.id && t.date <= today)
        .reduce((s, t) => s + (t.type === 'income' ? t.amount : -t.amount), 0);
      return {
        ...a,
        nativeBalance: round2(balance)
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
  isFuture: t.date > todayForRequest(req)
});

const liabilityPaidAmount = (liability) => round2(
  (liability.payments || []).reduce((sum, payment) => sum + payment.amount, 0)
);
const liabilityRemainingAmount = (liability) => round2(
  Math.max(0, liability.amount - liabilityPaidAmount(liability))
);
const receivablePaidAmount = (receivable) => round2(
  (receivable.payments || []).reduce((sum, payment) => sum + payment.amount, 0)
);
const receivableRemainingAmount = (receivable) => round2(
  Math.max(0, receivable.amount - receivablePaidAmount(receivable))
);

app.get('/api/summary', auth, (req, res) => {
  const db = getDb();
  const today = todayForRequest(req);
  const txs = db.transactions.filter((t) => t.userId === req.user.id);
  const primaryTxs = txs.filter((t) => t.currency === req.user.currency);
  const settled = primaryTxs.filter((t) => t.date <= today);
  const scheduled = primaryTxs.filter((t) => t.date > today);
  const activitySettled = settled.filter((t) => !t.ledgerKind);
  const activityScheduled = scheduled.filter((t) => !t.ledgerKind);
  const sum = (items, type) => round2(items
    .filter((t) => !type || t.type === type)
    .reduce((total, item) => total + item.amount, 0));
  const balance = round2(sum(settled, 'income') - sum(settled, 'expense'));
  const thisMonth = today.slice(0, 7);
  const unpaid = db.liabilities.filter((l) => l.userId === req.user.id && l.status === 'unpaid');
  const primaryUnpaid = unpaid.filter((l) => l.currency === req.user.currency);
  const outstandingReceivables = db.receivables.filter((r) => r.userId === req.user.id && r.status === 'outstanding');

  const accounts = db.accounts.filter((a) => a.userId === req.user.id).map((a) => {
    const accountTxs = txs.filter((t) => t.accountId === a.id && t.date <= today);
    return {
      id: a.id,
      name: a.name,
      currency: a.currency,
      nativeBalance: round2(sum(accountTxs, 'income') - sum(accountTxs, 'expense'))
    };
  });

  const liabilityTotals = Object.values(unpaid.reduce((totals, l) => {
    const group = totals[l.currency] ||= { currency: l.currency, amount: 0, count: 0 };
    group.amount += liabilityRemainingAmount(l);
    group.count += 1;
    return totals;
  }, {})).map((group) => ({ ...group, amount: round2(group.amount) }));

  const receivableTotals = Object.values(outstandingReceivables.reduce((totals, item) => {
    const group = totals[item.currency] ||= { currency: item.currency, amount: 0, count: 0 };
    group.amount += receivableRemainingAmount(item);
    group.count += 1;
    return totals;
  }, {})).map((group) => ({ ...group, amount: round2(group.amount) }));

  res.json({
    baseCurrency: req.user.currency,
    balance,
    incomeAll: sum(activitySettled, 'income'),
    expenseAll: sum(activitySettled, 'expense'),
    incomeThisMonth: sum(activitySettled.filter((t) => t.date.slice(0, 7) === thisMonth), 'income'),
    expenseThisMonth: sum(activitySettled.filter((t) => t.date.slice(0, 7) === thisMonth), 'expense'),
    liabilitiesUnpaid: round2(primaryUnpaid.reduce((total, item) => total + liabilityRemainingAmount(item), 0)),
    liabilitiesCount: unpaid.length,
    liabilityTotals,
    receivablesCount: outstandingReceivables.length,
    receivableTotals,
    scheduledIn: sum(activityScheduled, 'income'),
    scheduledOut: sum(activityScheduled, 'expense'),
    projected: round2(balance + sum(activityScheduled, 'income') - sum(activityScheduled, 'expense')),
    accounts,
    alerts: buildAlerts(req.user.id, today),
    recent: txs.slice().sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)).slice(0, 8).map(decorateTx(req)),
    scheduledTx: scheduled.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6).map(decorateTx(req))
  });
});

// ---------- transactions ----------

app.get('/api/transactions', auth, (req, res) => {
  const db = getDb();
  let txs = db.transactions.filter((t) => t.userId === req.user.id);
  const { type, from, to, q, account } = req.query;
  if (type === 'income' || type === 'expense') txs = txs.filter((t) => t.type === type && !t.ledgerKind);
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
  const normalizedAmount = round2(amt);
  const db = getDb();

  if (!['income', 'expense'].includes(type)) return res.status(400).json({ error: 'Type must be income or expense' });
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) return res.status(400).json({ error: 'Amount must be a finite positive number of at least 0.01' });
  if (!isValidDateString(date)) return res.status(400).json({ error: 'Pick a valid date' });
  if (date > todayForRequest(req)) return res.status(400).json({ error: "Dates can't be in the future — pick today or earlier 📅" });

  const account = db.accounts.find((a) => a.id === Number(accountId) && a.userId === req.user.id);
  if (!account) return res.status(400).json({ error: 'Pick one of your wallets' });

  // 🚫 over-balance guard: this wallet's balance as of the entry date can't go negative
  if (type === 'expense') {
    const projected = balanceUpToAccount(account.id, date) - normalizedAmount;
    if (projected < -0.0001) {
      const shortfall = round2(-projected);
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
    amount: normalizedAmount,
    currency: account.currency,
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
  const transaction = db.transactions[idx];
  const linkedLiability = db.liabilities.find((l) =>
    l.linkedTransactionId === transaction.id || l.payments?.some((p) => p.transactionId === transaction.id));
  if (linkedLiability) {
    return res.status(400).json({ error: 'This payment belongs to a liability. Undo or delete the liability instead.' });
  }
  const linkedReceivable = db.receivables.find((r) =>
    r.linkedTransactionId === transaction.id || r.payments?.some((p) => p.transactionId === transaction.id));
  if (linkedReceivable) {
    return res.status(400).json({ error: 'This income belongs to money paid back. Reopen or delete that record instead.' });
  }
  const outgoingReceivable = db.receivables.find((r) => r.outgoingTransactionId === transaction.id);
  if (outgoingReceivable) {
    return res.status(400).json({ error: 'This expense belongs to money with another person. Delete that record instead.' });
  }
  if (transaction.type === 'income') {
    const affectedDates = [...new Set(db.transactions
      .filter((t) => t.accountId === transaction.accountId && t.id !== transaction.id && t.date >= transaction.date)
      .map((t) => t.date))].sort();
    const negativeDate = affectedDates.find((date) => balanceUpToAccount(transaction.accountId, date, transaction.id) < -0.0001);
    if (negativeDate) {
      return res.status(400).json({ error: `Can't delete this income because the wallet would go negative on ${negativeDate}. Delete later expenses first.` });
    }
  }
  db.transactions.splice(idx, 1);
  save();
  res.json({ ok: true });
});

// ---------- liabilities ----------

app.get('/api/liabilities', auth, (req, res) => {
  const db = getDb();
  const items = db.liabilities
    .filter((l) => l.userId === req.user.id)
    .map((l) => {
      const paidAmount = liabilityPaidAmount(l);
      return {
        ...l,
        nativeAmount: round2(l.amount),
        paidAmount,
        remainingAmount: round2(Math.max(0, l.amount - paidAmount)),
        daysLeft: Math.round((new Date(l.dueDate) - new Date(todayForRequest(req))) / 86400000)
      };
    })
    .sort((a, b) => (a.status === b.status ? a.dueDate.localeCompare(b.dueDate) : a.status === 'unpaid' ? -1 : 1));
  res.json({ liabilities: items });
});

app.post('/api/liabilities', auth, (req, res) => {
  const { creditor, name, amount, accountId, dueDate } = req.body || {};
  const amt = Number(amount);
  const normalizedAmount = round2(amt);
  const db = getDb();
  if (!String(creditor || '').trim()) return res.status(400).json({ error: 'Enter who you owe' });
  if (!name || !Number.isFinite(normalizedAmount) || normalizedAmount <= 0) return res.status(400).json({ error: 'Reason and a finite positive amount of at least 0.01 are required' });
  if (!isValidDateString(dueDate)) return res.status(400).json({ error: 'Pick a valid due date' });
  const account = db.accounts.find((a) => a.id === Number(accountId) && a.userId === req.user.id);
  if (!account) return res.status(400).json({ error: 'Pick one of your wallets' });
  const liab = {
    id: nextId('liability'),
    userId: req.user.id,
    accountId: account.id,
    creditor: String(creditor).trim().slice(0, 80),
    name: String(name).trim().slice(0, 80),
    amount: normalizedAmount,
    currency: account.currency,
    dueDate,
    status: 'unpaid',
    linkedTransactionId: null,
    payments: [],
    createdAt: new Date().toISOString()
  };
  db.liabilities.push(liab);
  save();
  res.json({ liability: liab });
});

// Partial or full payments create linked expenses on the liability wallet.
app.patch('/api/liabilities/:id', auth, (req, res) => {
  const db = getDb();
  const liab = db.liabilities.find((l) => l.id === Number(req.params.id) && l.userId === req.user.id);
  if (!liab) return res.status(404).json({ error: 'Liability not found' });
  liab.payments ||= [];
  const { status, amount, dueDate } = req.body || {};

  if (dueDate !== undefined && status === undefined) {
    if (!isValidDateString(dueDate)) return res.status(400).json({ error: 'Pick a valid due date' });
    liab.dueDate = dueDate;
  } else if (status === 'paid') {
    const today = todayForRequest(req);
    const remaining = liabilityRemainingAmount(liab);
    const paymentAmount = round2(Number(amount ?? remaining));
    if (remaining <= 0) return res.status(400).json({ error: 'This liability is already fully paid' });
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ error: 'Payment must be a finite positive amount of at least 0.01' });
    }
    if (paymentAmount - remaining > 0.0001) {
      return res.status(400).json({ error: `Payment is greater than the remaining ${remaining} ${liab.currency}` });
    }
    const projected = balanceUpToAccount(liab.accountId, today) - paymentAmount;
    if (projected < -0.0001) {
      const acc = db.accounts.find((a) => a.id === liab.accountId);
      return res.status(400).json({ error: `Not enough balance in "${acc?.name || 'that wallet'}" for this payment.` });
    }
    const tx = {
      id: nextId('tx'),
      userId: req.user.id,
      accountId: liab.accountId,
      type: 'expense',
      amount: paymentAmount,
      currency: liab.currency,
      category: 'Liability',
      ledgerKind: 'liability_payment',
      date: today,
      note: `Paid ${liab.creditor || 'creditor'}: ${liab.name}`.slice(0, 140),
      createdAt: new Date().toISOString()
    };
    db.transactions.push(tx);
    liab.payments.push({ transactionId: tx.id, amount: paymentAmount, date: today, accountId: liab.accountId });
    liab.status = liabilityPaidAmount(liab) >= liab.amount ? 'paid' : 'unpaid';
    liab.linkedTransactionId = tx.id;
    if (liab.status === 'paid') liab.paidDate = today;
    else delete liab.paidDate;
  } else if (status === 'unpaid' && liab.payments.length) {
    const lastPayment = liab.payments[liab.payments.length - 1];
    const txIdx = db.transactions.findIndex((t) => t.id === lastPayment.transactionId && t.userId === req.user.id);
    if (txIdx !== -1) db.transactions.splice(txIdx, 1);
    liab.payments.pop();
    liab.status = 'unpaid';
    liab.linkedTransactionId = liab.payments.at(-1)?.transactionId || null;
    delete liab.paidDate;
  } else {
    return res.status(400).json({ error: 'Invalid status change' });
  }
  save();
  const paidAmount = liabilityPaidAmount(liab);
  res.json({ liability: { ...liab, paidAmount, remainingAmount: round2(Math.max(0, liab.amount - paidAmount)) } });
});

app.delete('/api/liabilities/:id', auth, (req, res) => {
  const db = getDb();
  const idx = db.liabilities.findIndex((l) => l.id === Number(req.params.id) && l.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Liability not found' });
  const liab = db.liabilities[idx];
  const paymentIds = new Set([
    liab.linkedTransactionId,
    ...(liab.payments || []).map((p) => p.transactionId)
  ].filter(Boolean));
  db.transactions = db.transactions.filter((t) => !paymentIds.has(t.id));
  db.liabilities.splice(idx, 1);
  save();
  res.json({ ok: true });
});

// ---------- money with other people ----------

app.get('/api/receivables', auth, (req, res) => {
  const db = getDb();
  const receivables = db.receivables
    .filter((r) => r.userId === req.user.id)
    .map((r) => {
      const paidAmount = round2((r.payments || []).reduce((sum, p) => sum + p.amount, 0));
      return { ...r, paidAmount, remainingAmount: round2(Math.max(0, r.amount - paidAmount)) };
    })
    .slice()
    .sort((a, b) => a.status === b.status
      ? (b.date + b.id).localeCompare(a.date + a.id)
      : a.status === 'outstanding' ? -1 : 1);
  res.json({ receivables });
});

app.post('/api/receivables', auth, (req, res) => {
  const { person, reason, amount, accountId, date } = req.body || {};
  const normalizedAmount = round2(Number(amount));
  const db = getDb();
  const personName = String(person || '').trim().slice(0, 80);
  const reasonText = String(reason || '').trim().slice(0, 160);
  if (!personName) return res.status(400).json({ error: 'Person name is required' });
  if (!reasonText) return res.status(400).json({ error: 'Reason is required' });
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be a finite positive number of at least 0.01' });
  }
  if (!isValidDateString(date)) return res.status(400).json({ error: 'Pick a valid date' });
  if (date > todayForRequest(req)) {
    return res.status(400).json({ error: "Dates can't be in the future — pick today or earlier 📅" });
  }
  const account = db.accounts.find((a) => a.id === Number(accountId) && a.userId === req.user.id);
  if (!account) return res.status(400).json({ error: 'Pick one of your wallets' });
  // Match the available balance displayed in the wallet picker. The record's
  // date is descriptive; the money leaves the user's currently available funds.
  const available = balanceUpToAccount(account.id, todayForRequest(req));
  if (available - normalizedAmount < -0.0001) {
    return res.status(400).json({
      error: `Not enough balance in "${account.name}". Available: ${available} ${account.currency}`
    });
  }
  const outgoingTx = {
    id: nextId('tx'), userId: req.user.id, accountId: account.id,
    type: 'expense', amount: normalizedAmount, currency: account.currency,
    category: 'Other', ledgerKind: 'money_owed_to_user', date,
    note: `Money with ${personName}: ${reasonText}`.slice(0, 140),
    createdAt: new Date().toISOString()
  };
  db.transactions.push(outgoingTx);
  const receivable = {
    id: nextId('receivable'),
    userId: req.user.id,
    sourceAccountId: account.id,
    person: personName,
    reason: reasonText,
    amount: normalizedAmount,
    currency: account.currency,
    date,
    status: 'outstanding',
    outgoingTransactionId: outgoingTx.id,
    linkedTransactionId: null,
    payments: [],
    createdAt: new Date().toISOString()
  };
  db.receivables.push(receivable);
  save();
  res.json({ receivable });
});

function incomeRemovalProblem(db, tx) {
  const dates = [...new Set(db.transactions
    .filter((t) => t.accountId === tx.accountId && t.id !== tx.id && t.date >= tx.date)
    .map((t) => t.date))].sort();
  return dates.find((date) => balanceUpToAccount(tx.accountId, date, tx.id) < -0.0001);
}

function removalProblemForTransactions(db, transactions) {
  const ids = new Set(transactions.map((t) => t.id));
  const accountIds = new Set(transactions.map((t) => t.accountId));
  for (const accountId of accountIds) {
    const removedIncomeDates = transactions
      .filter((t) => t.accountId === accountId && t.type === 'income')
      .map((t) => t.date)
      .sort();
    if (!removedIncomeDates.length) continue;
    const affectedFrom = removedIncomeDates[0];
    const dates = [...new Set(db.transactions
      .filter((t) => t.accountId === accountId && !ids.has(t.id) && t.date >= affectedFrom)
      .map((t) => t.date))].sort();
    for (const date of dates) {
      const balance = db.transactions
        .filter((t) => t.accountId === accountId && !ids.has(t.id) && t.date <= date)
        .reduce((sum, t) => sum + (t.type === 'income' ? t.amount : -t.amount), 0);
      if (balance < -0.0001) return date;
    }
  }
  return null;
}

// Each repayment creates its own linked income. The record remains outstanding
// until all of the original amount has been returned.
app.patch('/api/receivables/:id', auth, (req, res) => {
  const db = getDb();
  const item = db.receivables.find((r) => r.id === Number(req.params.id) && r.userId === req.user.id);
  if (!item) return res.status(404).json({ error: 'Record not found' });
  item.payments ||= [];
  const { status, accountId, amount } = req.body || {};
  if (status === 'returned') {
    const paidSoFar = round2(item.payments.reduce((sum, p) => sum + p.amount, 0));
    const remaining = round2(item.amount - paidSoFar);
    const paymentAmount = round2(Number(amount ?? remaining));
    if (remaining <= 0) return res.status(400).json({ error: 'This money has already been fully paid back' });
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ error: 'Payment must be a finite positive amount of at least 0.01' });
    }
    if (paymentAmount - remaining > 0.0001) {
      return res.status(400).json({ error: `Payment is greater than the remaining ${remaining} ${item.currency}` });
    }
    const account = db.accounts.find((a) => a.id === Number(accountId) && a.userId === req.user.id);
    if (!account) return res.status(400).json({ error: 'Pick one of your wallets' });
    if (account.currency !== item.currency) {
      return res.status(400).json({ error: `Pick a ${item.currency} wallet so no exchange conversion is needed` });
    }
    const paidDate = todayForRequest(req);
    const tx = {
      id: nextId('tx'), userId: req.user.id, accountId: account.id,
      type: 'income', amount: paymentAmount, currency: item.currency,
      category: 'Other Income', ledgerKind: 'money_returned', date: paidDate,
      note: `Paid back by ${item.person}: ${item.reason}`.slice(0, 140),
      createdAt: new Date().toISOString()
    };
    db.transactions.push(tx);
    item.payments.push({ transactionId: tx.id, amount: paymentAmount, date: paidDate, accountId: account.id });
    const newPaidTotal = round2(paidSoFar + paymentAmount);
    item.status = newPaidTotal >= item.amount ? 'returned' : 'outstanding';
    if (item.status === 'returned') item.returnedDate = paidDate;
    else delete item.returnedDate;
    item.linkedTransactionId = tx.id; // latest payment, kept for older clients
  } else if (status === 'outstanding' && item.payments.length) {
    const payment = item.payments[item.payments.length - 1];
    const tx = db.transactions.find((t) => t.id === payment.transactionId && t.userId === req.user.id);
    if (tx) {
      const negativeDate = incomeRemovalProblem(db, tx);
      if (negativeDate) return res.status(400).json({ error: `Can't undo this payment because its wallet would go negative on ${negativeDate}. Delete later expenses first.` });
      db.transactions = db.transactions.filter((t) => t.id !== tx.id);
    }
    item.payments.pop();
    item.status = 'outstanding';
    item.linkedTransactionId = item.payments.at(-1)?.transactionId || null;
    delete item.returnedDate;
  } else {
    return res.status(400).json({ error: 'Invalid status change' });
  }
  save();
  const paidAmount = round2(item.payments.reduce((sum, p) => sum + p.amount, 0));
  res.json({ receivable: { ...item, paidAmount, remainingAmount: round2(Math.max(0, item.amount - paidAmount)) } });
});

app.delete('/api/receivables/:id', auth, (req, res) => {
  const db = getDb();
  const idx = db.receivables.findIndex((r) => r.id === Number(req.params.id) && r.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Record not found' });
  const item = db.receivables[idx];
  const paymentIds = (item.payments || []).map((p) => p.transactionId);
  const linkedIds = new Set([item.outgoingTransactionId, item.linkedTransactionId, ...paymentIds].filter(Boolean));
  const linkedTransactions = db.transactions.filter((t) => linkedIds.has(t.id));
  if (paymentIds.length || item.linkedTransactionId) {
    const negativeDate = removalProblemForTransactions(db, linkedTransactions);
    if (negativeDate) return res.status(400).json({ error: `Can't delete this record because a wallet would go negative on ${negativeDate}. Delete later expenses first.` });
  }
  db.transactions = db.transactions.filter((t) => !linkedIds.has(t.id));
  db.receivables.splice(idx, 1);
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
  db.receivables = db.receivables.filter((r) => r.userId !== id);
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
    console.log(`\n  ✦ Expenzo running →  http://localhost:${PORT}`);
    console.log(`  ✦ admin login: ${process.env.ADMIN_EMAIL || 'existing database administrator'}`);
    console.log(`  ✦ storage: ${cloudMode ? 'Upstash Redis (cloud)' : 'local JSON file'}\n`);
  });
}

export default app;
