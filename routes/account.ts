/**
 * GDPR account export + delete. Auth required. Mutations via supabaseAdmin.
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { supabaseAdmin } from '../services/supabase.js'
import { eraseAccount } from '../services/accountErase.js'
import { createPardonRequest } from '../services/moderation.js'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'

export async function accountRoutes(app: FastifyInstance) {
  /**
   * GET `/account/export` — JSON dump of the caller's personal data.
   */
  app.get('/account/export', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.userId
    const [
      profile,
      tags,
      friends,
      memberships,
      organized,
      rsvp,
      sentMessages,
      notifications,
      devices,
    ] = await Promise.all([
      supabaseAdmin.from('profiles').select('*').eq('id', userId).maybeSingle(),
      supabaseAdmin.from('user_hashtags').select('hashtag_id, score, updated_at').eq('user_id', userId),
      supabaseAdmin
        .from('friend_requests')
        .select('id, requester_id, addressee_id, status, created_at, responded_at')
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`),
      supabaseAdmin
        .from('community_members')
        .select('community_id, status, joined_at')
        .eq('user_id', userId),
      supabaseAdmin
        .from('events')
        .select('id, title, starts_at, ends_at, visibility, created_at')
        .eq('organizer_user_id', userId),
      supabaseAdmin
        .from('event_participants')
        .select('event_id, status, created_at')
        .eq('user_id', userId),
      supabaseAdmin
        .from('messages')
        .select('id, conversation_id, created_at, body')
        .eq('sender_id', userId)
        .order('created_at', { ascending: false })
        .limit(5000),
      supabaseAdmin
        .from('user_notifications')
        .select('id, kind, created_at, read_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(500),
      supabaseAdmin.from('push_devices').select('id, platform, created_at').eq('user_id', userId),
    ])

    if (profile.error) {
      request.log.error(profile.error)
      return reply.code(500).send({ error: 'Could not export profile' })
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      email: request.userEmail,
      profile: profile.data,
      tags: tags.data ?? [],
      friends: friends.data ?? [],
      communities: memberships.data ?? [],
      eventsOrganized: organized.data ?? [],
      eventRsvp: rsvp.data ?? [],
      messagesSent: sentMessages.data ?? [],
      notifications: notifications.data ?? [],
      pushDevices: devices.data ?? [],
    }

    reply.header('Content-Type', 'application/json; charset=utf-8')
    reply.header('Content-Disposition', 'attachment; filename="peerpool-personal-data.json"')
    return payload
  })

  /**
   * POST `/account/delete` — `{ confirm: "delete" }` in-place erase.
   */
  app.post<{ Body: { confirm?: string } }>(
    '/account/delete',
    { preHandler: requireAuth },
    async (request, reply) => {
      const confirm = (request.body?.confirm ?? '').trim()
      if (confirm !== 'delete') {
        return reply.code(400).send({ error: 'Type delete to confirm' })
      }
      try {
        const result = await eraseAccount(request.userId)
        if (!result.ok) return reply.code(result.status).send({ error: result.error })
        return { ok: true }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not delete account' })
      }
    },
  )

  /**
   * POST `/account/pardon` — banned users request a pardon.
   */
  app.post<{ Body: { body?: string } }>(
    '/account/pardon',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = request.body?.body ?? ''
      if (exceedsLimit(body, TEXT_LIMITS.pardonBody)) {
        return reply
          .code(400)
          .send({ error: `Message must be at most ${TEXT_LIMITS.pardonBody} characters` })
      }
      try {
        const result = await createPardonRequest(request.userId, body)
        if (!result.ok) return reply.code(result.status).send({ error: result.error })
        return { ok: true, id: result.reportId }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not submit pardon request' })
      }
    },
  )
}
