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
