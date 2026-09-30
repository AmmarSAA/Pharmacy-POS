# API contract for the MultiTec-parity round

Money is integer paisa, rates are basis points, dates YYYY-MM-DD. All routes are under `/api` and
need sign-in. Errors: `{ "message": "..." }` with 400 (bad input), 403 (role), 404, 409 (state conflict).
Shared helpers: `src/lib/till.js` (open till, till totals, cash movements), `src/lib/money.js`
(`packAmount`, `priceForMargin`, `percentOf`). New tables/columns: see `ADDED_COLUMNS` and schema in `src/db.js`.

## Products (done)
Fields add: `pack_size` (units per pack), `pack_price` (price of one full pack; `sale_price` = per unit,
derived), `packing` (Strip/Box/...), `allow_loose` (0/1), `shelf_location`.
List/get also return `current_pack_price` (pack price of the batch that sells next).
`POST /products/import { rows: [{ barcode, name, manufacturer, pack_size, category, generic_name, pack_price, schedule, form, strength, gst_rate_bps }] }`
-> `{ created, updated, errors: [{ row, message }] }`. Matches by barcode, else exact name.

## Sales and tills (Agent B)
- `POST /sales` items: `[{ product_id, packs?, loose?, qty?, discount_bps? }]`. Units = `qty` if given, else
  `packs * pack_size + loose`. Loose units on an item with `allow_loose = 0` -> 400.
  Each FEFO batch slice is priced `packAmount(units, batch.pack_price, batch.pack_size)`.
  `sale_items.pack_size` stores the product's pack size. Response items include `pack_size`.
- When setting `require_open_till = '1'` and the user has no open till: `POST /sales` and
  `POST /sales/:id/returns` -> 409 "Open your till before ...". Sales and returns store `till_session_id`.
- `POST /tills/open { notes?: { "5000": 2, ... }, opening_cash? }` -> session (409 if user already has one open).
- `GET /tills/current` -> `{ session, totals }` or `{ session: null }` for the signed-in user.
- `POST /tills/current/movements { direction: "in"|"out", amount, reason, notes? }` -> movement.
- `POST /tills/current/close { notes?: {...}, counted_cash?, note? }` -> session with `expected_cash`,
  `counted_cash`, `variance` (= counted - expected).
- `GET /tills?date=` -> sessions of that business date with `user_name` and `totals`
  (cashier: own only). `GET /tills/:id` -> session, movements, totals.
- `POST /tills/day-close { date }` (admin/pharmacist) -> 409 if any till for that date is still open or
  the date is already closed; stores a summary. `GET /tills/day-close?date=` -> record or null.

## Suppliers and purchases (Agent A)
- Supplier fields add: `due_days`, `opening_balance`, `opening_date`, `contact_person`, `email`, `active`.
  `GET /suppliers` rows also have `balance` (owed now) and `overdue`.
- `GET /suppliers/:id/ledger?from=&to=` -> `{ supplier, entries: [{ date, type: "opening"|"purchase"|"payment",
  ref, description, debit, credit, balance }], balance }` (debit = billed, credit = paid, balance = owed).
- `POST /suppliers/:id/payments { amount, method: "cash"|"bank"|"cheque"|"till", reference?, paid_on?, note?, purchase_id? }`
  -> payment. `till` takes the cash out of the user's open till (cash movement "out"; 409 if no open till).
- `GET /suppliers/payments?from=&to=` -> payments with supplier name.
- `GET /reports/supplier-dues` -> per supplier `{ supplier_id, name, due_days, balance, not_due, d1_30, d31_60,
  d61_90, d90_plus, overdue, oldest_unpaid_date }`; payments settle oldest bills first; buckets are days past due.
- `POST /purchases { supplier_id, invoice_no?, invoice_date?, payment_type: "credit"|"cash", payment_method?:
  "cash"|"till"|"bank", notes?, items: [{ product_id, batch_no, expiry_date, packs, loose_qty?, bonus_qty?,
  pack_cost, discount_bps?, pack_price? }] }`. Legacy unit lines `{ qty, cost_price, sale_price? }` still work.
  Line: units = packs * pack_size + loose; gross = packAmount(units, pack_cost, pack_size); discount =
  percentOf(gross, bps); net = gross - discount. Batch gets `pack_size`, `pack_price` (given, else product's,
  else `priceForMargin(net cost per pack, default_margin_bps)`), `cost_price` = round(net / (units + bonus)).
  Product `pack_price`/`sale_price` update to the new pack price. Purchase stores `gross`, `discount`,
  `total` (= net), `payment_type`, `due_date` (credit: invoice date + supplier due_days).
  Cash purchase records a supplier payment for the total (method from `payment_method`, default cash;
  `till` also takes it from the open till).
- `GET /purchases/:id` items include `packs`, `loose_qty`, `bonus_qty`, `pack_cost`, `discount_bps`, `pack_price`, `pack_size`.
