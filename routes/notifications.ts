/**
 * In-app notification inbox (non-message kinds). List / unread / mark read.
 */

import {
  collectionResponse,
  encodePageCursor,
  decodePageCursor,
} from '../lib/collectionResponse.js'
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
      let cursor
      try {
        cursor = decodePageCursor(request.query.cursor)
      } catch {
        return reply.code(400).send({ error: 'Invalid cursor' })
      }

      let query = supabaseAdmin
        .from('user_notifications')
        .select('id, kind, title, body, data, read_at, created_at')
        .eq('user_id', request.userId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1)

      if (cursor?.id)
        query = query.or(
          `created_at.lt.${cursor.date},and(created_at.eq.${cursor.date},id.lt.${cursor.id})`,
        )
      else if (cursor) query = query.lt('created_at', cursor.date)

      const { data, error } = await query
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not load notifications' })
      }

      const rows = (data ?? []) as NotificationRow[]
      const page = rows.slice(0, limit)
      const nextCursor =
        rows.length > limit ? (page.length ? encodePageCursor(page[page.length - 1]!) : null) : null

      const dtos = page.map(toDto)
      const requestIds = dtos.flatMap((n) => (n.requestId ? [n.requestId] : []))
      const eventIds = dtos.flatMap((n) => (n.eventId ? [n.eventId] : []))
      const communityIds = dtos.flatMap((n) => (n.communityId ? [n.communityId] : []))
      const [friends, rsvps, events, memberships] = await Promise.all([
        requestIds.length
          ? supabaseAdmin
              .from('friend_requests')
              .select('id')
              .in('id', requestIds)
              .eq('addressee_id', request.userId)
              .eq('status', 'pending')
          : { data: [], error: null },
        eventIds.length
          ? supabaseAdmin
              .from('event_participants')
              .select('event_id, status')
              .in('event_id', eventIds)
              .eq('user_id', request.userId)
          : { data: [], error: null },
        eventIds.length
          ? supabaseAdmin.from('events').select('id, ends_at').in('id', eventIds)
          : { data: [], error: null },
        communityIds.length
          ? supabaseAdmin
              .from('community_members')
              .select('community_id, status')
              .in('community_id', communityIds)
              .eq('user_id', request.userId)
          : { data: [], error: null },
      ])
      // Unknown status remains actionable rather than silently hiding an invitation on transient failure.
      const annotated = dtos.map((n) => ({
        ...n,
        actionable:
          n.kind === 'friend_request'
            ? Boolean(friends.error || friends.data?.some((r) => r.id === n.requestId))
            : n.kind === 'event_invite'
              ? Boolean(
                  rsvps.error ||
                  events.error ||
                  (rsvps.data?.some(
                    (r) => r.event_id === n.eventId && ['invited', 'interested'].includes(r.status),
                  ) &&
                    events.data?.some(
                      (e) => e.id === n.eventId && new Date(e.ends_at).getTime() > Date.now(),
                    )),
                )
              : n.kind === 'community_invite'
                ? Boolean(
                    memberships.error ||
                    memberships.data?.some(
                      (m) =>
                        m.community_id === n.communityId &&
                        ['invited', 'requested'].includes(m.status),
                    ),
                  )
                : false,
      }))
      return collectionResponse(request, reply, 'notifications', annotated, nextCursor)
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
      .lte('created_at', now)

    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not mark notifications read' })
    }
    return { ok: true, readAt: now }
  })
}
