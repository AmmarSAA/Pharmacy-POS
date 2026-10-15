import { Router } from '../lib/router.js'
import { requirePermission } from '../auth.js'
import { nowStamp } from '../db.js'
import { notFound, reqString, optString } from '../lib/http.js'

// A plain-text/markdown wiki — no rich editor (the front end has no such library and this project
// deliberately doesn't add a first UI dependency just for this). Anyone signed in may read; writing
// needs knowledge.manage.

const readTags = (b) => {
  const raw = b.tags
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean)
  if (typeof raw === 'string') return raw.split(',').map((t) => t.trim()).filter(Boolean)
  return []
}

export default function knowledgeRoutes(db) {
  const r = Router()

  // ?q= searches title/body. ?tag= filters by tag.
  r.get('/', async (req, res) => {
    const filter = {}
    if (req.query.tag) filter.tags = req.query.tag
    if (req.query.q) {
      const re = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ title: re }, { body: re }]
    }
    const rows = await db.all('knowledge_articles', filter, { sort: { updated_at: -1 }, projection: { body: 0 } })
    res.json(await db.join(rows, [{ key: 'created_by', from: 'users', fields: { author_name: 'full_name' } }]))
  })

  r.get('/:id', async (req, res) => {
    const a = await db.get('knowledge_articles', req.params.id)
    if (!a) throw notFound('Article')
    res.json((await db.join([a], [{ key: 'created_by', from: 'users', fields: { author_name: 'full_name' } }]))[0])
  })

  r.post('/', requirePermission('knowledge.manage'), async (req, res) => {
    const id = await db.insert('knowledge_articles', {
      title: reqString(req.body, 'title', 'Title'), body: optString(req.body, 'body') || '',
      tags: readTags(req.body), created_by: req.user.id, updated_at: nowStamp(),
    })
    res.status(201).json(await db.get('knowledge_articles', id))
  })

  r.put('/:id', requirePermission('knowledge.manage'), async (req, res) => {
    const id = Number(req.params.id)
    const a = await db.get('knowledge_articles', id)
    if (!a) throw notFound('Article')
    const title = req.body.title !== undefined ? reqString(req.body, 'title', 'Title') : a.title
    const body = req.body.body !== undefined ? (optString(req.body, 'body') || '') : a.body
    const tags = req.body.tags !== undefined ? readTags(req.body) : a.tags
    await db.col('knowledge_articles').updateOne({ _id: id }, { $set: { title, body, tags, updated_at: nowStamp() } })
    res.json(await db.get('knowledge_articles', id))
  })

  return r
}
