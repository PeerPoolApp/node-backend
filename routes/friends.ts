/**
 * Friend request routes: request, accept, decline, unfriend, invite links.
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { supabaseAdmin } from '../services/supabase.js'
import { avatarUrlsForPaths } from '../services/avatars.js'
import {
  findOrCreateDirectConversation,
  sendFriendWelcomeMessages,
} from '../services/conversations.js'
import { notifyUsers } from '../services/notifications/dispatcher.js'
import { friendRequestNotification } from '../services/notifications/templates.js'
import {
  getEnabledFriendInviteLink,
  getOrCreateFriendInviteLink,
  recordFriendInviteJoin,
} from '../services/inviteLinks.js'
import { isAdminUser, isMissingRelationOrColumn } from '../services/moderation.js'
import { visibleTagsForUsers, type UserTagDto } from '../services/userHashtags.js'

const PROFILE_PUBLIC =
  'id, username, full_name, avatar_storage_path, avatar_updated_at'

type RequestBody = { userId?: string }

async function loadPublicProfilesByIds(ids: string[]) {
  if (ids.length === 0) {
    return [] as Array<{
      id: string
      username: string
      full_name: string
      avatar_storage_path?: string | null
      avatar_updated_at?: string | null
    }>
  }
  const withRole = await supabaseAdmin
    .from('profiles')
    .select(`${PROFILE_PUBLIC}, app_role`)
    .in('id', ids)
  if (withRole.error && isMissingRelationOrColumn(withRole.error)) {
    const fallback = await supabaseAdmin.from('profiles').select(PROFILE_PUBLIC).in('id', ids)
    return fallback.data ?? []
  }
  return ((withRole.data ?? []) as Array<{
    id: string
    username: string
    full_name: string
    avatar_storage_path?: string | null
    avatar_updated_at?: string | null
    app_role?: string | null
  }>).filter((p) => p.app_role !== 'admin')
}

async function mapProfilesWithAvatars(
  profiles: Array<{
    id: string
    username: string
    full_name: string
    avatar_storage_path?: string | null
    avatar_updated_at?: string | null
  }>,
) {
  const urlMap = await avatarUrlsForPaths(profiles.map((p) => p.avatar_storage_path))
  const tagsMap = await visibleTagsForUsers(profiles.map((p) => p.id))
  return profiles.map((p) => ({
    id: p.id,
    username: p.username,
    full_name: p.full_name,
    avatarUrl: p.avatar_storage_path ? urlMap.get(p.avatar_storage_path) ?? null : null,
    avatarUpdatedAt: p.avatar_updated_at ?? null,
    tags: (tagsMap.get(p.id) ?? []) as UserTagDto[],
  }))
}

export async function friendRoutes(app: FastifyInstance) {
  /** Legacy full list (kept for simple clients). */
  app.get('/friends', { preHandler: requireAuth }, async (request, reply) => {
    const { data: rows, error } = await supabaseAdmin
      .from('friend_requests')
      .select('id, requester_id, addressee_id, status, created_at, responded_at')
      .or(`requester_id.eq.${request.userId},addressee_id.eq.${request.userId}`)
      .order('created_at', { ascending: false })

    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not load friends' })
    }

    const otherIds = new Set<string>()
    for (const r of rows ?? []) {
      otherIds.add(r.requester_id === request.userId ? r.addressee_id : r.requester_id)
    }

    const profiles = await loadPublicProfilesByIds([...otherIds])

    const mapped = await mapProfilesWithAvatars(profiles)
    const byId = new Map(mapped.map((p) => [p.id, p]))

    return (rows ?? []).map((r) => {
      const otherId = r.requester_id === request.userId ? r.addressee_id : r.requester_id
      return {
        id: r.id,
        status: r.status,
        created_at: r.created_at,
        responded_at: r.responded_at,
        direction: r.requester_id === request.userId ? 'outgoing' : 'incoming',
        otherUser: byId.get(otherId) ?? null,
      }
    })
  })

  app.get('/friends/requests/count', { preHandler: requireAuth }, async (request, reply) => {
    const { count, error } = await supabaseAdmin
      .from('friend_requests')
      .select('id', { count: 'exact', head: true })
      .eq('addressee_id', request.userId)
      .eq('status', 'pending')

    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not count requests' })
    }

    return { count: count ?? 0 }
  })

  app.get<{ Querystring: { direction?: string; limit?: string; cursor?: string } }>(
    '/friends/requests',
    { preHandler: requireAuth },
    async (request, reply) => {
      const direction = request.query.direction === 'outgoing' ? 'outgoing' : 'incoming'
      const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)
      const cursor = request.query.cursor?.trim()

      let query = supabaseAdmin
        .from('friend_requests')
        .select('id, requester_id, addressee_id, status, created_at, responded_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(limit + 1)

      if (direction === 'incoming') {
        query = query.eq('addressee_id', request.userId)
      } else {
        query = query.eq('requester_id', request.userId)
      }

      if (cursor) {
        query = query.lt('created_at', cursor)
      }

      const { data: rows, error } = await query
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not load requests' })
      }

      const page = (rows ?? []).slice(0, limit)
      const nextCursor =
        (rows ?? []).length > limit ? page[page.length - 1]?.created_at ?? null : null

      const otherIds = page.map((r) =>
        r.requester_id === request.userId ? r.addressee_id : r.requester_id,
      )
      const profiles = await loadPublicProfilesByIds(otherIds)

      const mapped = await mapProfilesWithAvatars(profiles)
      const byId = new Map(mapped.map((p) => [p.id, p]))

      return {
        requests: page.map((r) => {
          const otherId = r.requester_id === request.userId ? r.addressee_id : r.requester_id
          return {
            id: r.id,
            status: r.status,
            created_at: r.created_at,
            responded_at: r.responded_at,
            direction,
            otherUser: byId.get(otherId) ?? null,
          }
        }),
        nextCursor,
      }
    },
  )

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/friends/recommendations',
    { preHandler: requireAuth },
    async (request, reply) => {
      const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)
      const cursor = request.query.cursor?.trim()

      const { data: myAccepted } = await supabaseAdmin
        .from('friend_requests')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${request.userId},addressee_id.eq.${request.userId}`)

      const friendIds = new Set<string>()
      for (const r of myAccepted ?? []) {
        friendIds.add(r.requester_id === request.userId ? r.addressee_id : r.requester_id)
      }

      if (friendIds.size === 0) {
        return { users: [], nextCursor: null }
      }

      const friendList = [...friendIds]
      const { data: asRequester, error: foafErr1 } = await supabaseAdmin
        .from('friend_requests')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .in('requester_id', friendList)

      const { data: asAddressee, error: foafErr2 } = await supabaseAdmin
        .from('friend_requests')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .in('addressee_id', friendList)

      if (foafErr1 || foafErr2) {
        request.log.error(foafErr1 ?? foafErr2)
        return reply.code(500).send({ error: 'Could not load recommendations' })
      }

      const foafRows = [...(asRequester ?? []), ...(asAddressee ?? [])]

      const exclude = new Set<string>([request.userId, ...friendIds])
      const { data: allRelated } = await supabaseAdmin
        .from('friend_requests')
        .select('requester_id, addressee_id, status')
        .or(`requester_id.eq.${request.userId},addressee_id.eq.${request.userId}`)

      for (const r of allRelated ?? []) {
        const other = r.requester_id === request.userId ? r.addressee_id : r.requester_id
        exclude.add(other)
      }

      const candidateIds = new Set<string>()
      for (const r of foafRows) {
        for (const id of [r.requester_id, r.addressee_id]) {
          if (!exclude.has(id)) candidateIds.add(id)
        }
      }
      exclude.forEach((id) => candidateIds.delete(id))

      const ids = [...candidateIds].sort()
      let sliced = ids
      if (cursor) {
        sliced = ids.filter((id) => id > cursor)
      }
      const pageIds = sliced.slice(0, limit)
      const nextCursor = sliced.length > limit ? pageIds[pageIds.length - 1] ?? null : null

      if (pageIds.length === 0) {
        return { users: [], nextCursor: null }
      }

      const profiles = await loadPublicProfilesByIds(pageIds)

      const mapped = await mapProfilesWithAvatars(profiles)
      mapped.sort((a, b) => a.id.localeCompare(b.id))

      return {
        users: mapped.map((u) => ({ ...u, friendshipStatus: 'none' as const })),
        nextCursor,
      }
    },
  )

  app.post<{ Body: RequestBody }>(
    '/friends/request',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.body?.userId?.trim()
      if (!userId) {
        return reply.code(400).send({ error: 'userId required' })
      }
      if (userId === request.userId) {
        return reply.code(400).send({ error: 'Cannot friend yourself' })
      }

      if (await isAdminUser(userId)) {
        return reply.code(404).send({ error: 'User not found' })
      }

      const { data: target } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('id', userId)
        .maybeSingle()

      if (!target) {
        return reply.code(404).send({ error: 'User not found' })
      }

      const { data: existing } = await supabaseAdmin
        .from('friend_requests')
        .select('id, status, requester_id, addressee_id')
        .or(
          `and(requester_id.eq.${request.userId},addressee_id.eq.${userId}),and(requester_id.eq.${userId},addressee_id.eq.${request.userId})`,
        )
        .maybeSingle()

      if (existing) {
        if (existing.status === 'accepted') {
          return reply.code(409).send({ error: 'Already friends' })
        }
        if (existing.status === 'pending') {
          if (existing.addressee_id === request.userId) {
            return reply.code(409).send({ error: 'They already sent you a request' })
          }
          return reply.code(409).send({ error: 'Request already pending' })
        }
      }

      const { data: created, error } = await supabaseAdmin
        .from('friend_requests')
        .insert({
          requester_id: request.userId,
          addressee_id: userId,
          status: 'pending',
        })
        .select('id, status, created_at')
        .single()

      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not send friend request' })
      }

      const { data: requester } = await supabaseAdmin
        .from('profiles')
        .select('full_name')
        .eq('id', request.userId)
        .maybeSingle()

      void notifyUsers(
        [userId],
        friendRequestNotification({
          requesterName: requester?.full_name ?? 'Someone',
          requestId: created.id,
        }),
        { excludeUserId: request.userId, log: request.log },
      )

      return reply.code(201).send(created)
    },
  )

  app.post<{ Params: { requestId: string } }>(
    '/friends/:requestId/accept',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: fr, error } = await supabaseAdmin
        .from('friend_requests')
        .select('id, requester_id, addressee_id, status')
        .eq('id', request.params.requestId)
        .maybeSingle()

      if (error || !fr) {
        return reply.code(404).send({ error: 'Request not found' })
      }
      if (fr.addressee_id !== request.userId) {
        return reply.code(403).send({ error: 'Only the addressee can accept' })
      }
      if (fr.status !== 'pending') {
        return reply.code(400).send({ error: 'Request is not pending' })
      }

      const now = new Date().toISOString()
      const { error: updateError } = await supabaseAdmin
        .from('friend_requests')
        .update({ status: 'accepted', responded_at: now })
        .eq('id', fr.id)

      if (updateError) {
        request.log.error(updateError)
        return reply.code(500).send({ error: 'Could not accept request' })
      }

      const conversationId = await findOrCreateDirectConversation(
        fr.requester_id,
        fr.addressee_id,
      )
      await sendFriendWelcomeMessages(conversationId, fr.requester_id, fr.addressee_id)

      return { conversationId, requestId: fr.id }
    },
  )

  app.post<{ Params: { requestId: string } }>(
    '/friends/:requestId/decline',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: fr, error } = await supabaseAdmin
        .from('friend_requests')
        .select('id, addressee_id, status')
        .eq('id', request.params.requestId)
        .maybeSingle()

      if (error || !fr) {
        return reply.code(404).send({ error: 'Request not found' })
      }
      if (fr.addressee_id !== request.userId) {
        return reply.code(403).send({ error: 'Only the addressee can decline' })
      }
      if (fr.status !== 'pending') {
        return reply.code(400).send({ error: 'Request is not pending' })
      }

      const { error: updateError } = await supabaseAdmin
        .from('friend_requests')
        .update({
          status: 'declined',
          responded_at: new Date().toISOString(),
        })
        .eq('id', fr.id)

      if (updateError) {
        request.log.error(updateError)
        return reply.code(500).send({ error: 'Could not decline request' })
      }

      return reply.code(204).send()
    },
  )

  /** Delete an accepted friendship (either party). Leaves direct chats intact. */
  app.post<{ Params: { requestId: string } }>(
    '/friends/:requestId/unfriend',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: fr, error } = await supabaseAdmin
        .from('friend_requests')
        .select('id, requester_id, addressee_id, status')
        .eq('id', request.params.requestId)
        .maybeSingle()

      if (error || !fr) {
        return reply.code(404).send({ error: 'Friendship not found' })
      }
      if (fr.requester_id !== request.userId && fr.addressee_id !== request.userId) {
        return reply.code(403).send({ error: 'Not a party to this friendship' })
      }
      if (fr.status !== 'accepted') {
        return reply.code(400).send({ error: 'Not an accepted friendship' })
      }

      const { error: delError } = await supabaseAdmin
        .from('friend_requests')
        .delete()
        .eq('id', fr.id)

      if (delError) {
        request.log.error(delError)
        return reply.code(500).send({ error: 'Could not unfriend' })
      }

      return reply.code(204).send()
    },
  )

  /** POST /friends/invite-links — get-or-create shareable friend-add token for me. */
  app.post('/friends/invite-links', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const link = await getOrCreateFriendInviteLink(request.userId)
      return {
        id: link.id,
        token: link.token,
        enabled: link.enabled,
        createdAt: link.created_at,
      }
    } catch (e) {
      request.log.error(e)
      return reply.code(500).send({ error: 'Could not create invite link' })
    }
  })

  /** GET /friends/by-invite/:token — preview creator for landing page. */
  app.get<{ Params: { token: string } }>(
    '/friends/by-invite/:token',
    { preHandler: requireAuth },
    async (request, reply) => {
      const link = await getEnabledFriendInviteLink(request.params.token)
      if (!link) {
        return reply.code(404).send({ error: 'Invite link not found' })
      }
      if (await isAdminUser(link.created_by)) {
        return reply.code(404).send({ error: 'User not found' })
      }
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('id, username, full_name, avatar_storage_path, avatar_updated_at')
        .eq('id', link.created_by)
        .maybeSingle()
      if (!profile) {
        return reply.code(404).send({ error: 'User not found' })
      }
      const [mapped] = await mapProfilesWithAvatars([profile])
      const alreadyFriends =
        request.userId === link.created_by
          ? true
          : Boolean(
              (
                await supabaseAdmin
                  .from('friend_requests')
                  .select('id')
                  .eq('status', 'accepted')
                  .or(
                    `and(requester_id.eq.${request.userId},addressee_id.eq.${link.created_by}),and(requester_id.eq.${link.created_by},addressee_id.eq.${request.userId})`,
                  )
                  .maybeSingle()
              ).data,
            )
      return {
        user: mapped,
        alreadyFriends,
        isSelf: request.userId === link.created_by,
      }
    },
  )

  /** POST /friends/join-by-link — accept/create friendship with link creator. */
  app.post<{ Body: { token?: string } }>(
    '/friends/join-by-link',
    { preHandler: requireAuth },
    async (request, reply) => {
      const token = request.body?.token?.trim()
      if (!token) {
        return reply.code(400).send({ error: 'token is required' })
      }
      const link = await getEnabledFriendInviteLink(token)
      if (!link) {
        return reply.code(404).send({ error: 'Invite link not found' })
      }
      const creatorId = link.created_by
      if (creatorId === request.userId) {
        return reply.code(400).send({ error: 'Cannot friend yourself' })
      }

      const { data: existing } = await supabaseAdmin
        .from('friend_requests')
        .select('id, status, requester_id, addressee_id')
        .or(
          `and(requester_id.eq.${request.userId},addressee_id.eq.${creatorId}),and(requester_id.eq.${creatorId},addressee_id.eq.${request.userId})`,
        )
        .maybeSingle()

      let requestId: string
      const now = new Date().toISOString()

      if (existing?.status === 'accepted') {
        requestId = existing.id
      } else if (existing) {
        const { error: updateError } = await supabaseAdmin
          .from('friend_requests')
          .update({ status: 'accepted', responded_at: now })
          .eq('id', existing.id)
        if (updateError) {
          request.log.error(updateError)
          return reply.code(500).send({ error: 'Could not accept friendship' })
        }
        requestId = existing.id
      } else {
        const { data: created, error: insertError } = await supabaseAdmin
          .from('friend_requests')
          .insert({
            requester_id: creatorId,
            addressee_id: request.userId,
            status: 'accepted',
            responded_at: now,
          })
          .select('id')
          .single()
        if (insertError || !created) {
          request.log.error(insertError)
          return reply.code(500).send({ error: 'Could not create friendship' })
        }
        requestId = created.id
      }

      const conversationId = await findOrCreateDirectConversation(creatorId, request.userId)
      if (!existing || existing.status !== 'accepted') {
        await sendFriendWelcomeMessages(conversationId, creatorId, request.userId)
      }
      await recordFriendInviteJoin(link.id, request.userId)

      return { conversationId, requestId }
    },
  )

  /**
   * GET `/friends/busy` — free/busy slots for accepted friends + self in a window.
   * Returns only userId + startsAt + endsAt (no titles/locations) for DSGVO.
   * Own joined events are always included; empty userIds still returns self slots.
   */
  app.get<{ Querystring: { from?: string; to?: string; userIds?: string } }>(
    '/friends/busy',
    { preHandler: requireAuth },
    async (request, reply) => {
      const from = request.query.from?.trim()
      const to = request.query.to?.trim()
      if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
        return reply.code(400).send({ error: 'from and to ISO timestamps required' })
      }
      if (Date.parse(to) < Date.parse(from)) {
        return reply.code(400).send({ error: 'to must be after from' })
      }
      const rawIds = (request.query.userIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const uniqueIds = [...new Set(rawIds)].slice(0, 80)

      const { data: friendships, error: frErr } = await supabaseAdmin
        .from('friend_requests')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${request.userId},addressee_id.eq.${request.userId}`)
      if (frErr) {
        request.log.error(frErr)
        return reply.code(500).send({ error: 'Could not verify friendships' })
      }
      const friendSet = new Set<string>()
      for (const r of friendships ?? []) {
        friendSet.add(r.requester_id === request.userId ? r.addressee_id : r.requester_id)
      }
      const allowed = uniqueIds.filter((id) => friendSet.has(id))
      // Always include the requester’s own joined events.
      const queryUsers = [...new Set([request.userId, ...allowed])]

      const { data: parts, error: pErr } = await supabaseAdmin
        .from('event_participants')
        .select('user_id, event_id')
        .in('user_id', queryUsers)
        .eq('status', 'joined')
      if (pErr) {
        request.log.error(pErr)
        return reply.code(500).send({ error: 'Could not load busy slots' })
      }
      const eventIds = [...new Set((parts ?? []).map((p) => p.event_id as string))]
      if (!eventIds.length) return { slots: [] }

      const { data: evRows, error: eErr } = await supabaseAdmin
        .from('events')
        .select('id, starts_at, ends_at')
        .in('id', eventIds)
        .is('canceled_at', null)
        .lt('starts_at', to)
        .gt('ends_at', from)
      if (eErr) {
        request.log.error(eErr)
        return reply.code(500).send({ error: 'Could not load busy slots' })
      }
      const evById = new Map(
        (evRows ?? []).map((e) => [
          e.id as string,
          { startsAt: e.starts_at as string, endsAt: e.ends_at as string },
        ]),
      )
      const slots: Array<{ userId: string; startsAt: string; endsAt: string }> = []
      for (const p of parts ?? []) {
        const ev = evById.get(p.event_id as string)
        if (!ev) continue
        slots.push({
          userId: p.user_id as string,
          startsAt: ev.startsAt,
          endsAt: ev.endsAt,
        })
      }
      slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      return { slots }
    },
  )
}
