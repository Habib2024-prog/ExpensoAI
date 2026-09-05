# Expenzo ✦ — money, but make it aesthetic

A premium Gen-Z expense tracker. Track **income, expenses and liabilities** in **14 currencies**, chat with **Zeno AI** about your money, get **forecasts**, and run everything behind **admin-verified accounts**.

## Run it

```bash
npm install
npm start
# → http://localhost:3000
```

`PORT` is respected (`PORT=8080 npm start`).

## Deploy

### Vercel (free)

The app runs as a Vercel serverless function with data stored in Upstash Redis (free tier) — the serverless filesystem is read-only, so a plain `data/` folder won't work there.

1. Push this repo to GitHub.
2. Create a free database at [upstash.com](https://upstash.com) (Redis) and copy the `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` from its dashboard.
3. Import the repo in Vercel and set the environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | yes (Vercel) | cloud database endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | yes (Vercel) | cloud database token |
| `ADMIN_EMAIL` | no | admin created on first boot (default `habibullahanoosha2019@gmail.com`) |
| `ADMIN_PASSWORD` | no | admin password (**set your own**) |
| `ADMIN_NAME` / `ADMIN_CURRENCY` | no | admin display name / base currency |

4. Deploy. Every API request syncs through Redis, so data survives cold starts and redeploys.

### Railway / Render / Fly.io / VPS (long-running host)

No changes needed — the app stores data in `data/db.json` locally. On hosts with ephemeral disks, attach a persistent volume mounted at the app's `data/` folder. Run a single instance (file storage isn't multi-replica safe); the storage layer is isolated in `src/store.js` if you ever want to swap in Postgres/Mongo.

## Admin account

On first boot the app creates the admin from the `ADMIN_*` environment variables (defaults: `habibullahanoosha2019@gmail.com` / `Anoosha0101`). New sign-ups are pending until this admin verifies them from the **Admin** tab. The admin can change their password anytime (🔑 in the sidebar).

## Features

- **Auth + admin verification** — sign-ups land in a *pending* state and can't log in until an admin approves them in the **Admin** tab (verify / reject / delete).
- **Multi-currency wallets** 🪙 — every user gets a "Main" wallet in their signup currency and can add **more wallets in other currencies** from the dashboard. Each wallet keeps its own currency and balance; the total converts at live rates. Base currency is locked at signup.
- **Live exchange rates** — rates pulled from `open.er-api.com` every 6h (cached in `data/rates.json`, offline fallback built in). The header ticker and wallet cards show the real rate.
- **Income & expenses** — categorize, note, date them (**today or earlier only**). Entries save in the wallet's currency.
- **Over-balance guard** 🚫 — an expense is rejected if it would push *that wallet's* balance below zero.
- **Liabilities + due-date alerts** ⏰ — debts with due dates, tied to a wallet; overdue (🔴) and due-within-7-days (🟡) alerts in the bell, dashboard, and nav badge. Marking one *paid* records a linked expense on that wallet (undo reverses it).
- **Zeno AI** 🤖 — a local assistant that reads your live data: total + per-wallet balance, spending by category, top leaks, what you owe, next-month forecast, and advice. No external API needed.
- **Forecasting** 📈 — linear-regression trend (damped) over your history projects income, spending, and net for the next 3 months, plus an expected category breakdown, drawn as an SVG chart.
- **Custom dropdowns** — styled currency/category/wallet pickers instead of native selects.
- **Receipt upload + OCR** 🧾 — in the Add-transaction modal, upload a receipt photo (click, drag & drop or paste from clipboard); on-device OCR (Tesseract.js) with image preprocessing (upscale, grayscale, contrast stretch) extracts the total, date and merchant and prefills the form for you to confirm.
- **Passwords** 🔑 — every user can change their own password (sidebar/mobile profile → 🔑); admins can set a new password for any user from the Admin tab.
- **Light & dark mode** 🌙☀️ — theme toggle in the header (and on the login page); your choice is remembered.
- **Premium Gen-Z UI** — dark glassmorphism, animated gradient blobs, Space Grotesk, mobile bottom-nav, toasts, fully responsive.

## Tech

- **Backend:** Node.js + Express, JSON-file storage (`data/db.json`), scrypt password hashing, bearer-token sessions. Zero native deps.
- **Rates:** `src/rates.js` — `https://open.er-api.com/v6/latest/USD`, 6h refresh, fallback table if offline.
- **Frontend:** vanilla JS SPA (`public/`) — no build step.

## API sketch

`POST /api/register · /api/login · /api/logout` — `GET/PUT /api/me` — `GET /api/summary` — `GET/POST/DELETE /api/transactions` — `GET/POST/PATCH/DELETE /api/liabilities` — `GET /api/forecast` — `POST /api/chat` — `GET /api/admin/users · /api/admin/stats`, `PATCH/DELETE /api/admin/users/:id` (admin only).
