import { MongoClient } from 'mongodb'
import { Store } from './store.js'
import { initDb } from './db.js'

// Connects to MongoDB (MONGODB_URI, database MONGODB_DB or the one named in the URI) under Node.
export async function openStore(uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB) {
  if (!uri) throw new Error('Set MONGODB_URI (e.g. mongodb://127.0.0.1:27017/pharmacy?replicaSet=rs0)')
  const client = await MongoClient.connect(uri, { appName: 'pharmacy-pos' })
  return initDb(new Store(client, client.db(dbName || undefined)))
}
