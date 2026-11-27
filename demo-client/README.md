# Demo client: Acme Store (S2)

A small online shop that shows **why** the Feature Flag Manager exists. Every feature of the shop
is switched by one of the "Acme Web" team's flags in the Feature Flag Manager: 28 flags (plus 2 spare demo keys, below), from the
winter banner and dark mode to Apple Pay, gift wrap and the new one-page checkout. Change a flag
or a rollout percentage in the Feature Flag Manager, press **Refresh flags** in the store, and the
shop changes with no redeploy.

```
browser ──GET /api/flags?user=u-981──▶ store server function ──POST /api/v1/evaluations/batch──▶ Feature Flag Manager
        ◀── 30 × { key, enabled } ───                         ◀── Bearer ffm_stg_… (secret) ──
```

## What it shows

| Area | Flags |
|---|---|
| Site | `promo-banner-winter`, `black-friday-2025` (archived), `dark-mode`, `currency-switcher`, `store-locator`, `search-filters-v2`, `live-chat`, `newsletter-popup`, `free-shipping-banner`, `free-shipping-banner-2` (spare demo keys) |
| Products | `product-reviews-v2`, `recommendations-ml`, `size-guide`, `stock-alerts`, `wishlist-sharing` |
| Basket | `gift-wrap`, `bundle-discounts` |
| Checkout | `new-checkout`, `guest-checkout`, `address-autocomplete`, `express-shipping`, `apple-pay`, `google-pay`, `paypal-v1` (archived) |
| Account | `loyalty-tiers`, `one-click-reorder`, `order-tracking-map`, `returns-portal`, `cart-reminders`, `dark-mode-emails` |

The list lives in `lib/store-flags.js`. The two archived flags are there on purpose: they are
always off, whatever their old settings were.

**Shoppers.** The shopper menu uses the user ids that the Feature Flag Manager's staging rules
name (`backend/db/seed-demo.js`), so the allow and block lists can be shown live:

| Shopper | Why it is interesting |
|---|---|
| Amira `u-981`, Ben `u-123`, Chloe `u-2048`, Dan `u-7` | Regular shoppers: the percentages decide |
| Bea `u-beta-1`, Bilal `u-beta-2` | On the allow list of `new-checkout`: new checkout even at 0% |
| Flagged account `u-fraud-77` | On the block list of `new-checkout`: classic checkout even at 100% |
| QA iPhone `qa-iphone-1` | On the allow list of `apple-pay` |
| Data team `data-team-1` | On the allow list of `recommendations-ml` |

Any other id can be typed in the demo bar.

**Evidence helpers.** The dark demo bar at the top is not part of the shop:
- **Show flag names** puts a small purple `⚑ flag-key` label next to every feature a flag turned on.
- **Flag inspector** lists every store flag as ON/OFF for the shopper, says whether the answer came
  from the Feature Flag Manager (environment, time, one request) or from the fallback, and marks
  the rows that changed since the last **Refresh flags**.

## Security choices

- **The API key never reaches the browser.** Only the store's own server function (`api/flags.js`)
  holds it, as an environment variable. The browser only sees on/off values.
- **Staging key only.** The key decides the environment, so the store can never read prod values.
- **Fixed flag list.** The server always asks for the flags in `lib/store-flags.js`. The browser
  chooses the shopper, never the flags, so the store cannot be used to read the team's other flags.
- **One request per shopper.** `POST /evaluations/batch` returns every flag at once and counts as
  one request against the key's limit of 120 per minute.
- **Fail closed.** If the flag service is slow (3 s timeout), down (503), rate-limiting (429) or
  rejects the key (401), every feature is off and the shop works as it did before.
- Same security headers as the main app (CSP with `script-src 'self'`, no inline scripts,
  `nosniff`, no framing). Page text is set with `textContent`, never `innerHTML`.

## Run it on your PC

1. Create a staging key (from the repo root): `npm run seed:key`, and copy the key.
2. In `demo-client/`, copy `.env.example` to `.env` and paste the key into `FFM_API_KEY`.
   Set `FFM_API_URL` to `http://localhost:3000` (with `npm run dev:api`) or to the live URL
   `https://feature-flag-manager-cyan.vercel.app`.
3. `cd demo-client` then `npm start`, and open http://localhost:4000

## Deploy it (a second, separate Vercel project)

1. Vercel → Add New → Project → import this same repo.
2. Project name e.g. `ffm-demo-shop`; **Root Directory: `demo-client`**; Framework: Other.
3. Environment variables (Production): `FFM_API_URL`, `FFM_API_KEY` (the **staging** key).
   `FLAG_KEYS` is no longer used and can be deleted.
4. Deploy. The main app's project and secrets are not touched; this project holds only the staging key.

## Files

| File | What it does |
|---|---|
| `lib/store-flags.js` | The store's flags (key, label, area): also the allowlist of what may be asked |
| `lib/flag-client.js` | Calls `/evaluations/batch`, validates input, fails closed. Used by both runners |
| `api/flags.js` | Vercel function `GET /api/flags?user=…` |
| `server.js` | Local runner on port 4000 (static files + `/api/flags`) |
| `public/` | The shop page (`index.html`, `app.js`, `styles.css`) |
| `__tests__/` | Jest tests (run from the repo root with `npm test`) |
