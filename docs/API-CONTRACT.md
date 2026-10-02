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

---

# Round 2: owner controls, policies, department issues

Schema is already in `src/db.js`: `users.is_owner`, `returns.refund_method`, `audit_log`, `departments`,
`issue_requests`, `issue_request_items`, `issues`, `issue_items`, `issue_returns`, `issue_return_items`;
stock movement reasons now include `issue` and `issue_return`. `PROTECTED_SETTINGS` is exported from db.js.

## Owner and policies (coordinator)
- `GET /auth/me` user includes `is_owner` (0/1). Exactly one owner: the account created at setup
  (existing databases: the first admin).
- `GET /settings` includes the protected keys (readable by everyone signed in):
  `require_open_till` ('0'|'1'), `refund_card_sales` ('drawer'|'original'), `opening_balance_due`
  ('terms'|'immediate'), `max_discount_cashier_bps`, `max_discount_pharmacist_bps`, `max_discount_admin_bps`.
- `PUT /settings` rejects protected keys with 403. Owner changes them with
  `PUT /owner/settings { current_password, ...keys }` (owner only; wrong password 403) -> settings.
- `GET /owner/audit?limit=` (owner) -> `[{ id, created_at, user_name, action, detail }]` (detail parsed).
- `POST /owner/transfer { user_id, current_password }` (owner) -> target must be an active admin; they
  become owner, caller stops being owner.
- Users: only the owner may create an admin, edit an admin, or change a role to/from admin. Nobody
  can deactivate or demote the owner. User list rows include `is_owner`.
- Discount caps come from the `max_discount_<role>_bps` settings (POS UI should read them too).
- Returns: with `refund_card_sales = 'original'`, returns of card/wallet sales are refunded to that
  method (`refund_method` = 'card'|'wallet', no till needed, not counted in till cash); otherwise
  `refund_method = 'cash'` from the drawer. Sale detail `returns[]` include `refund_method`.
  Till totals count only cash refunds.
- Supplier dues: `opening_balance_due = 'terms'` makes the opening balance due opening_date + due_days.

## Department issues (Agent D)
- `GET /departments?all=1` (any signed-in), `POST /departments { name, incharge?, active? }`,
  `PUT /departments/:id` (admin/pharmacist).
- `GET /issue-requests?status=&department_id=`, `GET /issue-requests/:id` (items with product name,
  pack_size, qty_requested, qty_issued, stock), `POST /issue-requests { department_id, requested_by?,
  ref_no?, note?, items: [{ product_id, qty? | packs?, loose? }] }`, `POST /issue-requests/:id/cancel`.
- `POST /issues { department_id, request_id?, received_by?, patient_name?, note?, items: [{ product_id,
  qty? | packs?, loose?, request_item_id? }] }` -> FEFO from unexpired stock, 409 if short; each slice
  an `issue_items` row valued at the batch `cost_price`; stock movement reason `issue` (ref_id = issue id,
  note = department name); `issue_no` = `ISS-000001`; updates request `qty_issued` and status
  (`partial`/`closed`). Controlled drugs need `received_by`.
- `GET /issues?from=&to=&department_id=` (rows with department_name, item_count, total_cost, returned_cost),
  `GET /issues/:id` (items with product/batch/expiry, returns).
- `POST /issues/:id/returns { items: [{ issue_item_id, qty, restock? }], reason }` -> restocks unexpired
  batches (movement `issue_return`), expired ones not restocked.
- `GET /reports/department-usage?from=&to=&department_id=` -> without department: per department
  `{ department_id, name, issues, issued_cost, returned_cost, net_cost }`; with: per product
  `{ product_id, name, qty_issued, qty_returned, net_cost }`.
- Controlled-drug register includes `issue`/`issue_return` movements with `department_name`.
- Roles: all issue/request/department-write routes admin + pharmacist.

---

# Round 3: role-based dashboard and in-app assistant

Groundwork in place: `assistant_conversations` table (src/db.js), settings `assistant_enabled`
(owner policy, '1' default) and private `assistant_api_key`; Worker secret `GROQ_API_KEY` (env var
locally). Routes mounted at `/api/dashboard` (src/routes/dashboard.routes.js) and `/api/assistant`
(src/routes/assistant.routes.js). Browser: `public/assistant.js` exports `mountAssistant(ctx)` (called
after sign-in) and `assistantOwnerSection(el, ctx)` (inside the Owner panel); ctx = { state, api, get,
post, toast, esc, rs, modal, guard }. JSON body limit is 3 MB.

## Dashboard (Agent DB)
`GET /dashboard` -> `{ role, is_owner, date, cards: {...}, lists: {...}, charts: {...} }`, content by role:
- everyone: `my_till` (session + totals or null), `my_sales_today` { invoices, total }, `recent_sales` (own, last 10)
- pharmacist/admin: `sales_today` { invoices, total, prescriptions, controlled }, `alerts` { low_stock,
  near_expiry, expired, unpriced_items (pack_price 0 with stock or without) }, `open_requisitions`,
  lists `expiring_soon` (10), `low_stock` (10)
- admin/owner: `sales_today` vs `sales_yesterday`, `gross_profit_today`, `cash_in_open_tills`,
  `supplier_dues` { balance, overdue }, `stock_value` { cost, retail }, chart `sales_7d`
  [{ day, total, invoices }], `top_products_today` (5), `issues_today` { count, cost }
- owner: `recent_audit` (5)

## Assistant (Agent AS) — mirror ColdStore ERP's assistant (agent loop, approvals, voice)
- `GET /assistant/status` -> { enabled, provider, model, source ('environment'|'settings'|null), voice }
  plus for the owner `saved` { keyHint, updatedAt } | null.
- `PUT /assistant/key` (owner, { apiKey, current_password }) verifies with Groq, stores in
  `assistant_api_key`, audit logs; `DELETE /assistant/key` (owner, { current_password }).
- `GET /assistant/conversations` (own, last 30), `POST /assistant/conversations { text, lang }`,
  `GET /assistant/conversations/:id`, `POST /assistant/conversations/:id/messages { text, lang }`,
  `POST /assistant/conversations/:id/step` (continue a running turn), `POST /assistant/conversations/:id/approve
  { decisions: { [callId]: true|false } }`, `DELETE /assistant/conversations/:id`.
  Conversation view: { id, title, status, provider, transcript: [{type: user|assistant|tool|approval|error, ...}],
  pending: [{ id, name, details: [[label, value]], error }], retryAfterMs, updated_at }.
- `POST /assistant/voice { audio (base64), mime, lang }` -> { text } (Groq Whisper, Urdu/English).
- 503 when disabled (`assistant_enabled = '0'`) or no key.
