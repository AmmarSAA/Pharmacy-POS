export class HttpError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details)
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`)

const str = (v) => (v === undefined || v === null ? '' : String(v).trim())

// Small field readers that throw 400 with a clear message.
export function reqString(body, field, label = field) {
  const v = str(body?.[field])
  if (!v) throw badRequest(`${label} is required`)
  return v
}

export function optString(body, field) {
  const v = str(body?.[field])
  return v || null
}

export function reqInt(body, field, { min = -Infinity, max = Infinity, label = field } = {}) {
  const v = body?.[field]
  if (v === undefined || v === null || v === '' || !Number.isInteger(Number(v))) {
    throw badRequest(`${label} must be a whole number`)
  }
  const n = Number(v)
  if (n < min || n > max) throw badRequest(`${label} must be between ${min} and ${max}`)
  return n
}

export function optInt(body, field, def, opts) {
  const v = body?.[field]
  if (v === undefined || v === null || v === '') return def
  return reqInt(body, field, opts)
}

export function reqDate(body, field, label = field) {
  const v = reqString(body, field, label)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw badRequest(`${label} must be a date (YYYY-MM-DD)`)
  }
  return v
}

export function optDate(body, field, label = field) {
  return str(body?.[field]) ? reqDate(body, field, label) : null
}

export function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw badRequest(`${label} must be one of: ${allowed.join(', ')}`)
  return value
}
