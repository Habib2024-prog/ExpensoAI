import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RATES_PATH = path.join(__dirname, '..', 'data', 'rates.json');
const REFRESH_MS = 6 * 60 * 60 * 1000; // every 6h

// offline fallback, only used until the first successful live fetch
export const FALLBACK_RATES = {
  USD: 1, AFN: 70.85, PKR: 281.5, EUR: 0.85, GBP: 0.735, INR: 88.0,
  AED: 3.6725, SAR: 3.75, IRR: 421000, IQD: 1310, TRY: 42.3,
  CNY: 7.13, CAD: 1.38, AUD: 1.52
};

let cache = null;

function loadFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(RATES_PATH, 'utf8'));
    if (raw?.rates && Object.keys(raw.rates).length > 5) {
      cache = { rates: raw.rates, updatedAt: raw.updatedAt, live: raw.live !== false };
    }
  } catch { /* first run */ }
}

function persist() {
  try {
    fs.writeFileSync(RATES_PATH, JSON.stringify(cache));
  } catch { /* non-fatal */ }
}

export function getRates() {
  if (!cache) loadFromDisk();
  if (!cache) cache = { rates: { ...FALLBACK_RATES }, updatedAt: Date.now(), live: false };
  return cache;
}

export function getRate(currency) {
  const { rates } = getRates();
  return rates[currency] || FALLBACK_RATES[currency] || null;
}

export function isLive() {
  return getRates().live === true;
}

export async function refreshRates() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: ctrl.signal });
    clearTimeout(t);
    const json = await res.json();
    if (json.result === 'success' && json.rates) {
      const prev = getRates();
      cache = { rates: json.rates, updatedAt: Date.now(), live: true, source: 'open.er-api.com' };
      if (prev.updatedAt !== cache.updatedAt) persist();
      return true;
    }
  } catch { /* offline: keep cached/fallback rates */ }
  return false;
}

export function startRateRefresh() {
  loadFromDisk();
  refreshRates();
  setInterval(refreshRates, REFRESH_MS);
}

export const toUSD = (amount, currency) => amount / getRate(currency);
export const fromUSD = (usd, currency) => usd * getRate(currency);
