# Migrating from MultiTec (MULTI SOFT)

MultiTec keeps its data in a SQL Server database (`D:\Multi-Tec\Data\MultiTec_Data.MDF`).

## What was found (Federal Hospital copy received 2 Oct 2026, 14.8 MB)

- 10,771 items (10,770 real; code `1` "TESTING ITEM" left out), 417 manufacturers, 2 categories
- No purchases, stock, supplier balances or sales history (one test sale) — the copy was
  "initialized", so only the item master migrates. Prices are 0; they are set by the first purchases.
- Item fields that carry data: code (`AliasName`, `ph…`, unique), name, manufacturer, units per pack
  (`PackUnit`), category. Everything else is defaults.

## Steps

1. Attach the MDF to SQL Server (no log file needed):

   ```sql
   CREATE DATABASE MultiTec ON (FILENAME = '/data/MultiTec_Data.MDF') FOR ATTACH_REBUILD_LOG
   ```

2. Export the items (tab separated, no header):

   ```sql
   SELECT i.AliasName, i.Name, CAST(i.PackUnit AS int), m.Name, c.Name
   FROM Item i JOIN Manufacturer m ON m.ManfSno = i.ManfSno JOIN ItemCategory c ON c.ICatSno = i.ICatSno
   WHERE i.AliasName LIKE 'ph%' ORDER BY i.ISno
   ```

   e.g. `sqlcmd -C -S 127.0.0.1 -U sa -d MultiTec -W -h -1 -s "<TAB>" -Q "<query>" > items.tsv`

3. Convert to the import CSV: `node scripts/multitec-items-to-csv.mjs items.tsv > items.csv`
   (collapses spacing, blanks the generic "Default Manufacturer"/"GENERAL", drops duplicate codes).

4. In the app: Products → Import items → choose `items.csv` → Import. Items are matched by code, so
   importing again updates them instead of duplicating, and keeps prices set in the app.

After importing, mark prescription-only and controlled items (Products → edit → Schedule):
MultiTec did not record this.

## If a live copy with history arrives

The same database also has `Party` (suppliers/customers), `PurchaseHeader`/`Purchase`,
`SaleHeader`/`Sale`, `StockLedger` (batch/expiry stock) and `AccountLedger`. Check their row
counts first: `SELECT t.name, SUM(p.rows) FROM sys.tables t JOIN sys.partitions p ON ... GROUP BY t.name`.
