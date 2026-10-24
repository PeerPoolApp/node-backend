/** Opt-in conditional reads, calculated after authorization and complete DTO construction.
 * Parent updated_at alone cannot validate derived counts, membership or moderation. */
import type { FastifyInstance } from 'fastify'
import { rowRevision } from './collectionResponse.js'

/** Keeps legacy clients unchanged and never caches failed or mutation responses. */
export function installResourceResponses(app: FastifyInstance) {
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'GET' || request.headers['x-peerpool-resource'] !== '1'
      || reply.statusCode !== 200 || typeof payload !== 'string'
      || !/^\/(events|communities|conversations|users|profile|hashtags|notifications|friends)(\/|\?|$)/.test(request.url)) return payload
    let value: unknown
    try { value = JSON.parse(payload) } catch { return payload }
    const etag = `"${rowRevision(value)}"`
    reply.header('Cache-Control', 'private, no-store').header('ETag', etag)
    if (request.headers['if-none-match'] === etag) {
      reply.code(304)
      reply.removeHeader('content-length')
      return null
    }
    // Only the primary entity list participates; nested DTO fields stay atomic per entity.
    const key = Array.isArray(value) ? null : value && typeof value === 'object'
      ? Object.keys(value).find(k => Array.isArray((value as Record<string, unknown>)[k])) : undefined
    const rows = key === null ? value : key ? (value as Record<string, unknown>)[key] : null
    if (!Array.isArray(rows)) return payload
    const identity = ['id','userId','conversation_id'].find(field => rows.every(row => row && typeof row[field] === 'string'))
    if (!identity) return payload
    const revisions = Object.fromEntries(rows.map(row => [row[identity], rowRevision(row)]))
    let known: Record<string, string> = {}
    try {
      const hint = request.headers['x-peerpool-known']
      if (typeof hint === 'string' && hint.length <= 16000) {
        const parsed = JSON.parse(hint)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) known = parsed
      }
    } catch { /* Hints are optional; malformed input receives a complete page. */ }
    const base = key ? { ...(value as Record<string, unknown>), [key]: undefined } : null
    return JSON.stringify({ resourceDelta: 1, key, identity, base, revisions,
      order: rows.map(row => row[identity]), rows: rows.filter(row => known[row[identity]] !== revisions[row[identity]]) })
  })
}
