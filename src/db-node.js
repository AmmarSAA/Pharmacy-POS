import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { initDb } from './db.js'

// Opens (and creates if needed) the SQLite database file when running under Node.
export function openDb(path = process.env.DB_PATH || 'data/pharmacy.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  return initDb(db)
}
