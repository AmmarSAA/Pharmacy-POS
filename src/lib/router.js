import express from 'express'

// express.Router() whose handlers may be async: a rejected promise goes to the error handler
// (Express 4 would otherwise leave the request hanging).
const wrap = (fn) =>
  typeof fn !== 'function' || fn.length === 4
    ? fn
    : (req, res, next) => {
        try {
          const r = fn(req, res, next)
          if (r && typeof r.catch === 'function') r.catch(next)
        } catch (err) {
          next(err)
        }
      }

export function Router(opts) {
  const r = express.Router(opts)
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'use', 'all']) {
    const orig = r[m].bind(r)
    r[m] = (...args) => orig(...args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a))))
  }
  return r
}
