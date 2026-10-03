# Pharmacy POS

Point-of-sale and inventory software for a retail pharmacy, set up for Pakistan (PKR, GST, PMDC, CNIC).
One small Node.js server with a MongoDB database (MongoDB Atlas online, or a local MongoDB). It runs on
Cloudflare Workers at pharmacy.z88.tech or on any PC, and tills open it in a browser.

## Features

**Sales & billing**
- Barcode scanner support (scan → Enter adds the item), or search by brand, generic name or barcode
- Cart with quantity and per-line discount; discount limits by role (cashier 10%, pharmacist 25%)
- Cash (with change calculation), card, and JazzCash/Easypaisa payments
- Bills rounded to the whole rupee (can be switched off)
- 80 mm thermal receipt with batch and expiry per line, pharmacy licence/NTN/STRN
- Returns against the original invoice, refunded at the price actually charged; restocks unexpired batches

**Inventory by batch and expiry**
- Every unit of stock belongs to a batch with its own expiry date, cost price and MRP
- Sales take stock first-expiry-first-out (FEFO) automatically, splitting across batches if needed
- Expired batches can't be sold; near-expiry and expired lists, write-offs for expired or damaged stock
- Every stock change is logged with who did it and the resulting balance

**Prescriptions & controlled drugs**
- Products are marked OTC, prescription-only (Rx) or controlled
- Rx items require patient and prescriber details at the till, saved against the invoice
- Controlled drugs also require the patient's CNIC and the prescriber's PMDC number, and only a pharmacist or admin can sell them
- Controlled-drug register report: every receipt, sale and adjustment with running balance, patient, prescriber and supplier, printable

**Packs, tills and supplier credit** (MultiTec parity, see `docs/PLAN.md`)
- Items have units per pack and a pack price; the POS sells packs and loose units, priced exactly per pack
- Tills: open with a note count, cash in/out, close with expected vs counted cash, then day close;
  sales and refunds go through the cashier's open till (can be switched off in Settings)
- Purchases entered in packs with loose units, bonus and trade discount; margin and mark-up per line;
  missing sale prices default to cost + 15% margin; credit purchases get a due date from the supplier's terms
- Supplier credit: opening balances, payments (cash, bank, cheque or from the till), ledger with
  running balance, and a dues report with aging buckets and overdue bills
- Import the item list by pasting from Excel or a CSV; MultiTec column names are recognised

**Dashboard and assistant** (Round 3)
- Each user lands on a dashboard for their job: the owner/admin sees sales vs yesterday, gross profit,
  cash in open tills, supplier dues, stock value, ward issues and a 7-day chart; pharmacists see sales,
  prescriptions, requisitions and stock alerts; cashiers see their own sales, their drawer and till actions
- In-app assistant (button at the bottom right): ask in English or Urdu, by typing or voice note, about
  stock, expiry, prices, sales, suppliers, dues and departments. It can also change prices or schedules,
  record supplier payments, add departments and raise requisitions, but only after the user taps Approve.
  It sees and does only what the signed-in user's role allows; every action is in the audit log
- The owner switches it on or off and manages the Groq API key in the Owner panel

**Purchasing, users & reports**
- Suppliers (with NTN and drug licence number) and stock receiving against supplier invoices, including bonus units
- Roles: **cashier** (sell, own sales only), **pharmacist** (plus controlled drugs, returns, stock, purchases, reports), **admin** (plus users and settings)
- Reports: sales summary (net sales, discounts, returns, GST by rate, gross profit, cash in drawer, by staff, by day), top products, low stock/reorder list, expiry, stock valuation at cost and retail

## Apps (installable, desktop, Android, offline)

All of them open the same live pharmacy (https://pharmacy.z88.tech), so the data is shared.

- **Install from the browser (any device)**: Chrome/Edge show *Install app*; on iPhone use Safari → Share →
  *Add to Home Screen*. The app has its own icon and window (`public/manifest.webmanifest`, `public/sw.js`).
- **Windows / Linux desktop** (`desktop/`, Electron): File → *Receipt printer…* picks the thermal printer, and
  receipts then print straight to it with no dialog. Installers come from GitHub Actions (`.github/workflows/apps.yml`);
  a `v*` tag publishes them as a GitHub Release.
- **Android** (`mobile/`, Capacitor): the APK from the same workflow. Camera barcode scanning in the POS (also in
  Chrome on Android). Set the `ANDROID_KEYSTORE_*` repository secrets so every APK is signed with the same key and
  installs over the previous one.
- **Offline selling** (`public/offline.js`): after one sign-in while online, the counter keeps working without
  internet. It searches a downloaded copy of the catalogue, saves sales on the device and syncs them when the
  connection is back. The server dates each synced sale when it happened, puts it in the till that was open then, and
  never records it twice. Controlled drugs need the connection; sales the server refuses (for example the stock ran
  out) are listed under *to review* in the side bar. Sync offline sales before closing the till.

## Running it

Requires Node.js 22.5 or newer and a MongoDB database that supports transactions (MongoDB Atlas,
including the free M0 tier, or a local replica set).

```bash
npm install
MONGODB_URI="mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/pharmacy" npm start   # http://localhost:3000
```

Open the address in a browser. On first run it asks you to create the owner (admin) account.
Other computers on the same network can use `http://<counter-pc-ip>:3000`.

To try it with demo medicines and stock, create the admin account first, then run:

```bash
npm run seed
```

### Configuration (environment variables, all optional)

| Variable        | Default              | Purpose                                                   |
|-----------------|----------------------|-----------------------------------------------------------|
| `PORT`          | `3000`               | HTTP port                                                 |
| `HOST`          | `0.0.0.0`            | Interface to listen on (`127.0.0.1` for this PC only)     |
| `MONGODB_URI`   | (required)           | MongoDB connection string                                 |
| `MONGODB_DB`    | from the URI         | Database name (the Worker defaults to `pharmacy`)          |
| `JWT_SECRET`    | generated and stored in the database | Signing key for sign-in sessions          |
| `COOKIE_SECURE` | off                  | Set to `1` when serving over HTTPS                        |
| `SETUP_TOKEN`   | none                 | If set, creating the first admin account requires this token. **Always set it on a public server.** |
| `TRUST_PROXY`   | off                  | Number of reverse-proxy hops in front of the app, so login rate limiting sees real client IPs |
| `GROQ_API_KEY`  | none                 | Key for the assistant (Groq). Without it the owner can save one in the Owner panel (stored encrypted) |

Pharmacy name, address, licence numbers, default GST rate, expiry warning window, rounding and receipt
footer are set in the app under **Settings**.

### Backups

All data is in MongoDB. Atlas paid tiers take automatic backups; on the free M0 tier, export regularly:

```bash
mongodump --uri "$MONGODB_URI" --out "backup-$(date +%F)"
```

Each collection keeps the fields the original SQL tables had (integer `id`, money in paisa,
local-time `created_at` strings), so exports are easy to read and re-import.

## Deploying online (pharmacy.z88.tech)

The app needs one always-on server with a persistent disk, because the database is a file. Serverless
hosts (Netlify Functions, Vercel, Cloudflare Workers) can't keep it. Run exactly **one** instance.

### Option A: Cloudflare Workers (how pharmacy.z88.tech runs)

`worker/index.js` runs the same Express app inside a single Durable Object, which holds the MongoDB
connection for all requests. Cloudflare Workers Builds deploys every push to `main` with
`npx wrangler deploy`, using `wrangler.jsonc`.

- `MONGODB_URI` is a Worker secret (Atlas connection string; Atlas network access must allow 0.0.0.0/0,
  since Workers have no fixed IP): `npx wrangler secret put MONGODB_URI`
- The Durable Object's own SQLite storage held the data before the move to MongoDB (October 2026); it is
  left in place, unused
- `SETUP_TOKEN` is a Worker secret: `npx wrangler secret put SETUP_TOKEN`
- `GROQ_API_KEY` is a Worker secret for the assistant: `npx wrangler secret put GROQ_API_KEY`
- `UTC_OFFSET_MINUTES` (default 300 = Pakistan) sets the pharmacy's local time, since Workers run on UTC
- Local run in the Workers runtime: `npx wrangler dev --var MONGODB_URI:<uri> --var MONGODB_DB:<empty db>`, then
  `TEST_BASE_URL=http://localhost:8787 node --test test/workflow.test.js` runs the checks against it

### Option B: Render (click-through)

1. In Render: **New → Blueprint**, pick this repository. `render.yaml` creates a Docker web service with
   a 1 GB disk at `/data`, a health check, a random `SETUP_TOKEN`, and the custom domain `pharmacy.z88.tech`.
   A persistent disk needs a paid instance (Starter).
2. In Cloudflare DNS for `z88.tech`, add `CNAME pharmacy → <service>.onrender.com`, set to
   **DNS only** (grey cloud) so Render can issue the TLS certificate.
3. When Render shows the domain as verified, open https://pharmacy.z88.tech, paste the `SETUP_TOKEN`
   value from the service's Environment tab, and create the owner account.

### Option C: any VPS with Docker

```bash
docker build -t pharmacy-pos .
docker run -d --name pharmacy-pos --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -v pharmacy-data:/data \
  -e SETUP_TOKEN="$(openssl rand -hex 16)" -e TRUST_PROXY=1 \
  pharmacy-pos
docker inspect pharmacy-pos --format '{{range .Config.Env}}{{println .}}{{end}}' | grep SETUP_TOKEN
```

Put a TLS reverse proxy in front (Caddy: `pharmacy.z88.tech { reverse_proxy 127.0.0.1:3000 }`) and point an
`A` record for `pharmacy` at the server. The image sets `COOKIE_SECURE=1`, so it must be served over HTTPS.

Back up the `/data` volume daily. Patient names, CNICs and prescriptions are stored there.

## How money and tax work

- Amounts are stored as whole paisa (Rs 1 = 100) so totals never drift from rounding.
- Retail prices are MRP and **include** GST. The GST contained in each line is calculated from the
  product's GST rate and shown on the receipt and in the GST report. Most medicines are 0%; set a rate
  on products that carry sales tax (cosmetics, surgical items, etc.).
- Quantities are in the smallest unit you sell (tablets, bottles, sachets). "Units per pack" on the
  product is for reference.

## Development

```bash
npm run dev    # restart on file changes
npm test       # API tests; each file starts a throwaway MongoDB (mongodb-memory-server)
TEST_BASE_URL=http://localhost:8787 node --test test/workflow.test.js   # same checks against a running server
```

- `src/` — Express API (`routes/`), MongoDB access and transactions (`store.js`), indexes and settings
  (`db.js`), stock/FEFO logic (`lib/stock.js`)
- `public/` — browser app (plain JavaScript, no build step)
- `test/` — API tests with `node:test`

## Not included yet

Things a pharmacy may want next: DRAP/FBR POS integration for real-time invoice reporting, selling by
strip vs. tablet with automatic conversion, customer accounts/credit and loyalty, supplier payments
and ledgers, purchase orders, stock transfer between branches, and automatic scheduled backups.
