import { openStore } from './db-node.js'
import { createApp } from './app.js'

// No top-level await: some Node.js hosts (e.g. Hostinger's LiteSpeed runner) load the entry file
// with require(), which can only load an ESM module when it has none.
(async () => {
  const port = Number(process.env.PORT) || 3000
  // Bind to all interfaces so other tills on the shop network can connect.
  const host = process.env.HOST || '0.0.0.0'
  const db = await openStore()
  createApp(db).listen(port, host, () => {
    console.log(`Pharmacy POS running at http://localhost:${port}`)
  })
})()
