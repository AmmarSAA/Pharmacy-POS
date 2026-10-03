// Append-only record of owner-level changes (settings, staff accounts, ownership).
export async function audit(db, userId, action, detail = null) {
  await db.insert('audit_log', { user_id: userId ?? null, action, detail: detail === null ? null : JSON.stringify(detail) })
}
