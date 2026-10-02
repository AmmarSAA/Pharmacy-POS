// MultiTec item export (tab separated: code, name, pack unit, manufacturer, category) -> import CSV.
// Usage: node scripts/multitec-items-to-csv.mjs items.tsv > items.csv   (see docs/MIGRATION.md)
import { readFileSync } from 'node:fs'

const GENERIC_MAKERS = new Set(['DEFAULT MANUFACTURER', 'GENERAL', 'NULL', ''])
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const csv = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))

const seen = new Set()
const out = ['Item Code,Item Name,Manufacturer,PackUnit,Category']
for (const line of readFileSync(process.argv[2], 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  const [code, name, pack, maker, category] = line.split('\t').map(clean)
  if (!code || !name || seen.has(code)) continue
  seen.add(code)
  const manufacturer = GENERIC_MAKERS.has(maker.toUpperCase()) ? '' : maker
  out.push([code, name, manufacturer, Math.max(1, parseInt(pack, 10) || 1), category].map(csv).join(','))
}
process.stdout.write(out.join('\n') + '\n')
console.error(`${out.length - 1} items`)
