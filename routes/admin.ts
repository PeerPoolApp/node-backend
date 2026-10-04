/**
 * Operator-only lists and moderation actions. requireAdmin. Bypass content hides.
 */

import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/auth.js'
import { supabaseAdmin } from '../services/supabase.js'
import { avatarUrlsForPaths } from '../services/avatars.js'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'
import { visibleTagsForUsers } from '../services/userHashtags.js'
import {
  communityAvatarUrlsForPaths,
  COMMUNITY_SELECT_CORE,
  memberCount,
} from '../services/communities.js'
import { hashtagItemsForCommunityIds } from '../services/hashtags.js'
import {
  adminCommunitiesByIds,
  adminEventDtosFromRows,
  adminEventsByIds,
  adminMessagesByIds,
  adminUsersByIds,
} from '../services/adminCatalog.js'
import { EVENT_SELECT, type EventRow } from '../services/events.js'
import {
  banUser,
  isReportReason,
  resolveReport,
  setTargetHidden,
  unbanUser,
  type ReportReason,
} from '../services/moderation.js'

const PROFILE_LIST =
  'id, username, full_name, birthday, app_role, deleted_at, moderation_hidden_at, banned_at, ban_reason, ban_details, avatar_storage_path, avatar_updated_at, created_at'

function parseLimit(raw: string | undefined, max = 50): number {
  return Math.min(Number(raw ?? 20) || 20, max)
}

export async function adminRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string; limit?: string; cursor?: string; q?: string } }>(
    '/admin/reports',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const status = (request.query.status ?? 'unresolved').trim()
      const limit = parseLimit(request.query.limit)
      const cursor = request.query.cursor?.trim()
      const q = (request.query.q ?? '').trim()
      if (exceedsLimit(q, TEXT_LIMITS.search)) {
        return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.search} characters` })
      }
      if (!['unresolved', 'approved', 'blocked', 'all'].includes(status)) {
        return reply.code(400).send({ error: 'Invalid status' })
      }

      let query = supabaseAdmin
        .from('reports')
        .select(
          'id, reporter_id, target_kind, target_id, reason, details, status, created_at, resolved_at',
        )
        .order('created_at', { ascending: false })
        .limit(limit + 1)
      if (status !== 'all') query = query.eq('status', status)
      if (cursor) query = query.lt('created_at', cursor)

      const { data, error } = await query
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not list reports' })
      }
      const page = (data ?? []).slice(0, limit)
      const nextCursor = (data ?? []).length > limit ? page[page.length - 1]?.created_at ?? null : null

      const reporterIds = [...new Set(page.map((r) => r.reporter_id as string))]
      const userTargetIds = page.filter((r) => r.target_kind === 'user').map((r) => r.target_id as string)
      const eventTargetIds = page.filter((r) => r.target_kind === 'event').map((r) => r.target_id as string)
      const communityTargetIds = page
        .filter((r) => r.target_kind === 'community')
        .map((r) => r.target_id as string)
      const messageTargetIds = page
        .filter((r) => r.target_kind === 'message')
        .map((r) => r.target_id as string)

      const [users, events, communities, messages] = await Promise.all([
        adminUsersByIds([...reporterIds, ...userTargetIds]),
        adminEventsByIds(eventTargetIds),
        adminCommunitiesByIds(communityTargetIds),
        adminMessagesByIds(messageTargetIds),
      ])
      for (const m of messages.values()) {
        if (m.sender) users.set(m.sender.id, m.sender)
      }

      return {
        reports: page.map((r) => {
          const kind = r.target_kind as string
          const targetId = r.target_id as string
          return {
            id: r.id,
            reporterId: r.reporter_id,
            reporter: users.get(r.reporter_id as string) ?? null,
            targetKind: kind,
            targetId,
            reason: r.reason,
            details: r.details,
            status: r.status,
            createdAt: r.created_at,
            resolvedAt: r.resolved_at,
            targetUser: kind === 'user' ? users.get(targetId) ?? null : null,
            targetEvent: kind === 'event' ? events.get(targetId) ?? null : null,
            targetCommunity: kind === 'community' ? communities.get(targetId) ?? null : null,
            targetMessage: kind === 'message' ? messages.get(targetId) ?? null : null,
          }
        }),
        nextCursor,
      }
    },
  )

  app.post<{ Params: { id: string }; Body: { status?: string } }>(
    '/admin/reports/:id/resolve',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const status = request.body?.status?.trim()
      if (status !== 'approved' && status !== 'blocked') {
        return reply.code(400).send({ error: 'status must be approved or blocked' })
      }
      try {
        const result = await resolveReport({ reportId: request.params.id, status })
        if (!result.ok) return reply.code(result.status).send({ error: result.error })
        return { ok: true }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not resolve report' })
      }
    },
  )

  app.get<{
    Querystring: { q?: string; limit?: string; cursor?: string; banned?: string }
  }>('/admin/users', { preHandler: requireAdmin }, async (request, reply) => {
    const q = (request.query.q ?? '').trim().replace(/^@+/, '')
    const limit = parseLimit(request.query.limit)
    const cursor = request.query.cursor?.trim()
    const bannedOnly = request.query.banned === '1'
    if (exceedsLimit(q, TEXT_LIMITS.search)) {
      return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.search} characters` })
    }

    let query = supabaseAdmin
      .from('profiles')
      .select(PROFILE_LIST)
      .is('deleted_at', null)
      .order('username', { ascending: true })
      .limit(limit + 1)
    if (bannedOnly) query = query.not('banned_at', 'is', null)
    if (cursor) query = query.gt('username', cursor)
    if (q) {
      const safe = q.replace(/[%_\\]/g, '')
      if (safe) query = query.or(`username.ilike.%${safe}%,full_name.ilike.%${safe}%`)
    }

    const { data, error } = await query
    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not list users' })
    }
    const page = (data ?? []).slice(0, limit)
    const nextCursor = (data ?? []).length > limit ? page[page.length - 1]?.username ?? null : null
    const urlMap = await avatarUrlsForPaths(page.map((p) => p.avatar_storage_path as string | null))

    const userIds = page.map((p) => p.id as string)
    const { data: pardons } = userIds.length
      ? await supabaseAdmin
          .from('pardon_requests')
          .select('id, user_id, body, status, created_at')
          .in('user_id', userIds)
          .eq('status', 'pending')
      : { data: [] as { id: string; user_id: string; body: string; status: string; created_at: string }[] }
    const pardonByUser = new Map((pardons ?? []).map((p) => [p.user_id, p]))
    const tagsMap = await visibleTagsForUsers(userIds)

    return {
      users: page.map((p) => ({
        id: p.id,
        username: p.username,
        fullName: p.full_name,
        birthday: p.birthday,
        appRole: p.app_role,
        bannedAt: p.banned_at,
        banReason: p.ban_reason,
        banDetails: p.ban_details,
        moderationHiddenAt: p.moderation_hidden_at,
        avatarUrl: p.avatar_storage_path
          ? urlMap.get(p.avatar_storage_path as string) ?? null
          : null,
        avatarUpdatedAt: p.avatar_updated_at,
        tags: tagsMap.get(p.id as string) ?? [],
        pendingPardon: pardonByUser.get(p.id as string) ?? null,
        createdAt: p.created_at,
      })),
      nextCursor,
    }
  })

  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>(
    '/admin/users/:id/communities',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const userId = request.params.id
      const limit = parseLimit(request.query.limit)
      const cursor = request.query.cursor?.trim()
      const { data: rows, error: memErr } = await supabaseAdmin
        .from('community_members')
        .select('community_id')
        .eq('user_id', userId)
        .eq('status', 'joined')
      if (memErr) {
        request.log.error(memErr)
        return reply.code(500).send({ error: 'Could not load communities' })
      }
      const ids = (rows ?? []).map((r) => r.community_id as string)
      if (ids.length === 0) return { communities: [], nextCursor: null }

      let query = supabaseAdmin
        .from('communities')
        .select('id, name, identifier, avatar_storage_path, avatar_updated_at')
        .in('id', ids)
        .order('identifier', { ascending: true })
        .limit(limit + 1)
      if (cursor) query = query.gt('identifier', cursor)

      const { data: communities, error } = await query
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not load communities' })
      }
      const page = (communities ?? []).slice(0, limit)
      const nextCursor =
        (communities ?? []).length > limit ? page[page.length - 1]?.identifier ?? null : null
      const urlMap = await communityAvatarUrlsForPaths(page.map((c) => c.avatar_storage_path))
      return {
        communities: page.map((c) => ({
          id: c.id,
          name: c.name,
          identifier: c.identifier,
          avatarUrl: c.avatar_storage_path
            ? urlMap.get(c.avatar_storage_path as string) ?? null
            : null,
          avatarUpdatedAt: c.avatar_updated_at,
        })),
        nextCursor,
      }
    },
  )

  app.post<{
    Params: { id: string }
    Body: { reason?: string; details?: string }
  }>('/admin/users/:id/ban', { preHandler: requireAdmin }, async (request, reply) => {
    const reason = request.body?.reason?.trim() ?? 'other'
    if (!isReportReason(reason)) {
      return reply.code(400).send({ error: 'Invalid reason' })
    }
    if (request.params.id === request.userId) {
      return reply.code(400).send({ error: 'Cannot ban yourself' })
    }
    try {
      await banUser({
        userId: request.params.id,
        reason: reason as ReportReason,
        details: request.body?.details ?? null,
      })
      return { ok: true }
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      if (status === 400) {
        return reply.code(400).send({ error: (e as Error).message })
      }
      request.log.error(e)
      return reply.code(500).send({ error: 'Could not ban user' })
    }
  })

  app.post<{ Params: { id: string } }>(
    '/admin/users/:id/unban',
    { preHandler: requireAdmin },
    async (request, reply) => {
      try {
        await unbanUser(request.params.id)
        return { ok: true }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not unban user' })
      }
    },
  )

  app.get<{ Querystring: { q?: string; limit?: string; cursor?: string } }>(
    '/admin/communities',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const q = (request.query.q ?? '').trim()
      const limit = parseLimit(request.query.limit)
      const cursor = request.query.cursor?.trim()
      if (exceedsLimit(q, TEXT_LIMITS.search)) {
        return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.search} characters` })
      }
      let query = supabaseAdmin
        .from('communities')
        .select(`${COMMUNITY_SELECT_CORE}, moderation_hidden_at`)
        .order('identifier', { ascending: true })
        .limit(limit + 1)
      if (cursor) query = query.gt('identifier', cursor)
      if (q) {
        const safe = q.replace(/[%_\\]/g, '')
        if (safe) query = query.or(`name.ilike.%${safe}%,identifier.ilike.%${safe}%`)
      }
      const { data, error } = await query
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not list communities' })
      }
      const page = (data ?? []).slice(0, limit)
      const nextCursor =
        (data ?? []).length > limit ? page[page.length - 1]?.identifier ?? null : null
      const ids = page.map((c) => c.id as string)
      const [urlMap, itemMap, counts] = await Promise.all([
        communityAvatarUrlsForPaths(page.map((c) => c.avatar_storage_path as string | null)),
        hashtagItemsForCommunityIds(ids),
        Promise.all(ids.map(async (id) => [id, await memberCount(id)] as const)),
      ])
      const countById = new Map(counts)
      return {
        communities: page.map((c) => {
          const hashtagItems = itemMap.get(c.id as string) ?? []
          return {
            id: c.id,
            name: c.name,
            identifier: c.identifier,
            description: c.description,
            joinMode: c.join_mode,
            avatarUrl: c.avatar_storage_path
              ? urlMap.get(c.avatar_storage_path as string) ?? null
              : null,
            avatarUpdatedAt: c.avatar_updated_at,
            memberCount: countById.get(c.id as string) ?? 0,
            myRoles: [] as string[],
            myStatus: null as string | null,
            createdBy: c.created_by,
            hashtags: hashtagItems.map((i) => i.slug),
            hashtagItems,
            moderationHiddenAt: c.moderation_hidden_at,
          }
        }),
        nextCursor,
      }
    },
  )

  app.post<{ Params: { id: string }; Body: { hidden?: boolean } }>(
    '/admin/communities/:id/hide',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const hidden = Boolean(request.body?.hidden)
      try {
        await setTargetHidden('community', request.params.id, hidden)
        return { ok: true }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not update community' })
      }
    },
  )

  app.get<{ Querystring: { q?: string; limit?: string; cursor?: string } }>(
    '/admin/events',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const q = (request.query.q ?? '').trim()
      const limit = parseLimit(request.query.limit)
      const cursor = request.query.cursor?.trim()
      if (exceedsLimit(q, TEXT_LIMITS.search)) {
        return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.search} characters` })
      }
      let query = supabaseAdmin
        .from('events')
        .select(EVENT_SELECT)
        .order('starts_at', { ascending: false })
        .limit(limit + 1)
      if (cursor) query = query.lt('starts_at', cursor)
      if (q) {
        const safe = q.replace(/[%_,]/g, '')
        if (safe) query = query.ilike('title', `%${safe}%`)
      }
      const { data, error } = await query
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not list events' })
      }
      const page = (data ?? []).slice(0, limit)
      const nextCursor = (data ?? []).length > limit ? page[page.length - 1]?.starts_at ?? null : null
      const events = await adminEventDtosFromRows(page as EventRow[])
      return { events, nextCursor }
    },
  )

  app.post<{ Params: { id: string }; Body: { hidden?: boolean } }>(
    '/admin/events/:id/hide',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const hidden = Boolean(request.body?.hidden)
      try {
        await setTargetHidden('event', request.params.id, hidden)
        return { ok: true }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not update event' })
      }
    },
  )

  app.post<{ Params: { id: string }; Body: { hidden?: boolean } }>(
    '/admin/messages/:id/hide',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const hidden = Boolean(request.body?.hidden)
      try {
        await setTargetHidden('message', request.params.id, hidden)
        return { ok: true }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not update message' })
      }
    },
  )

  app.get<{ Params: { kind: string; id: string } }>(
    '/admin/targets/:kind/:id/reports',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const kind = request.params.kind
      if (kind !== 'user' && kind !== 'event' && kind !== 'community' && kind !== 'message') {
        return reply.code(400).send({ error: 'Invalid kind' })
      }
      const { data, error } = await supabaseAdmin
        .from('reports')
        .select(
          'id, reporter_id, target_kind, target_id, reason, details, status, created_at, resolved_at',
        )
        .eq('target_kind', kind)
        .eq('target_id', request.params.id)
        .order('created_at', { ascending: false })
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not load reports' })
      }
      return { reports: data ?? [] }
    },
  )
}
