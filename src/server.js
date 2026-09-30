import { openDb } from './db.js'
import { createApp } from './app.js'

const port = Number(process.env.PORT) || 3000
// Bind to all interfaces so other tills on the shop network can connect.
const host = process.env.HOST || '0.0.0.0'
const db = openDb()
createApp(db).listen(port, host, () => {
  console.log(`Pharmacy POS running at http://localhost:${port}`)
})
