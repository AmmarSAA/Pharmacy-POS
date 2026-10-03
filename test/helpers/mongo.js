// A throwaway MongoDB (single-node replica set, so transactions work) for the tests in one file.
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { Store } from '../../src/store.js'
import { initDb } from '../../src/db.js'

let rs, client
let n = 0

export async function testStore() {
  if (!rs) {
    rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
    client = await MongoClient.connect(rs.getUri())
  }
  return initDb(new Store(client, client.db(`test_${process.pid}_${n++}`)))
}

export async function stopTestStore() {
  await client?.close()
  await rs?.stop()
  rs = client = null
}

// Inserts a record the way the app does (id, created_at), for setting up test data directly.
export const put = (db, name, doc) => db.insert(name, doc)
