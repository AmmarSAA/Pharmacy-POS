# Pharmacy POS

Point-of-sale and inventory software for a retail pharmacy, set up for Pakistan (PKR, GST, PMDC, CNIC).
One small Node.js server with a built-in SQLite database. It runs on the counter PC, and other tills
on the shop network open it in a browser. No internet connection or cloud database is needed.

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

**Purchasing, users & reports**
- Suppliers (with NTN and drug licence number) and stock receiving against supplier invoices, including bonus units
- Roles: **cashier** (sell, own sales only), **pharmacist** (plus controlled drugs, returns, stock, purchases, reports), **admin** (plus users and settings)
- Reports: sales summary (net sales, discounts, returns, GST by rate, gross profit, cash in drawer, by staff, by day), top products, low stock/reorder list, expiry, stock valuation at cost and retail

## Running it

Requires Node.js 22.5 or newer (it uses Node's built-in `node:sqlite`, so nothing needs compiling).

```bash
npm install
npm start            # http://localhost:3000
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
| `DB_PATH`       | `data/pharmacy.db`   | SQLite database file                                      |
| `JWT_SECRET`    | generated and stored in the database | Signing key for sign-in sessions          |
| `COOKIE_SECURE` | off                  | Set to `1` when serving over HTTPS                        |

Pharmacy name, address, licence numbers, default GST rate, expiry warning window, rounding and receipt
footer are set in the app under **Settings**.

### Backups

All data is in `data/pharmacy.db` (plus `-wal`/`-shm` files while running). Back it up daily, e.g. copy it
to a USB drive or cloud folder. For a consistent copy while the app is running:

```bash
sqlite3 data/pharmacy.db ".backup 'backup-$(date +%F).db'"
```

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
npm test       # API tests against an in-memory database
```

- `src/` — Express API (`routes/`), database schema (`db.js`), stock/FEFO logic (`lib/stock.js`)
- `public/` — browser app (plain JavaScript, no build step)
- `test/` — API tests with `node:test`

## Not included yet

Things a pharmacy may want next: DRAP/FBR POS integration for real-time invoice reporting, selling by
strip vs. tablet with automatic conversion, customer accounts/credit and loyalty, supplier payments
and ledgers, purchase orders, stock transfer between branches, and automatic scheduled backups.
