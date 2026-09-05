import { getDb, CURRENCIES, fromUSD, round2, todayStr } from './store.js';

// ---------- helpers ----------

const monthKey = (dateStr) => dateStr.slice(0, 7);

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
}

function userTransactions(userId) {
  return getDb().transactions.filter((t) => t.userId === userId);
}

function userLiabilities(userId) {
  return getDb().liabilities.filter((l) => l.userId === userId);
}

export function balanceUpTo(userId, dateStr, excludeTxId = null) {
  let bal = 0;
  for (const t of userTransactions(userId)) {
    if (excludeTxId && t.id === excludeTxId) continue;
    if (t.date <= dateStr) bal += t.type === 'income' ? t.usdAmount : -t.usdAmount;
  }
  return round2(bal);
}

export function balanceUpToAccount(accountId, dateStr, excludeTxId = null) {
  let bal = 0;
  for (const t of getDb().transactions.filter((t) => t.accountId === accountId)) {
    if (excludeTxId && t.id === excludeTxId) continue;
    if (t.date <= dateStr) bal += t.type === 'income' ? t.usdAmount : -t.usdAmount;
  }
  return round2(bal);
}

function accountBalances(userId) {
  const db = getDb();
  return db.accounts
    .filter((a) => a.userId === userId)
    .map((a) => {
      const bal = db.transactions
        .filter((t) => t.accountId === a.id && t.date <= todayStr())
        .reduce((s, t) => s + (t.type === 'income' ? t.usdAmount : -t.usdAmount), 0);
      return { ...a, usd: round2(bal), native: round2(fromUSD(bal, a.currency)) };
    });
}

// ---------- forecasting ----------

function linearForecast(points, ahead) {
  // points: [{x, y}] least-squares line + damped trend projection
  const n = points.length;
  if (n === 0) return Array(ahead).fill(0);
  if (n === 1) return Array(ahead).fill(round2(points[0].y));
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const last = points[n - 1];
  const out = [];
  for (let i = 1; i <= ahead; i++) {
    // trend damped by 0.8 so projections stay grounded
    out.push(Math.max(0, round2(last.y + slope * i * 0.8)));
  }
  return out;
}

export function buildForecast(userId, baseCurrency) {
  const txs = userTransactions(userId);
  const today = new Date().toISOString().slice(0, 10);
  const curMonth = today.slice(0, 7);

  // bucket last up to 8 months
  const months = [];
  const d0 = new Date();
  d0.setDate(1);
  for (let i = 7; i >= 0; i--) {
    const d = new Date(d0);
    d.setMonth(d.getMonth() - i);
    months.push(d.toISOString().slice(0, 7));
  }

  const series = months.map((mk) => {
    const inM = txs.filter((t) => monthKey(t.date) === mk);
    return {
      key: mk,
      label: monthLabel(mk),
      income: round2(inM.filter((t) => t.type === 'income').reduce((s, t) => s + t.usdAmount, 0)),
      expense: round2(inM.filter((t) => t.type === 'expense').reduce((s, t) => s + t.usdAmount, 0))
    };
  });

  const history = series.filter((s) => s.key < curMonth && (s.income > 0 || s.expense > 0));
  const fInc = linearForecast(history.map((s, i) => ({ x: i, y: s.income })), 3);
  const fExp = linearForecast(history.map((s, i) => ({ x: i, y: s.expense })), 3);

  const future = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(d0);
    d.setMonth(d.getMonth() + i);
    const mk = d.toISOString().slice(0, 7);
    future.push({
      key: mk,
      label: monthLabel(mk) + ' (proj.)',
      income: fInc[i - 1],
      expense: fExp[i - 1],
      net: round2(fInc[i - 1] - fExp[i - 1]),
      projected: true
    });
  }

  // next-month category breakdown: average of last 3 active months
  const lastActive = history.slice(-3);
  const catMap = {};
  for (const s of lastActive) {
    const mk = s.key;
    for (const t of txs.filter((t) => t.type === 'expense' && monthKey(t.date) === mk)) {
      catMap[t.category] = (catMap[t.category] || 0) + t.usdAmount;
    }
  }
  const n = Math.max(1, lastActive.length);
  const nextMonthByCategory = Object.entries(catMap)
    .map(([category, usd]) => ({ category, usd: round2(usd / n), base: round2(fromUSD(usd / n, baseCurrency)) }))
    .sort((a, b) => b.usd - a.usd);

  const base = (usd) => round2(fromUSD(usd, baseCurrency));

  return {
    baseCurrency,
    history: series.map((s) => ({ ...s, incomeBase: base(s.income), expenseBase: base(s.expense) })),
    future: future.map((f) => ({ ...f, incomeBase: base(f.income), expenseBase: base(f.expense) })),
    nextMonth: {
      income: base(fInc[0] || 0),
      expense: base(fExp[0] || 0),
      net: base((fInc[0] || 0) - (fExp[0] || 0)),
      byCategory: nextMonthByCategory
    },
    monthlyAvgExpense: base(history.length ? history.reduce((s, h) => s + h.expense, 0) / history.length : 0)
  };
}

// ---------- alerts ----------

export function buildAlerts(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date();
  soon.setDate(soon.getDate() + 7);
  const soonStr = soon.toISOString().slice(0, 10);

  const items = userLiabilities(userId)
    .filter((l) => l.status === 'unpaid')
    .map((l) => {
      let level = null;
      if (l.dueDate < today) level = 'overdue';
      else if (l.dueDate <= soonStr) level = 'due-soon';
      return { ...l, nativeAmount: round2(l.amount), level, daysLeft: Math.round((new Date(l.dueDate) - new Date(today)) / 86400000) };
    })
    .filter((l) => l.level);

  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return {
    overdue: items.filter((i) => i.level === 'overdue'),
    dueSoon: items.filter((i) => i.level === 'due-soon'),
    all: items
  };
}

// ---------- AI assistant ----------

export function chatReply(userId, message, baseCurrency) {
  const msg = message.toLowerCase().trim();
  const db = getDb();
  const user = db.users.find((u) => u.id === userId);
  const cur = CURRENCIES[baseCurrency] || CURRENCIES.USD;
  const fmt = (usd) => `${cur.symbol}${fromUSD(usd, baseCurrency).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);

  const txs = userTransactions(userId);
  const settled = txs.filter((t) => t.date <= today);
  const balance = settled.reduce((s, t) => s + (t.type === 'income' ? t.usdAmount : -t.usdAmount), 0);
  const alerts = buildAlerts(userId);
  const forecast = buildForecast(userId, baseCurrency);

  const has = (...words) => words.some((w) => msg.includes(w));

  // greeting
  if (/^(hi|hello|hey|yo|salam|salaam|sup|hola)\b/.test(msg) || msg === 'hi') {
    return `heyy ${user.name.split(' ')[0]} 👋 i'm **Zeno**, your money bestie. i can break down your spending, check your balance, remind you about debts, or predict next month. try *"how much did i spend on food this month?"* or *"what do i owe?"*`;
  }

  // help
  if (has('help', 'what can you do', 'commands')) {
    return [
      "here's what i got for you ✨",
      '- **balance** — what you can spend right now',
      '- **spending by category** — *"how much did i spend on food?"*',
      '- **top / biggest expenses** — where your money ghosted to',
      '- **income** — what\'s coming in',
      '- **debts / due** — liabilities & due-date alerts',
      '- **forecast** — next month prediction',
      '- **advice** — a quick financial read on you'
    ].join('\n');
  }

  // balance
  if (has('balance', 'how much money', 'can i afford', 'how much can i spend', 'net worth')) {
    const scheduled = txs.filter((t) => t.date > today);
    const accounts = accountBalances(userId);
    let out = `your total available balance is **${fmt(balance)}** 💰`;
    if (accounts.length > 1) {
      out += ', split across your wallets:\n' + accounts.map((a) => `- **${a.name}** (${a.currency}): ${CURRENCIES[a.currency]?.symbol || ''}${a.native.toLocaleString('en-US', { maximumFractionDigits: 2 })}`).join('\n');
    }
    if (scheduled.length) {
      const schedIn = scheduled.filter((t) => t.type === 'income').reduce((s, t) => s + t.usdAmount, 0);
      const schedOut = scheduled.filter((t) => t.type === 'expense').reduce((s, t) => s + t.usdAmount, 0);
      out += `\n\nplus older scheduled entries: **${fmt(schedIn)}** in, **${fmt(schedOut)}** out.`;
    }
    if (alerts.overdue.length) out += `\n\n⚠️ heads up: ${alerts.overdue.length} liability is **overdue** — tap the Liabilities tab.`;
    return out;
  }

  // liabilities / debts
  if (has('owe', 'debt', 'due', 'liabilit', 'loan', 'borrow', 'bill reminder', 'alert')) {
    const unpaid = userLiabilities(userId).filter((l) => l.status === 'unpaid');
    if (!unpaid.length) return "you're clean — zero unpaid liabilities 🧼✨";
    const total = unpaid.reduce((s, l) => s + l.usdAmount, 0);
    let out = `you owe **${fmt(total)}** across ${unpaid.length} ${unpaid.length > 1 ? 'liabilities' : 'liability'}:`;
    for (const l of unpaid.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 6)) {
      const days = Math.round((new Date(l.dueDate) - new Date(today)) / 86400000);
      const tag = l.dueDate < today ? '🔴 OVERDUE' : days <= 7 ? `🟡 due in ${days}d` : `📅 ${l.dueDate}`;
      out += `\n- ${l.name} — ${fmt(l.usdAmount)} · ${tag}`;
    }
    return out;
  }

  // forecast
  if (has('forecast', 'predict', 'next month', 'projection', 'future', 'how much will')) {
    const nm = forecast.nextMonth;
    return [
      `crunching your last months of data 📈 here's the vibe for next month:`,
      `- expected income: **${fmt(nm.income)}**`,
      `- expected spending: **${fmt(nm.expense)}**`,
      `- projected net: **${nm.net >= 0 ? '+' : ''}${fmt(nm.net)}** ${nm.net >= 0 ? '🟢' : '🔴'}`
    ].join('\n') +
      (nm.byCategory.length ? `\n\nbiggest expected categories: ` + nm.byCategory.slice(0, 3).map((c) => `${c.category} (~${fmt(c.usd)})`).join(', ') : '');
  }

  // income
  if (has('income', 'earn', 'salary', 'make money', 'revenue')) {
    const inMonth = settled.filter((t) => t.type === 'income' && monthKey(t.date) === thisMonth).reduce((s, t) => s + t.usdAmount, 0);
    const total = settled.filter((t) => t.type === 'income').reduce((s, t) => s + t.usdAmount, 0);
    return `this month you brought in **${fmt(inMonth)}** 💸 and **${fmt(total)}** all-time. next month i'm predicting **${fmt(forecast.nextMonth.income)}**.`;
  }

  // biggest expense / top categories
  if (has('biggest', 'top', 'most expensive', 'where did my money', 'spending breakdown', 'breakdown')) {
    const exp = settled.filter((t) => t.type === 'expense');
    if (!exp.length) return "no expenses logged yet — living that free-cost life? 😅";
    const byCat = {};
    for (const t of exp) byCat[t.category] = (byCat[t.category] || 0) + t.usdAmount;
    const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const total = exp.reduce((s, t) => s + t.usdAmount, 0);
    let out = 'your money went like this:\n';
    for (const [cat, usd] of top) {
      const pct = Math.round((usd / total) * 100);
      out += `\n- **${cat}** — ${fmt(usd)} (${pct}%)`;
    }
    return out;
  }

  // spending on a category
  const spendMatch = msg.match(/(?:spend|spent|expense|paid|pay|cost|bought)/);
  if (spendMatch) {
    const exp = settled.filter((t) => t.type === 'expense');
    // find a category mentioned
    const cats = ['food', 'rent', 'transport', 'shopping', 'entertainment', 'health', 'education', 'bills', 'subscriptions', 'travel', 'other'];
    const cat = cats.find((c) => msg.includes(c));
    const isMonth = has('this month', 'monthly');
    const pool = isMonth ? exp.filter((t) => monthKey(t.date) === thisMonth) : exp;
    if (cat) {
      const cname = cat === 'other' ? 'Other' : cat[0].toUpperCase() + cat.slice(1);
      const matched = pool.filter((t) => t.category.toLowerCase() === cname.toLowerCase());
      const sum = matched.reduce((s, t) => s + t.usdAmount, 0);
      const scope = isMonth ? 'this month' : 'all time';
      if (!matched.length) return `zero spent on **${cname}** ${scope} 🙌`;
      return `you've spent **${fmt(sum)}** on ${cname} ${scope} across ${matched.length} transaction${matched.length > 1 ? 's' : ''}. ${sum > balance * 0.3 ? "that's a chunk of your balance 👀" : 'pretty chill ngl ✨'}`;
    }
    const sum = pool.reduce((s, t) => s + t.usdAmount, 0);
    return `total spending ${isMonth ? 'this month' : 'all time'} is **${fmt(sum)}**. ask me about a specific category like *"food"* or *"transport"* for the breakdown 🔍`;
  }

  // advice
  if (has('advice', 'tip', 'should i', 'save', 'saving', 'budget')) {
    const exp = settled.filter((t) => t.type === 'expense' && monthKey(t.date) === thisMonth).reduce((s, t) => s + t.usdAmount, 0);
    const inc = settled.filter((t) => t.type === 'income' && monthKey(t.date) === thisMonth).reduce((s, t) => s + t.usdAmount, 0);
    const rate = inc > 0 ? Math.round(((inc - exp) / inc) * 100) : 0;
    let out = inc === 0
      ? "log some income first and i'll cook up real advice 👨‍🍳"
      : `your savings rate this month is **${rate}%** ${rate >= 20 ? '— lowkey impressive 🏆' : rate >= 0 ? '— solid, but there\'s room 👀' : '— bestie you\'re spending more than you make 😭'}`;
    if (alerts.overdue.length) out += `\n- 🚨 clear that **overdue liability** first, late fees are not the vibe.`;
    else if (alerts.dueSoon.length) out += `\n- 🟡 a payment is due within 7 days — keep cash ready.`;
    if (forecast.nextMonth.byCategory[0]) out += `\n- your biggest leak is **${forecast.nextMonth.byCategory[0].category}** (~${fmt(forecast.nextMonth.byCategory[0].usd)}/mo). trimming it 15% saves you ~${fmt(forecast.nextMonth.byCategory[0].usd * 0.15)}.`;
    out += `\n- aim for a 20% savings rate — future you says thanks 🫡`;
    return out;
  }

  // thanks / bye
  if (has('thank', 'thanks', 'bye', 'love you')) {
    return "anytime bestie 💜 keep that balance glowing ✨";
  }

  // fallback
  return `hmm i didn't fully catch that 🤔 i'm great at: **balance**, **spending on a category**, **debts & due dates**, **forecast for next month**, and **advice**. try one of those!`;
}
