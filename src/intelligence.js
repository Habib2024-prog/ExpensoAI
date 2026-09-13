import { getDb, CURRENCIES, round2, todayStr } from './store.js';

const monthKey = (dateStr) => dateStr.slice(0, 7);

function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
}

function userTransactions(userId) {
  return getDb().transactions.filter((transaction) => transaction.userId === userId);
}

function userLiabilities(userId) {
  return getDb().liabilities.filter((liability) => liability.userId === userId);
}

function currencyTransactions(userId, currency) {
  return userTransactions(userId).filter((transaction) => transaction.currency === currency);
}

const amountFor = (items, type) => round2(items
  .filter((item) => !type || item.type === type)
  .reduce((total, item) => total + item.amount, 0));

export function balanceUpTo(userId, dateStr, excludeTxId = null) {
  let balance = 0;
  for (const transaction of userTransactions(userId)) {
    if (excludeTxId && transaction.id === excludeTxId) continue;
    if (transaction.date <= dateStr) balance += transaction.type === 'income' ? transaction.amount : -transaction.amount;
  }
  return round2(balance);
}

// Each account contains exactly one currency, so its balance cannot move with
// exchange-rate changes.
export function balanceUpToAccount(accountId, dateStr, excludeTxId = null) {
  let balance = 0;
  for (const transaction of getDb().transactions.filter((item) => item.accountId === accountId)) {
    if (excludeTxId && transaction.id === excludeTxId) continue;
    if (transaction.date <= dateStr) balance += transaction.type === 'income' ? transaction.amount : -transaction.amount;
  }
  return round2(balance);
}

function accountBalances(userId) {
  const db = getDb();
  return db.accounts.filter((account) => account.userId === userId).map((account) => {
    const transactions = db.transactions.filter((transaction) => transaction.accountId === account.id && transaction.date <= todayStr());
    return { ...account, native: round2(amountFor(transactions, 'income') - amountFor(transactions, 'expense')) };
  });
}

function linearForecast(points, ahead) {
  const count = points.length;
  if (count === 0) return Array(ahead).fill(0);
  if (count === 1) return Array(ahead).fill(round2(points[0].y));
  const meanX = points.reduce((total, point) => total + point.x, 0) / count;
  const meanY = points.reduce((total, point) => total + point.y, 0) / count;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const last = points[count - 1];
  return Array.from({ length: ahead }, (_, index) => Math.max(0, round2(last.y + slope * (index + 1) * 0.8)));
}

// Forecasts only use wallets in the selected currency. Different currencies
// remain separate and are never converted or added together.
export function buildForecast(userId, currency) {
  const transactions = currencyTransactions(userId, currency);
  const today = todayStr();
  const currentMonth = today.slice(0, 7);
  const months = [];
  const firstOfMonth = new Date();
  firstOfMonth.setDate(1);
  for (let index = 7; index >= 0; index--) {
    const date = new Date(firstOfMonth);
    date.setMonth(date.getMonth() - index);
    months.push(date.toISOString().slice(0, 7));
  }

  const history = months.map((key) => {
    const inMonth = transactions.filter((transaction) => monthKey(transaction.date) === key);
    return { key, label: monthLabel(key), income: amountFor(inMonth, 'income'), expense: amountFor(inMonth, 'expense') };
  });
  const activeHistory = history.filter((item) => item.key < currentMonth && (item.income > 0 || item.expense > 0));
  const incomeForecast = linearForecast(activeHistory.map((item, index) => ({ x: index, y: item.income })), 3);
  const expenseForecast = linearForecast(activeHistory.map((item, index) => ({ x: index, y: item.expense })), 3);
  const future = [];
  for (let index = 1; index <= 3; index++) {
    const date = new Date(firstOfMonth);
    date.setMonth(date.getMonth() + index);
    const key = date.toISOString().slice(0, 7);
    future.push({ key, label: `${monthLabel(key)} (proj.)`, income: incomeForecast[index - 1], expense: expenseForecast[index - 1], net: round2(incomeForecast[index - 1] - expenseForecast[index - 1]), projected: true });
  }

  const recentActive = activeHistory.slice(-3);
  const categories = {};
  for (const month of recentActive) {
    for (const transaction of transactions.filter((item) => item.type === 'expense' && monthKey(item.date) === month.key)) {
      categories[transaction.category] = (categories[transaction.category] || 0) + transaction.amount;
    }
  }
  const periods = Math.max(1, recentActive.length);
  const byCategory = Object.entries(categories)
    .map(([category, amount]) => ({ category, amount: round2(amount / periods) }))
    .sort((left, right) => right.amount - left.amount);

  return {
    currency,
    history,
    future,
    nextMonth: { income: incomeForecast[0] || 0, expense: expenseForecast[0] || 0, net: round2((incomeForecast[0] || 0) - (expenseForecast[0] || 0)), byCategory },
    monthlyAvgExpense: round2(activeHistory.length ? activeHistory.reduce((total, item) => total + item.expense, 0) / activeHistory.length : 0)
  };
}

export function buildAlerts(userId) {
  const today = todayStr();
  const all = userLiabilities(userId).filter((liability) => liability.status === 'unpaid').map((liability) => {
    const daysLeft = Math.round((new Date(liability.dueDate) - new Date(today)) / 86400000);
    const level = daysLeft < 0 ? 'overdue' : daysLeft <= 7 ? 'due-soon' : null;
    return { ...liability, nativeAmount: round2(liability.amount), level, daysLeft };
  }).filter((liability) => liability.level);
  return {
    all,
    overdue: all.filter((liability) => liability.level === 'overdue'),
    dueSoon: all.filter((liability) => liability.level === 'due-soon')
  };
}

export function chatReply(userId, message, currency) {
  const user = getDb().users.find((item) => item.id === userId);
  const transactions = currencyTransactions(userId, currency);
  const settled = transactions.filter((transaction) => transaction.date <= todayStr());
  const thisMonth = todayStr().slice(0, 7);
  const forecast = buildForecast(userId, currency);
  const balance = round2(amountFor(settled, 'income') - amountFor(settled, 'expense'));
  const format = (amount, code = currency) => `${(CURRENCIES[code] || { symbol: `${code} ` }).symbol}${round2(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const words = String(message || '').toLowerCase();
  const has = (...terms) => terms.some((term) => words.includes(term));

  if (/\b(?:hello|hi|hey)\b/.test(words)) return `Hello ${user?.name?.split(' ')[0] || 'there'}. I track each wallet in its own currency without exchange-rate conversion.`;

  if (has('balance', 'how much money', 'can i afford', 'how much can i spend', 'net worth')) {
    const accounts = accountBalances(userId);
    let reply = `Your ${currency} wallet balance is **${format(balance)}**.`;
    if (accounts.length) reply += '\n\nWallet balances are kept separate:\n' + accounts.map((account) => `- **${account.name}** (${account.currency}): ${format(account.native, account.currency)}`).join('\n');
    return reply;
  }

  if (has('owe', 'debt', 'due', 'liabilit', 'loan', 'borrow', 'bill reminder', 'alert')) {
    const unpaid = userLiabilities(userId).filter((liability) => liability.status === 'unpaid');
    if (!unpaid.length) return 'You have no unpaid liabilities.';
    return 'Open liabilities (kept in their own currencies):\n' + unpaid.sort((left, right) => left.dueDate.localeCompare(right.dueDate)).slice(0, 6).map((liability) => `- **${liability.name}** - ${format(liability.amount, liability.currency)} - due ${liability.dueDate}`).join('\n');
  }

  if (has('forecast', 'predict', 'next month', 'projection', 'future', 'how much will')) {
    const next = forecast.nextMonth;
    return `For your ${currency} wallets next month: income **${format(next.income)}**, spending **${format(next.expense)}**, net **${next.net >= 0 ? '+' : ''}${format(next.net)}**.`;
  }

  if (has('income', 'earn', 'salary', 'make money', 'revenue')) {
    const monthIncome = amountFor(settled.filter((transaction) => monthKey(transaction.date) === thisMonth), 'income');
    return `In ${currency}, you earned **${format(monthIncome)}** this month and **${format(amountFor(settled, 'income'))}** all time.`;
  }

  const expenses = settled.filter((transaction) => transaction.type === 'expense');
  if (has('biggest', 'top', 'most expensive', 'where did my money', 'spending breakdown', 'breakdown')) {
    if (!expenses.length) return `No ${currency} expenses have been logged yet.`;
    const categories = {};
    for (const expense of expenses) categories[expense.category] = (categories[expense.category] || 0) + expense.amount;
    const total = amountFor(expenses);
    return 'Your spending by category:\n' + Object.entries(categories).sort((left, right) => right[1] - left[1]).slice(0, 5).map(([category, amount]) => `- **${category}** - ${format(amount)} (${Math.round((amount / total) * 100)}%)`).join('\n');
  }

  if (has('spend', 'spent', 'expense', 'paid', 'pay', 'cost', 'bought')) {
    const category = ['food', 'rent', 'transport', 'shopping', 'entertainment', 'health', 'education', 'bills', 'subscriptions', 'travel', 'other'].find((item) => words.includes(item));
    const monthly = has('this month', 'monthly');
    const pool = monthly ? expenses.filter((transaction) => monthKey(transaction.date) === thisMonth) : expenses;
    if (category) {
      const name = category === 'other' ? 'Other' : category[0].toUpperCase() + category.slice(1);
      const matching = pool.filter((transaction) => transaction.category.toLowerCase() === name.toLowerCase());
      return matching.length ? `You spent **${format(amountFor(matching))}** on ${name} ${monthly ? 'this month' : 'all time'}.` : `No ${name} spending was found ${monthly ? 'this month' : 'yet'}.`;
    }
    return `Total ${currency} spending ${monthly ? 'this month' : 'all time'} is **${format(amountFor(pool))}**.`;
  }

  if (has('advice', 'tip', 'should i', 'save', 'saving', 'budget')) {
    const monthlyIncome = amountFor(settled.filter((transaction) => monthKey(transaction.date) === thisMonth), 'income');
    const monthlyExpense = amountFor(settled.filter((transaction) => monthKey(transaction.date) === thisMonth), 'expense');
    if (!monthlyIncome) return `Add ${currency} income first and I can calculate a useful savings rate.`;
    return `Your ${currency} savings rate this month is **${Math.round(((monthlyIncome - monthlyExpense) / monthlyIncome) * 100)}%**. Keep each currency wallet budgeted separately.`;
  }

  return `I can help with balances, spending, liabilities, forecasts, and advice. Figures stay in each wallet's original currency without conversion.`;
}
