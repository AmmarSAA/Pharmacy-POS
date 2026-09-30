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

Checklist at the end of this file, filled in after deployment.

## Later (not in this round)

Department issues/requisitions, purchase returns to supplier, purchase orders, double-entry
accounting (trial balance, income statement), barcode label printing, multiple godowns,
full data migration from the MultiTec database.
