// Makes a Durable Object's SQLite storage (ctx.storage.sql) look like the subset of
// node:sqlite's DatabaseSync that the app uses: exec(), prepare().get/all/run, transactions.

// Rewrites :name parameters to ? (skipping quoted text) and returns their order.
function compile(sql) {
  const names = []
  let out = ''
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (c === "'" || c === '"') {
      const end = sql.indexOf(c, i + 1)
      const stop = end === -1 ? sql.length : end + 1
      out += sql.slice(i, stop)
      i = stop - 1
    } else if (c === ':' && /[A-Za-z_]/.test(sql[i + 1] || '')) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))
      names.push(m[0])
      out += '?'
      i += m[0].length
    } else {
      out += c
    }
  }
  return { sql: out, names }
}

const toSql = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? Number(v) : v)

export class SqlStorageDb {
  constructor(storage) {
    this.storage = storage
    this.sql = storage.sql
  }

  exec(sql) {
    this.sql.exec(sql)
  }

  prepare(source) {
    const { sql, names } = compile(source)
    const bind = (args) => {
      const first = args[0]
      // An object argument carries named parameters (node:sqlite style); with no :names in the
      // SQL it binds nothing, rather than being passed through as a value.
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        return names.map((n) => toSql(first[n]))
      }
      return args.map(toSql)
    }
    const run = (args) => this.sql.exec(sql, ...bind(args))
    return {
      get: (...args) => run(args).toArray()[0],
      all: (...args) => run(args).toArray(),
      run: (...args) => {
        const cursor = run(args)
        cursor.toArray()
        const { id } = this.sql.exec('SELECT last_insert_rowid() AS id').one()
        return { changes: cursor.rowsWritten, lastInsertRowid: id }
      },
    }
  }

  transactionSync(fn) {
    return this.storage.transactionSync(fn)
  }
}
