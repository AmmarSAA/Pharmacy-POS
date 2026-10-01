// Append-only record of owner-level changes (settings, staff accounts, ownership).
export function audit(db, userId, action, detail = null) {
  db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?, ?, ?)')
    .run(userId ?? null, action, detail === null ? null : JSON.stringify(detail))
}
