# Plan: MultiTec parity for the Federal Hospital pharmacy

Goal: the Pharmacy POS can replace MULTI SOFT (Johar Software House) at the Federal Hospital
pharmacy for day-to-day work, and retire the hand-kept supplier ledger (`Book4.xlsx`).

Source material: MultiTec screenshots, preferences, `Script.mdb` (schema upgrade script),
`Multitec.mdb` (import template), `waqasBook1.xlsx` (item master), `Book4.xlsx` (supplier credit).

## Objectives

| # | Objective | Done when |
|---|-----------|-----------|
| O1 | Supplier credit replaces `Book4.xlsx` | Credit/cash purchases, supplier payments, opening balances, per-supplier ledger with running balance, dues/aging report with overdue bills by due days |
| O2 | Sell and buy by pack, like MultiTec | Items have units per pack + pack price; POS sells packs and loose units; totals exact per pack (no per-tablet rounding drift) |
| O3 | Counter cash control | Till open with note count, cash in/out, till close with expected vs counted, day close only when all tills are closed |
| O4 | MultiTec-style purchase entry | Grid in packs with bonus, trade discount, purchase price, sale price, live margin/markup, default 15% margin, due date from supplier terms |
| O5 | Bring their item master across | Paste from Excel / CSV import that understands MultiTec column names; upsert by item code |
| O6 | Nothing already working breaks | All existing tests pass on Node and on the Cloudflare runtime; live site migrates its database in place |

## Phase 1: needed from the user

Work proceeds on the defaults below; each is a setting or small change if the answer differs.

| Question | Default used |
|----------|--------------|
| Do wards/departments draw stock from the pharmacy (MultiTec "Issue")? | Not built yet; planned as a follow-up |
| Real database (`MultiTec_Data.MDF`, zipped < 10 MB) for stock, supplier and history migration | Item import from Excel now; full migration when the file arrives |
| Must every sale go through an open till? | Yes (`require_open_till` = on) |
| Default sale unit | Pack; loose units allowed per item |
| Standard margin | 15% (sale = cost / 0.85), as in MultiTec |
| Supplier opening balances (what is owed today) | Entered per supplier in the app; `Book4.xlsx` totals shown in Phase 4 |
| Cloudflare plan (free plan CPU limit may affect sign-in) | Check on first sign-in |

## Phase 2: build

1. Schema migrations that add columns to an existing database safely (live site has data)
2. Pack pricing: `pack_price` on items and batches; exact line totals for packs and loose units
3. Suppliers: due days, opening balance, contact person, email; payments table; ledger; dues/aging
4. Purchases: pack-based lines with bonus and discount, cash/credit, due date, margin/markup; cash purchases auto-record their payment
5. Tills: sessions with note counts, cash movements, expected cash, close, day close; sales and refunds tied to the till
6. Item import endpoint + paste/CSV screen with MultiTec header mapping
7. UI: POS (packs/loose, till gate), Till screen, supplier ledger and payments, dues report, new purchase grid, product form, import, settings
8. Docs: README and this plan

## Phase 3: test (by Claude)

1. Automated API tests for every objective, on Node and on the Cloudflare runtime (`wrangler dev`)
2. Migration test: old-schema database upgrades cleanly
3. Browser walkthrough of each new screen, no console errors, phone width
4. Deploy via Workers Builds; smoke-test the live site

## Phase 4: test (by the user)

See the checklist below.

## Later (not in this round)

Purchase returns to supplier, purchase orders, double-entry
accounting (trial balance, income statement), barcode label printing, multiple godowns,
full data migration from the MultiTec database.

## Status

- Phase 2 done: built in three parallel workstreams (suppliers/purchases, sales/tills, UI) against
  `docs/API-CONTRACT.md`, integrated and reviewed.
- Phase 3 done:
  - 52 automated tests on Node (unit, API, migration, workflow); API and workflow suites also pass
    on the Cloudflare runtime (`wrangler dev`).
  - Old-schema database upgraded in place on both runtimes.
  - Browser walkthrough of every new screen at desktop and phone width; no console errors;
    item names with HTML are shown as text.
  - Scale: 6,000 imported items; purchase grid opens in about 0.3 s, search in about 10 ms.

## Phase 4 checklist (for the pharmacy)

Sign in at https://pharmacy.z88.tech as the owner, then:

1. **Settings**: check pharmacy details, default margin (15%), "every sale needs an open till",
   default sale unit (pack) and the note denominations.
2. **Import items**: Products → Import items → paste the item sheet from Excel (e.g. `waqasBook1.xlsx`)
   → check the preview → Import. Spot-check a few items' units per pack.
3. **Suppliers**: add the suppliers from `Book4.xlsx` with their credit days and what is owed today
   as the opening balance. The dues report total should match the sheet's outstanding (about Rs 826,165).
4. **Purchase**: enter one real supplier bill in packs (with a bonus and a discount if it has one).
   Check net cost, sale price, margin and the due date against the paper bill.
5. **Till**: open the till with a note count → sell a full pack and some loose tablets → do a return
   → a cash out → close with a real count. Expected cash should match the drawer.
6. **Day close** after all tills are closed; print the summary.
7. **Supplier payment**: record a payment (bank or cheque, and one from the till); check the ledger
   and dues report.
8. **Staff**: add a cashier account and confirm they can sell but can't see purchases or suppliers.

## Round 2 (owner controls, policies, department issues)

Answers from the pharmacy: protected settings wanted; card refunds and opening-balance due date
should be configurable; department issues needed; MultiTec data to follow.

- Owner: the account that set up the pharmacy is the owner. Only the owner changes policy settings
  (password confirmed), adds or changes admins, sees the audit log, and can transfer ownership.
- Policies (Owner panel): open till required; card/wallet refunds from the drawer or back to the
  card/wallet; supplier opening balance due after credit days (default) or immediately; maximum
  discount per role.
- Department issues: departments, requisitions, issues at cost (first expiry first out) with a
  printable slip, returns from departments, department usage report; controlled register shows
  the department.
- Tests: 66 on Node; workflow (9 steps) and API suites on the Cloudflare runtime; old database
  upgraded in place (stock movement table rebuilt, history kept, first admin made owner);
  browser check as owner, second admin and cashier.

### Round 2 checklist

1. Owner panel: review the policies; set the cashier/pharmacist discount limits you want.
2. Add a second admin and sign in as them: policies are read-only, other admins can't be changed.
3. Departments: add your wards (OT, Emergency, ...).
4. Requisition → Issue now → print the slip; issue a controlled drug (needs "Received by").
5. Return part of an issue; check Reports → Department usage.

### MultiTec data

- Received a 14.8 MB `MultiTec_Data.MDF`: item master only (10,770 items, 417 manufacturers), no
  stock, suppliers or history. Exported to an import CSV and import-tested (twice, idempotent) on the
  Cloudflare runtime. Steps in `docs/MIGRATION.md`.

## Round 3 (dashboards and assistant)

- Dashboard (`GET /api/dashboard`) is the first screen and is scoped by role. Owner/admin: sales vs
  yesterday, gross profit, cash in open tills, supplier dues, stock value, ward issues, 7-day chart,
  getting-started steps. Pharmacist: sales, prescriptions and controlled sales, own sales, open
  requisitions, stock alerts. Cashier: own sales, cash in their drawer, till actions. Refreshes every minute.
- Assistant (`/api/assistant`), same design as the ColdStore ERP assistant: Groq
  (`openai/gpt-oss-120b`), English and Urdu, voice notes (Whisper). Tools call the app's own API as the
  signed-in user, so roles and validation are the same as on screen. Reads run on their own; changes
  (prices, schedules, supplier payments, departments, requisitions) wait for Approve and run once.
  Chats are per user. The owner switches it on/off and manages the key in the Owner panel; the
  `GROQ_API_KEY` Worker secret takes precedence over a saved key.
- Tests: 83 on Node (including scripted assistant runs); workflow and API suites on the Cloudflare
  runtime; browser check as owner, pharmacist and cashier (desktop and phone width) with live Groq on
  both runtimes: stock question, approval card, Urdu answer, no console errors.

## Round 4 (MongoDB)

The Cloudflare free plan's daily read limit on Durable Object storage stopped the live site (3 October
2026). The data layer moved to MongoDB Atlas; the Worker, domain and the browser app are unchanged.

- Same records and fields as the SQL tables (integer ids, paisa, local-time strings), so API responses
  and the browser app did not change. Multi-step writes (sales, purchases, returns, issues, tills, day
  close, supplier payments) run in MongoDB transactions; unique indexes keep usernames, barcodes,
  invoice numbers, batch numbers and one open till per user unique.
- Reports are aggregation pipelines; sale, return and issue lines carry their date so reports filter
  them directly.
- Started fresh on MongoDB (owner chose not to copy the Cloudflare data, which stays in the Durable
  Object, unused).
- Tests: 86 on Node against a throwaway MongoDB replica set; workflow and API suites and the browser
  check (all roles, assistant with Groq) on the Cloudflare runtime against MongoDB.

## Round 5 (apps and offline selling)

- Installable web app (PWA): manifest, icons, service worker (network first, cached app shell).
- Offline selling: the POS keeps a copy of the catalogue on the device, sells without internet and syncs
  afterwards. The server (`POST /api/sales` with `offline_id` and `offline_at`) records each sale once, dated when
  it happened, in the till open at that time. Controlled drugs need the connection; refused sales are listed
  for review in the side bar.
- Camera barcode scanning in the POS where the browser can read barcodes (Android).
- `desktop/`: Electron app for Windows and Linux with direct receipt printing (File → Receipt printer…).
- `mobile/`: Capacitor Android app with camera and microphone permissions.
- `.github/workflows/apps.yml` builds the installers and the APK; a manual run with a version publishes a release.
- Tests: 90 on Node, including offline sync (idempotent, dated, till at the time, refusals); a browser test cut
  the network, reloaded, sold offline and checked the sale synced once with the right stock.

## Round 6 (demand lists)

- `src/routes/demand.routes.js`: `GET /api/demand/suggestions` (use over N days, cover days, per supplier),
  `GET/POST/PUT /api/demand/lists`, `POST /api/demand/lists/:id/status` (draft → sent → received, or cancelled),
  `POST /api/demand/skip` (never / snooze / restore) and `GET /api/demand/not-needed`. Admin and pharmacist only.
- A product is suggested when stock that has not expired plus quantity on open lists is at or below
  max(reorder level, 7 days of use). Order = enough for the cover days, at least twice the reorder level.
  Items with no use in 90 days are "idle": shown, not suggested.
- `no_reorder` and `reorder_snooze_until` on products also hide them from the low-stock report and dashboard.
- Demand list page: suggestions grouped by supplier, editable packs, one list per supplier, print slip,
  WhatsApp (0300… → 92300…), copy as text, CSV.
- Assistant tools: `demand_suggestions` (read), `create_demand_list` and `mark_not_needed` (need approval).
- Fixed: leaving the dashboard before its first load finished showed an error on the next page.
- Tests: 97 on Node; browser check of suggestions → list → WhatsApp text, not-needed and a manual list.

## Round 7 (roles & permissions)

- Foundational change ahead of Rounds 8-11 (Odoo-style breadth): the fixed 3-role system (cashier/
  pharmacist/admin) now sits on top of a configurable permission system, so an admin can create a
  custom role (e.g. "HR Manager") with exactly the access it needs, instead of being stuck with one
  of 3 fixed levels.
- `src/lib/permissions.js`: the permission-key catalogue (18 keys, grouped), the 3 system roles
  seeded with the exact permission sets that reproduce today's access unchanged, and `requirePermission`.
- New `roles` collection (`key, name, base_role, is_system, permissions[]`). Every user now also has
  `role_id`; the legacy `role` string stays in sync (= the role's `base_role`) because a handful of
  business rules key off it directly rather than a permission: discount caps by role, cashiers barred
  from controlled drugs, cashiers seeing only their own sales/tills. Those are unchanged.
  `src/db.js` `initDb` seeds the 3 system roles once and migrates any user created before this round.
- `src/routes/roles.routes.js`: `GET /api/roles/permissions` (the catalogue, for building a checkbox
  UI), `GET/POST/PUT/DELETE /api/roles` (admin/`users.manage` only; built-in roles can be edited but
  not deleted; a role still assigned to a user can't be deleted).
- Every existing `requireRole('admin', 'pharmacist' | 'admin')` gate across the API (products,
  suppliers, purchases, demand, issues, inventory, reports, sales returns, tills day-close, settings,
  users) now reads `requirePermission(...)` instead, each mapped to the permission that reproduces
  its old behaviour exactly.
- `POST/PATCH /api/users` accepts `role_id` (any role) or, as a shorthand, the old `role` string
  (resolved to the matching built-in role).
- Tests: `test/roles.test.js` — role CRUD, a custom role's permissions actually gating API access,
  built-in roles protected from deletion, and every existing role-gated test still passing unchanged.

## Round 8 (operations gaps: purchase orders, customer accounts & loyalty, branch transfers)

Three features the project's own "Later"/"Not included yet" lists had already named as deliberately
deferred (not forgotten) — picked up first because they extend existing Purchase/Sales/Inventory
code directly, rather than adding a new domain.

- **Purchase orders**: new `purchase_orders`/`purchase_order_items` (`src/routes/purchase-orders.routes.js`,
  `purchase_orders.manage`). Status `draft → sent → received|cancelled`, same transition-table shape
  as demand lists. `POST /api/purchases` gained an optional `purchase_order_id`: receiving against a
  *sent* order marks it `received` and links the resulting purchase, so "order" and "goods receipt"
  stay two different documents, as intended. Front end: a Purchase Orders screen, and `purchaseForm`
  (the existing "New purchase" dialog) now accepts an order to pre-fill from, reached via its
  "Receive stock" action (`#/purchases?po=ID`).
- **Customer accounts, credit & loyalty**: new `customers`/`customer_payments` and
  `src/lib/customer-ledger.js` — a direct mirror of `supplier-ledger.js` (bills vs. payments, FIFO/
  tied settlement, aging, running-balance statement), with "purchases" replaced by sales billed to
  the account (payment_method `'account'`, net of any `'account'`-refunded returns) and payment
  direction reversed (till cash moves `in`, not `out`). `sales.routes.js`: `'account'` is a 4th
  payment method (`amount_paid: 0`, requires `customer_id`, refused offline like controlled drugs);
  returns against an account sale always refund `'account'` (credit the balance), never cash, since
  no cash changed hands at sale time. Loyalty: `loyalty_points_per_100rs` / `loyalty_point_value_paisa`
  settings; points earn on the final total of any sale linked to a customer, and `redeem_points`
  applies as an order-level discount (capped at the live balance, checked again inside the
  transaction). Front end: a Customers screen (list/ledger/payment, mirroring Suppliers), and the POS
  screen gained an optional "link a customer account" search with a redeem-points field and `Account`
  as a 4th payment button.
- **Branch-to-branch stock transfer**: scoped deliberately smaller than a second live-inventory
  location (`PLAN.md`'s original "Later" list named "multiple godowns" as a bigger, separate change).
  New `locations`/`stock_transfers`/`stock_transfer_items` (`src/routes/transfers.routes.js`,
  `transfers.manage`). Sending stock decrements this location's batches immediately via FEFO — the
  same one-way, at-cost, tracked pattern `issues.routes.js` already uses for department issues, just
  to a named location instead of a department. `POST /:id/receive` only acknowledges the other site
  got it (no second location gets its own sellable stock yet); `POST /:id/cancel` reverses the stock
  movement for a mistake, before it's been received.
- Tests: `test/operations.test.js` — account sale → ledger → payment → redeemed/earned loyalty points,
  an account-sale return crediting the account not the drawer, a full purchase-order lifecycle
  including stock actually landing on receipt, and send/receive/cancel for a transfer with the stock
  figure checked at each step.
- Known gap, not attempted this round: a true second sellable-stock location (POS search, FEFO,
  demand suggestions, reports) for transfers — flagged above, not silently dropped.

## Round 9 (people & HR)

- Recordkeeping on top of the existing `users` table, deliberately not a new permissions model —
  Round 7 already generalised roles/permissions, so this round only needed `hr.manage` as one more
  permission key, not more access-control work.
- New `employees` collection (`src/routes/employees.routes.js`, `hr.manage`): hire date, phone,
  address, CNIC, salary, job title, emergency contact, notes. `user_id` optionally links an employee
  to a login account (one employee per user, enforced by a partial unique index) — an employee
  without system access (e.g. a delivery rider) is just as valid a record, with `user_id: null`.
- Front end: an Employees screen (list + form), gated in the nav the same way every other permission-
  gated screen is.
- Tests: `test/employees.test.js` — standalone and user-linked records, the one-employee-per-user
  rule, unlinking a user, and that a cashier (no `hr.manage`) is refused.

## Round 10 (scheduling & collaboration)

Three independent, deliberately small features — no new external front-end dependency was added
for any of them (no calendar widget, no rich-text editor, no WebSocket/real-time layer), matching
the project's existing no-build-step, dependency-light front end.

- **Appointments**: new `appointments` collection (`src/routes/appointments.routes.js`). Anyone
  signed in can book, edit and cancel their *own* appointments with no permission needed (same
  "everyone gets the basics" posture as, say, opening a till); `calendar.manage_all` additionally
  lets staff book/see/manage *everyone's* (building a shift roster, booking a consultation on
  someone else's calendar). Front end is a plain list grouped by date — not a calendar grid.
- **Staff messaging**: new `messages` collection (`src/routes/messages.routes.js`), open to every
  signed-in user, no permission gate — direct messages only (closer to Odoo Discuss's DMs than its
  channels), with an aggregation-built thread list (`GET /messages/threads`) and per-thread
  read-marking. Front end: a two-pane inbox (threads + conversation), no live polling — matches the
  "online-only, refresh to see new messages" posture already used for every other admin screen.
- **Knowledge wiki**: new `knowledge_articles` collection (`src/routes/knowledge.routes.js`). Reading
  is open to everyone signed in; writing needs `knowledge.manage`. Body is plain text (no markdown
  rendering, no WYSIWYG) with simple title/body substring search and tag filtering.
- Tests: `test/collaboration.test.js` — own-vs-everyone appointment visibility and edit rights,
  a two-way message exchange with unread counts, and knowledge read-for-everyone/write-gated.
- Fixed along the way: the `/messages/threads` aggregation needed `id` as a sort tiebreaker
  alongside `created_at` — two messages in the same second otherwise sorted non-deterministically
  and `$first` could pick the wrong one as "last message".

## Round 11 (business intelligence)

- Almost entirely a front-end round: no new collections, no new permission — reuses `reports.view`
  and the existing `/reports/summary` and `/reports/top-products` aggregation endpoints (Round 1)
  rather than re-deriving gross profit, revenue, or payment totals a second time.
- Generalised the dashboard's existing hand-rolled inline-SVG bar chart (`salesChartHtml`/
  `bindChart`, fixed at 7 days with "today" highlighted) into `trendChartHtml`, usable for any date
  range, keeping the same accessible hit-overlay/tooltip mechanism (`bindChart` needed no changes).
  Added two more chart primitives in the same hand-drawn style: `hBarChartHtml` (CSS-width
  horizontal bars, for top products) and `donutChartHtml` (SVG stroke-dasharray, for the payment-
  method split) — no charting library was added, consistent with the project never having taken a
  front-end dependency for this.
- New Analytics screen (`#/analytics`, gated `reports.view`): a date-range picker (defaults to the
  last 30 days), 4 KPI tiles (net sales, invoices, gross profit, returns), the daily sales trend,
  top 8 products by revenue, and the payment-method split — sitting alongside, not replacing, the
  existing text-table Reports screen.
- No new tests: the round added no new backend behaviour to test; the underlying endpoints are
  already covered by Round 1's report tests.

---

All 4 rounds requested (roles & permissions, operations gaps, people & HR, scheduling &
collaboration, business intelligence — 5 rounds once the foundational roles/permissions work is
split out) are complete: 128 tests passing on Node, zero regressions in any prior round.
