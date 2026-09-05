import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { toUSD, fromUSD } from './rates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

export { toUSD, fromUSD };

// static display metadata (symbols/names); numeric rates come from src/rates.js
export const CURRENCIES = {
  USD: { name: 'US Dollar', symbol: '$' },
  AFN: { name: 'Afghan Afghani', symbol: '؋' },
  PKR: { name: 'Pakistani Rupee', symbol: '₨' },
  EUR: { name: 'Euro', symbol: '€' },
  GBP: { name: 'British Pound', symbol: '£' },
  INR: { name: 'Indian Rupee', symbol: '₹' },
  AED: { name: 'UAE Dirham', symbol: 'د.إ' },
  SAR: { name: 'Saudi Riyal', symbol: '﷼' },
  IRR: { name: 'Iranian Rial', symbol: '﷼' },
  IQD: { name: 'Iraqi Dinar', symbol: 'ع.د' },
  TRY: { name: 'Turkish Lira', symbol: '₺' },
  CNY: { name: 'Chinese Yuan', symbol: '¥' },
  CAD: { name: 'Canadian Dollar', symbol: 'C$' },
  AUD: { name: 'Australian Dollar', symbol: 'A$' }
};

export const CATEGORIES = {
  income: ['Salary', 'Freelance', 'Business', 'Gift', 'Investment', 'Other Income'],
  expense: ['Food', 'Rent', 'Transport', 'Shopping', 'Entertainment', 'Health', 'Education', 'Bills', 'Subscriptions', 'Travel', 'Liability', 'Other']
};

let db;

// ---- cloud storage (Vercel/Upstash) vs local JSON file ----
// When UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set, the whole
// database lives in Redis so serverless hosts with read-only filesystems work.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
export const cloudMode = Boolean(REDIS_URL && REDIS_TOKEN);
const DB_KEY = 'expenzo:db';
let pendingWrite = Promise.resolve();
let lastError = null;

const emptyDb = () => ({ users: [], sessions: {}, accounts: [], transactions: [], liabilities: [], counters: {} });

async function redisCmd(commands) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    body: JSON.stringify([commands])
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return res.json();
}

export function getDb() {
  return db;
}

export function load() {
  if (db) return db;
  if (cloudMode) {
    // real state arrives via reload() on each request; seed on first write if empty
    db = emptyDb();
    return db;
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    migrate();
  } else {
    db = emptyDb();
    seed();
    save();
  }
  return db;
}

// pull the latest state from Redis before handling a request (cloud mode only)
export async function reload() {
  if (!cloudMode) return;
  await pendingWrite;
  try {
    const r = await redisCmd(['GET', DB_KEY]);
    const raw = r?.[0]?.result;
    if (raw) {
      const fresh = JSON.parse(raw);
      for (const k of Object.keys(db)) db[k] = fresh[k] ?? emptyDb()[k];
    } else if (!db.users.length) {
      seed();
      await writeCloud();
    }
    lastError = null;
  } catch (e) {
    lastError = 'cloud load failed: ' + e.message;
    console.error(lastError);
  }
}

export function getStoreStatus() {
  return {
    cloudMode,
    ok: cloudMode ? !lastError && db.users.length > 0 : true,
    lastError,
    userCount: db.users.length
  };
}

function writeCloud() {
  pendingWrite = pendingWrite
    .then(() => redisCmd(['SET', DB_KEY, JSON.stringify(db)]))
    .catch((e) => console.error('cloud save failed:', e.message));
  return pendingWrite;
}

export function save() {
  if (cloudMode) { writeCloud(); return; }
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// bring older databases up to the accounts model
function migrate() {
  let touched = false;
  db.accounts ||= [];
  for (const user of db.users) {
    let accounts = db.accounts.filter((a) => a.userId === user.id);
    if (!accounts.length) {
      const acc = {
        id: nextId('account'),
        userId: user.id,
        name: 'Main',
        currency: user.currency,
        createdAt: new Date().toISOString()
      };
      db.accounts.push(acc);
      accounts = [acc];
      touched = true;
    }
    const primary = accounts[0];
    for (const t of db.transactions.filter((t) => t.userId === user.id && !t.accountId)) {
      t.accountId = primary.id;
      touched = true;
    }
    for (const l of db.liabilities.filter((l) => l.userId === user.id && !l.accountId)) {
      l.accountId = primary.id;
      touched = true;
    }
  }
  if (touched) save();
}

export function nextId(kind) {
  db.counters[kind] = (db.counters[kind] || 0) + 1;
  return db.counters[kind];
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

export const round2 = (n) => Math.round(n * 100) / 100;
export const round4 = (n) => Math.round(n * 10000) / 10000;

export const todayStr = () => new Date().toISOString().slice(0, 10);



export function createDefaultAccount(userId, currency, name = 'Main') {
  const acc = {
    id: nextId('account'),
    userId,
    name: String(name || 'Main').trim().slice(0, 40) || 'Main',
    currency,
    createdAt: new Date().toISOString()
  };
  db.accounts.push(acc);
  return acc;
}

function seed() {
  // the site owner — no demo accounts. override via env vars on your host.
  const email = process.env.ADMIN_EMAIL || 'habibullahanoosha2019@gmail.com';
  const password = process.env.ADMIN_PASSWORD || 'Anoosha0101';
  const name = process.env.ADMIN_NAME || 'Khaliqyar';
  const currency = process.env.ADMIN_CURRENCY || 'PKR';
  const { salt, hash } = hashPassword(password);
  const admin = {
    id: nextId('user'),
    name,
    email: email.toLowerCase(),
    passHash: hash,
    salt,
    role: 'admin',
    status: 'active',
    currency,
    createdAt: new Date().toISOString()
  };
  db.users.push(admin);
  createDefaultAccount(admin.id, currency, 'Main');
}
