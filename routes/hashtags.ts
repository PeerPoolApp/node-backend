/**
 * Hashtag suggest API (shared catalog for events; communities later).
 * Layer: route. requireAuth. See `.cursor/rules/events.mdc`.
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { itemsForSlugs, suggestHashtagItems } from '../services/hashtags.js'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'

export async function hashtagRoutes(app: FastifyInstance) {
  /**
   * GET `/hashtags/suggest?q=` — top 10 allowed slugs by use_count (+ group icon meta).
   */
  app.get<{ Querystring: { q?: string } }>(
    '/hashtags/suggest',
    { preHandler: requireAuth },
    async (request, reply) => {
      const q = request.query.q ?? ''
      if (exceedsLimit(q, TEXT_LIMITS.hashtag + 1)) {
        return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.hashtag} characters` })
      }
      try {
        const items = await suggestHashtagItems(q)
        return {
          hashtags: items.map((i) => i.slug),
          items,
        }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not suggest hashtags' })
      }
    },
  )

  /**
   * GET `/hashtags/meta?slugs=a,b,c` — group meta for known slugs (chip hydrate).
   */
  app.get<{ Querystring: { slugs?: string } }>(
    '/hashtags/meta',
    { preHandler: requireAuth },
    async (request, reply) => {
      const raw = (request.query.slugs ?? '').trim()
      if (!raw) return { items: [] as Awaited<ReturnType<typeof itemsForSlugs>> }
      const parts = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
      if (parts.length > 20) {
        return reply.code(400).send({ error: 'At most 20 slugs' })
      }
      for (const p of parts) {
        if (exceedsLimit(p, TEXT_LIMITS.hashtag)) {
          return reply.code(400).send({ error: `Slug must be at most ${TEXT_LIMITS.hashtag} characters` })
        }
      }
      try {
        const items = await itemsForSlugs(parts)
        return { items }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not load hashtag meta' })
      }
    },
  )
}
