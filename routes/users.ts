/**
 * User search + suggest (profiles). All reads via supabaseAdmin; no public profile listing.
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { supabaseAdmin } from '../services/supabase.js'
import { avatarUrlsForPaths } from '../services/avatars.js'
import { visibleTagsForUser, visibleTagsForUsers } from '../services/userHashtags.js'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'
import { hiddenIdsFor, isMissingRelationOrColumn, userAllowedForViewer } from '../services/moderation.js'

type ProfileRow = {
  id: string
  username: string | null
  full_name: string | null
  birthday: string | null
  avatar_storage_path: string | null
  avatar_updated_at: string | null
  deleted_at?: string | null
  moderation_hidden_at?: string | null
  app_role?: string | null
}

async function friendshipMapFor(
  userId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const friendshipMap = new Map<string, string>()
  if (ids.length === 0) return friendshipMap
  const { data: requests } = await supabaseAdmin
    .from('friend_requests')
    .select('id, requester_id, addressee_id, status')
    .or(
      `and(requester_id.eq.${userId},addressee_id.in.(${ids.join(',')})),and(addressee_id.eq.${userId},requester_id.in.(${ids.join(',')}))`,
    )
  for (const r of requests ?? []) {
    const otherId = r.requester_id === userId ? r.addressee_id : r.requester_id
    if (r.status === 'accepted') {
      friendshipMap.set(otherId, 'friends')
    } else if (r.status === 'pending') {
      friendshipMap.set(
        otherId,
        r.requester_id === userId ? 'outgoing_pending' : 'incoming_pending',
      )
    }
  }
  return friendshipMap
}

async function friendshipDetailFor(
  userId: string,
  otherId: string,
): Promise<{ status: string; requestId: string | null }> {
  const { data: rows, error } = await supabaseAdmin
    .from('friend_requests')
    .select('id, requester_id, addressee_id, status')
    .or(
      `and(requester_id.eq.${userId},addressee_id.eq.${otherId}),and(addressee_id.eq.${userId},requester_id.eq.${otherId})`,
    )
    .limit(1)
  if (error || !rows?.length) return { status: 'none', requestId: null }
  const r = rows[0]!
  if (r.status === 'accepted') return { status: 'friends', requestId: r.id }
  if (r.status === 'pending') {
    return {
      status: r.requester_id === userId ? 'outgoing_pending' : 'incoming_pending',
      requestId: r.id,
    }
  }
  return { status: 'none', requestId: null }
}

async function toUserDtos(userId: string, page: ProfileRow[]) {
  const ids = page.map((p) => p.id)
  const friendshipMap = await friendshipMapFor(userId, ids)
  const urlMap = await avatarUrlsForPaths(page.map((p) => p.avatar_storage_path))
  const tagsMap = await visibleTagsForUsers(ids)
  return page.map((p) => ({
    id: p.id,
    username: p.username,
    full_name: p.full_name,
    avatarUrl: p.avatar_storage_path ? urlMap.get(p.avatar_storage_path) ?? null : null,
    avatarUpdatedAt: p.avatar_updated_at ?? null,
    friendshipStatus: friendshipMap.get(p.id) ?? 'none',
    tags: tagsMap.get(p.id) ?? [],
  }))
}

export async function userRoutes(app: FastifyInstance) {
  /**
   * GET /users/suggest?q= — top 10 users by username/full_name (optional prefix).
   * Strips leading `@`. Empty q returns top 10 by username.
   */
  app.get<{ Querystring: { q?: string } }>(
    '/users/suggest',
    { preHandler: requireAuth },
    async (request, reply) => {
      const raw = (request.query.q ?? '').trim().replace(/^@+/, '')
      if (exceedsLimit(raw, TEXT_LIMITS.search)) {
        return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.search} characters` })
      }

      let query = supabaseAdmin
        .from('profiles')
        .select('id, username, full_name, avatar_storage_path, avatar_updated_at, app_role')
        .neq('id', request.userId)
        .neq('app_role', 'admin')
        .order('username', { ascending: true })
        .limit(10)

      if (raw) {
        const safe = raw.replace(/[%_\\]/g, '')
        if (safe) {
          query = query.or(`username.ilike.%${safe}%,full_name.ilike.%${safe}%`)
        }
      }

      let { data: profiles, error } = await query
      if (error && isMissingRelationOrColumn(error)) {
        let fallback = supabaseAdmin
          .from('profiles')
          .select('id, username, full_name, avatar_storage_path, avatar_updated_at')
          .neq('id', request.userId)
          .order('username', { ascending: true })
          .limit(10)
        if (raw) {
          const safe = raw.replace(/[%_\\]/g, '')
          if (safe) {
            fallback = fallback.or(`username.ilike.%${safe}%,full_name.ilike.%${safe}%`)
          }
        }
        const retry = await fallback
        profiles = (retry.data ?? []) as typeof profiles
        error = retry.error
      }
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Suggest failed' })
      }

      const hides = await hiddenIdsFor(request.userId, 'user')
      const allowed: ProfileRow[] = []
      for (const p of (profiles ?? []) as ProfileRow[]) {
        if (await userAllowedForViewer(p.id, request.userId, p, hides)) allowed.push(p)
      }

      return { users: await toUserDtos(request.userId, allowed) }
    },
  )

  app.get<{ Querystring: { q?: string; limit?: string; cursor?: string } }>(
    '/users/search',
    { preHandler: requireAuth },
    async (request, reply) => {
      const q = (request.query.q ?? '').trim().replace(/^@+/, '')
      const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)
      const cursor = request.query.cursor?.trim()

      if (q.length < 2) {
        return reply.code(400).send({ error: 'Query must be at least 2 characters' })
      }
      if (exceedsLimit(q, TEXT_LIMITS.search)) {
        return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.search} characters` })
      }

      const safe = q.replace(/[%_\\]/g, '')
      let query = supabaseAdmin
        .from('profiles')
        .select('id, username, full_name, avatar_storage_path, avatar_updated_at, app_role')
        .neq('id', request.userId)
        .neq('app_role', 'admin')
        .or(`username.ilike.%${safe}%,full_name.ilike.%${safe}%`)
        .order('username', { ascending: true })
        .limit(limit + 1)

      if (cursor) {
        query = query.gt('username', cursor)
      }

      let { data: profiles, error } = await query
      if (error && isMissingRelationOrColumn(error)) {
        let fallback = supabaseAdmin
          .from('profiles')
          .select('id, username, full_name, avatar_storage_path, avatar_updated_at')
          .neq('id', request.userId)
          .or(`username.ilike.%${safe}%,full_name.ilike.%${safe}%`)
          .order('username', { ascending: true })
          .limit(limit + 1)
        if (cursor) fallback = fallback.gt('username', cursor)
        const retry = await fallback
        profiles = (retry.data ?? []) as typeof profiles
        error = retry.error
      }

      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Search failed' })
      }

      const page = ((profiles ?? []) as ProfileRow[]).slice(0, limit)
      const hides = await hiddenIdsFor(request.userId, 'user')
      const allowed: ProfileRow[] = []
      for (const p of page) {
        if (await userAllowedForViewer(p.id, request.userId, p, hides)) allowed.push(p)
      }
      const nextCursor =
        (profiles ?? []).length > limit ? page[page.length - 1]?.username ?? null : null

      return {
        users: await toUserDtos(request.userId, allowed),
        nextCursor,
      }
    },
  )

  /** GET /users/:id — public profile + friendship status for thread info / user profile page. */
  app.get<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const targetId = request.params.id
      if (targetId === request.userId) {
        return reply.code(400).send({ error: 'Use /profile for your own profile' })
      }

      const { data: profile, error } = await supabaseAdmin
        .from('profiles')
        .select('id, username, full_name, birthday, avatar_storage_path, avatar_updated_at, app_role')
        .eq('id', targetId)
        .maybeSingle()

      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Profile load failed' })
      }
      if (!profile) return reply.code(404).send({ error: 'User not found' })
      const row = profile as ProfileRow
      if (!(await userAllowedForViewer(targetId, request.userId, row))) {
        return reply.code(404).send({ error: 'User not found' })
      }

      const friendship = await friendshipDetailFor(request.userId, targetId)
      const urlMap = await avatarUrlsForPaths([profile.avatar_storage_path])
      const tags = await visibleTagsForUser(targetId)

      return {
        user: {
          id: row.id,
          username: row.username,
          full_name: row.full_name,
          birthday: row.birthday ?? null,
          avatarUrl: row.avatar_storage_path
            ? urlMap.get(row.avatar_storage_path) ?? null
            : null,
          avatarUpdatedAt: row.avatar_updated_at ?? null,
          friendshipStatus: friendship.status,
          friendRequestId: friendship.requestId,
          tags,
        },
      }
    },
  )

  /**
   * GET /users/:id/shared-communities — communities both users have joined.
   */
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>(
    '/users/:id/shared-communities',
    { preHandler: requireAuth },
    async (request, reply) => {
      const targetId = request.params.id
      const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)
      const cursor = request.query.cursor?.trim()

      const { data: myRows, error: myErr } = await supabaseAdmin
        .from('community_members')
        .select('community_id')
        .eq('user_id', request.userId)
        .eq('status', 'joined')

      if (myErr) {
        request.log.error(myErr)
        return reply.code(500).send({ error: 'Could not load communities' })
      }

      const myIds = (myRows ?? []).map((r) => r.community_id as string)
      if (myIds.length === 0) return { communities: [], nextCursor: null }

      const { data: theirRows, error: theirErr } = await supabaseAdmin
        .from('community_members')
        .select('community_id')
        .eq('user_id', targetId)
        .eq('status', 'joined')
        .in('community_id', myIds)

      if (theirErr) {
        request.log.error(theirErr)
        return reply.code(500).send({ error: 'Could not load communities' })
      }

      const sharedIds = (theirRows ?? []).map((r) => r.community_id as string)
      if (sharedIds.length === 0) return { communities: [], nextCursor: null }

      let query = supabaseAdmin
        .from('communities')
        .select('id, name, identifier, avatar_storage_path, avatar_updated_at')
        .in('id', sharedIds)
        .order('identifier', { ascending: true })
        .limit(limit + 1)

      if (cursor) {
        query = query.gt('identifier', cursor)
      }

      const { data: communities, error: commErr } = await query
      if (commErr) {
        request.log.error(commErr)
        return reply.code(500).send({ error: 'Could not load communities' })
      }

      type CommRow = {
        id: string
        name: string
        identifier: string
        avatar_storage_path: string | null
        avatar_updated_at: string | null
      }

      const page = ((communities ?? []) as CommRow[]).slice(0, limit)
      const nextCursor =
        (communities ?? []).length > limit ? page[page.length - 1]?.identifier ?? null : null
      const urlMap = await avatarUrlsForPaths(page.map((c) => c.avatar_storage_path))

      return {
        communities: page.map((c) => ({
          id: c.id,
          name: c.name,
          identifier: c.identifier,
          avatarUrl: c.avatar_storage_path ? urlMap.get(c.avatar_storage_path) ?? null : null,
          avatarUpdatedAt: c.avatar_updated_at ?? null,
        })),
        nextCursor,
      }
    },
  )
}
