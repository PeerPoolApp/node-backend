/**
 * In-app notification inbox (non-message kinds). List / unread / mark read.
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { supabaseAdmin } from '../services/supabase.js'

type NotificationRow = {
  id: string
  kind: string
  title: string
  body: string
  data: Record<string, unknown> | null
  read_at: string | null
  created_at: string
}

function parseLimit(raw: string | undefined, fallback = 20): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(100, Math.floor(n))
}

function toDto(row: NotificationRow) {
  const data = row.data && typeof row.data === 'object' ? row.data : {}
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    readAt: row.read_at,
    createdAt: row.created_at,
    conversationId: typeof data.conversationId === 'string' ? data.conversationId : undefined,
    messageId: typeof data.messageId === 'string' ? data.messageId : undefined,
    requestId: typeof data.requestId === 'string' ? data.requestId : undefined,
    eventId: typeof data.eventId === 'string' ? data.eventId : undefined,
    communityId: typeof data.communityId === 'string' ? data.communityId : undefined,
    inviteToken: typeof data.inviteToken === 'string' ? data.inviteToken : undefined,
  }
}

export async function notificationRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/notifications',
    { preHandler: requireAuth },
    async (request, reply) => {
      const limit = parseLimit(request.query.limit)
      const cursor = request.query.cursor?.trim() || null

      let query = supabaseAdmin
        .from('user_notifications')
        .select('id, kind, title, body, data, read_at, created_at')
        .eq('user_id', request.userId)
        .order('created_at', { ascending: false })
        .limit(limit + 1)

      if (cursor) {
        query = query.lt('created_at', cursor)
      }

      const { data, error } = await query
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not load notifications' })
      }

      const rows = (data ?? []) as NotificationRow[]
      const page = rows.slice(0, limit)
      const nextCursor =
        rows.length > limit ? page[page.length - 1]?.created_at ?? null : null

      return {
        notifications: page.map(toDto),
        nextCursor,
      }
    },
  )

  app.get('/notifications/unread-count', { preHandler: requireAuth }, async (request, reply) => {
    const { count, error } = await supabaseAdmin
      .from('user_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', request.userId)
      .is('read_at', null)

    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not load unread count' })
    }
    return { count: count ?? 0 }
  })

  app.post<{ Params: { id: string } }>(
    '/notifications/:id/read',
    { preHandler: requireAuth },
    async (request, reply) => {
      const now = new Date().toISOString()
      const { data, error } = await supabaseAdmin
        .from('user_notifications')
        .update({ read_at: now })
        .eq('id', request.params.id)
        .eq('user_id', request.userId)
        .is('read_at', null)
        .select('id')
        .maybeSingle()

      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not mark notification read' })
      }
      return { ok: true, updated: Boolean(data) }
    },
  )

  app.post('/notifications/read-all', { preHandler: requireAuth }, async (request, reply) => {
    const now = new Date().toISOString()
    const { error } = await supabaseAdmin
      .from('user_notifications')
      .update({ read_at: now })
      .eq('user_id', request.userId)
      .is('read_at', null)

    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not mark notifications read' })
    }
    return { ok: true }
  })
}
