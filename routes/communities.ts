/**
 * Communities HTTP API: CRUD, join/leave, requests, invite, avatar, roles, channels, community conversations.
 * Layer: route. requireAuth. Mutations via supabaseAdmin.
 * Roles: `community_member_roles` via `services/roles.ts` (Phase 2).
 * Channels: `services/communityChannels.ts` (Phase 3).
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { supabaseAdmin } from '../services/supabase.js'
import { avatarUrlsForPaths } from '../services/avatars.js'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'
import {
  COMMUNITY_SELECT,
  COMMUNITY_SELECT_CORE,
  communityAvatarUrlsForPaths,
  getMembership,
  memberCount,
  type CommunityRow,
} from '../services/communities.js'
import { acceptedFriendIds } from '../services/events.js'
import { communityAllowedForViewer, globallyHiddenIds, hiddenIdsFor, messageAllowedForViewer, messageHideSets } from '../services/moderation.js'
import { lastVisibleMessagesByConversationIds } from '../services/messaging.js'
import {
  canManageCommunity,
  getCommunityRoles,
  getCommunityRolesMap,
  grantCommunityRoles,
  isCommunityAdmin,
  revokeCommunityRole,
  verifyUserPassword,
  type CommunityRole,
} from '../services/roles.js'
import {
  addUserToDefaultCommunityChannels,
  addChannelMember,
  createCustomCommunityChannel,
  createDefaultCommunityChannels,
  getChannelSettings,
  listChannelMembers,
  patchCustomChannelName,
  deleteCustomCommunityChannel,
  removeChannelMember,
  removeUserFromCommunityChannels,
  reorderCommunityChannels,
  resyncChannelsAfterRoleChange,
  setChannelRoleAccess,
} from '../services/communityChannels.js'
import {
  assertCommunityAvatarUpload,
  deleteCommunityCascade,
  saveCommunityAvatar,
  verifyFounderSetup,
} from '../services/communityRepair.js'
import { notifyUsers } from '../services/notifications/dispatcher.js'
import { communityInviteNotification } from '../services/notifications/templates.js'
import {
  createCommunityInviteLink,
  getEnabledCommunityInviteLink,
  listCommunityInviteLinks,
  joinsForCommunityInviteLinks,
  deleteCommunityInviteLink,
  recordCommunityInviteJoin,
  setCommunityInviteLinkEnabled,
} from '../services/inviteLinks.js'
import {
  attachCommunityHashtags,
  hashtagItemsForCommunityIds,
  replaceCommunityHashtags,
  type HashtagSuggestItem,
} from '../services/hashtags.js'
import { normalizeHashtagSlug } from '../lib/hashtags.js'

type CommunityDto = {
  id: string
  name: string
  identifier: string
  description: string | null
  joinMode: string
  avatarUrl: string | null
  avatarUpdatedAt: string | null
  memberCount: number
  myRoles: string[]
  myStatus: string | null
  createdBy: string
  hashtags: string[]
  hashtagItems: HashtagSuggestItem[]
}

const IDENTIFIER_RE = /^[a-zA-Z_]{1,30}$/
const ASSIGNABLE_ROLES = new Set<CommunityRole>(['manage_events', 'manage_community'])
const COMMUNITY_MAX_HASHTAGS = 5

function parseCommunityHashtagInput(raw: unknown): { slugs: string[]; error?: string } {
  const hashtagInput = Array.isArray(raw) ? raw : []
  if (hashtagInput.length > COMMUNITY_MAX_HASHTAGS) {
    return { slugs: [], error: `At most ${COMMUNITY_MAX_HASHTAGS} hashtags` }
  }
  const slugs: string[] = []
  for (const item of hashtagInput) {
    if (typeof item !== 'string' || !normalizeHashtagSlug(item)) {
      return { slugs: [], error: 'Invalid hashtag' }
    }
    slugs.push(item)
  }
  return { slugs }
}

function parseHashtagsField(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function toDto(
  row: CommunityRow,
  userId: string,
  extras?: {
    avatarUrl?: string | null
    count?: number
    membership?: { status: string } | null
    roles?: string[]
    hashtags?: string[]
    hashtagItems?: HashtagSuggestItem[]
  },
): Promise<CommunityDto> {
  const membership = extras?.membership !== undefined
    ? extras.membership
    : await getMembership(row.id, userId)
  const count = extras?.count ?? await memberCount(row.id)
  let avatarUrl = extras?.avatarUrl ?? null
  if (avatarUrl === null && row.avatar_storage_path && extras?.avatarUrl === undefined) {
    const map = await communityAvatarUrlsForPaths([row.avatar_storage_path])
    avatarUrl = map.get(row.avatar_storage_path) ?? null
  }

  let myRoles: string[] = []
  if (membership?.status === 'joined') {
    myRoles = extras?.roles ?? await getCommunityRoles(row.id, userId)
  }

  let hashtagItems = extras?.hashtagItems
  if (!hashtagItems) {
    const map = await hashtagItemsForCommunityIds([row.id])
    hashtagItems = map.get(row.id) ?? []
  }
  const hashtags = extras?.hashtags ?? hashtagItems.map((i) => i.slug)

  return {
    id: row.id,
    name: row.name,
    identifier: row.identifier,
    description: row.description,
    joinMode: row.join_mode,
    avatarUrl,
    avatarUpdatedAt: row.avatar_updated_at,
    memberCount: count,
    myRoles,
    myStatus: membership?.status ?? null,
    createdBy: row.created_by,
    hashtags,
    hashtagItems,
  }
}

async function resolveUserEmail(userId: string, fromToken: string | null): Promise<string | null> {
  if (fromToken?.trim()) return fromToken.trim()
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId)
  if (error || !data.user?.email) return null
  return data.user.email
}

export async function communityRoutes(app: FastifyInstance) {
  /** POST /communities — create (JSON or multipart with optional avatar) */
  app.post<{
    Body: {
      name?: string
      identifier?: string
      description?: string | null
      joinMode?: string
      hashtags?: string[]
    }
  }>('/communities', { preHandler: requireAuth }, async (request, reply) => {
    let name = ''
    let identifier = ''
    let description: string | null = null
    let joinMode = 'public'
    let avatarBuffer: Buffer | null = null
    let hashtagRaw: unknown = request.body?.hashtags

    if (request.isMultipart()) {
      const parts = request.parts()
      for await (const part of parts) {
        if (part.type === 'file') {
          if (part.fieldname === 'avatar') {
            const chunks: Buffer[] = []
            for await (const chunk of part.file) chunks.push(chunk)
            avatarBuffer = Buffer.concat(chunks)
          }
        } else {
          const val = String(part.value ?? '').trim()
          if (part.fieldname === 'name') name = val
          else if (part.fieldname === 'identifier') identifier = val
          else if (part.fieldname === 'description') description = val.length > 0 ? val : null
          else if (part.fieldname === 'joinMode') joinMode = val || 'public'
          else if (part.fieldname === 'hashtags') hashtagRaw = parseHashtagsField(val)
        }
      }
    } else {
      name = request.body?.name?.trim() ?? ''
      identifier = request.body?.identifier?.trim() ?? ''
      const descRaw = request.body?.description?.trim() ?? ''
      description = descRaw.length > 0 ? descRaw : null
      joinMode = request.body?.joinMode ?? 'public'
    }

    const tags = parseCommunityHashtagInput(hashtagRaw)
    if (tags.error) return reply.code(400).send({ error: tags.error })

    if (!name) return reply.code(400).send({ error: 'Name is required' })
    if (exceedsLimit(name, TEXT_LIMITS.communityName)) {
      return reply.code(400).send({ error: `Name must be at most ${TEXT_LIMITS.communityName} characters` })
    }
    if (!identifier || !IDENTIFIER_RE.test(identifier)) {
      return reply.code(400).send({ error: 'Identifier must be 1-30 letters/underscores' })
    }
    if (description && exceedsLimit(description, TEXT_LIMITS.communityDescription)) {
      return reply.code(400).send({ error: `Description must be at most ${TEXT_LIMITS.communityDescription} characters` })
    }
    if (!['public', 'invite_visible', 'invite_hidden'].includes(joinMode)) {
      return reply.code(400).send({ error: 'Invalid join mode' })
    }

    const { data: existing } = await supabaseAdmin
      .from('communities')
      .select('id')
      .ilike('identifier', identifier)
      .maybeSingle()
    if (existing) {
      return reply.code(409).send({ error: 'Identifier already taken' })
    }

    const { data: row, error } = await supabaseAdmin
      .from('communities')
      .insert({
        name,
        identifier,
        description,
        join_mode: joinMode,
        created_by: request.userId,
      })
      .select(COMMUNITY_SELECT)
      .single()
    if (error || !row) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not create community' })
    }

    const communityId = row.id as string
    const founderRoles: CommunityRole[] = ['admin', 'manage_events', 'manage_community']

    const failCreate = async (message: string, err?: unknown) => {
      if (err) request.log.error(err)
      await deleteCommunityCascade(communityId)
      return reply.code(500).send({ error: message })
    }

    const { error: memErr } = await supabaseAdmin.from('community_members').insert({
      community_id: communityId,
      user_id: request.userId,
      status: 'joined',
    })
    if (memErr) return failCreate('Could not create community', memErr)

    try {
      await grantCommunityRoles(communityId, request.userId, founderRoles)
    } catch (e) {
      return failCreate('Could not assign founder roles', e)
    }

    try {
      await createDefaultCommunityChannels(communityId, request.userId)
    } catch (e) {
      return failCreate('Could not create community channels', e)
    }

    if (!(await verifyFounderSetup(communityId, request.userId))) {
      return failCreate('Could not verify founder membership')
    }

    if (tags.slugs.length) {
      try {
        await attachCommunityHashtags(communityId, tags.slugs)
      } catch (e) {
        const statusCode = (e as { statusCode?: number }).statusCode
        if (statusCode === 400) {
          await deleteCommunityCascade(communityId)
          return reply.code(400).send({
            error: e instanceof Error ? e.message : 'Could not save hashtags',
          })
        }
        return failCreate('Could not save hashtags', e)
      }
    }

    let finalRow = row as CommunityRow
    if (avatarBuffer) {
      try {
        finalRow = await saveCommunityAvatar(communityId, avatarBuffer)
      } catch (e) {
        request.log.error(e)
      }
    }

    return reply.code(201).send(
      await toDto(finalRow, request.userId, { hashtags: tags.slugs }),
    )
  })

  /** GET /communities — joined list */
  app.get('/communities', { preHandler: requireAuth }, async (request, reply) => {
    const { data: memberships, error } = await supabaseAdmin
      .from('community_members')
      .select('community_id, status')
      .eq('user_id', request.userId)
      .eq('status', 'joined')
    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not load communities' })
    }
    if (!memberships?.length) return { communities: [] }

    const ids = memberships.map((m) => m.community_id as string)
    const { data: rows, error: cErr } = await supabaseAdmin
      .from('communities')
      .select(COMMUNITY_SELECT)
      .in('id', ids)
    if (cErr) {
      request.log.error(cErr)
      return reply.code(500).send({ error: 'Could not load communities' })
    }

    const avatarPaths = (rows ?? []).map((r) => (r as CommunityRow).avatar_storage_path)
    const avatarMap = await communityAvatarUrlsForPaths(avatarPaths)
    const memByComm = new Map(
      memberships.map((m) => [m.community_id as string, { status: m.status as string }]),
    )
    const itemMap = await hashtagItemsForCommunityIds(ids)
    const hides = await hiddenIdsFor(request.userId, 'community')

    const communities = await Promise.all(
      (rows ?? []).map(async (r) => {
        const c = r as CommunityRow
        if (!(await communityAllowedForViewer(c, request.userId, hides))) return null
        const roles = await getCommunityRoles(c.id, request.userId)
        const items = itemMap.get(c.id) ?? []
        return toDto(c, request.userId, {
          avatarUrl: c.avatar_storage_path ? avatarMap.get(c.avatar_storage_path) ?? null : null,
          membership: memByComm.get(c.id) ?? null,
          roles,
          hashtags: items.map((i) => i.slug),
          hashtagItems: items,
        })
      }),
    )
    return { communities: communities.filter((c) => c != null) }
  })

  /** GET /communities/search?q= */
  app.get<{ Querystring: { q?: string; limit?: string; cursor?: string } }>(
    '/communities/search',
    { preHandler: requireAuth },
    async (request, reply) => {
      const q = (request.query.q ?? '').trim()
      if (!q) return { communities: [] }
      if (exceedsLimit(q, TEXT_LIMITS.search)) {
        return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.search} characters` })
      }
      const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)

      const { data: joined } = await supabaseAdmin
        .from('community_members')
        .select('community_id')
        .eq('user_id', request.userId)
      const joinedIds = (joined ?? []).map((m) => m.community_id as string)

      let query = supabaseAdmin
        .from('communities')
        .select(COMMUNITY_SELECT)
        .in('join_mode', ['public', 'invite_visible'])
        .limit(limit)

      if (q.startsWith('&')) {
        const slug = q.slice(1).trim()
        if (slug) query = query.ilike('identifier', `%${slug.replace(/[%_]/g, '')}%`)
      } else {
        query = query.ilike('name', `%${q.replace(/[%_]/g, '')}%`)
      }

      const { data: rows, error } = await query
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not search communities' })
      }

      const filtered = (rows ?? []).filter((r) => !joinedIds.includes((r as CommunityRow).id)) as CommunityRow[]
      const hides = await hiddenIdsFor(request.userId, 'community')
      const visible: CommunityRow[] = []
      for (const r of filtered) {
        if (await communityAllowedForViewer(r, request.userId, hides)) visible.push(r)
      }
      const avatarPaths = visible.map((r) => r.avatar_storage_path)
      const avatarMap = await communityAvatarUrlsForPaths(avatarPaths)
      const itemMap = await hashtagItemsForCommunityIds(visible.map((r) => r.id))

      const communities = await Promise.all(
        visible.map((r) => {
          const items = itemMap.get(r.id) ?? []
          return toDto(r, request.userId, {
            avatarUrl: r.avatar_storage_path ? avatarMap.get(r.avatar_storage_path) ?? null : null,
            membership: null,
            roles: [],
            hashtags: items.map((i) => i.slug),
            hashtagItems: items,
          })
        }),
      )
      return { communities }
    },
  )

  /** GET /communities/check-identifier?identifier= — availability for create form */
  app.get<{ Querystring: { identifier?: string } }>(
    '/communities/check-identifier',
    { preHandler: requireAuth },
    async (request, reply) => {
      const identifier = request.query.identifier?.trim() ?? ''
      if (!identifier) return reply.code(400).send({ error: 'identifier required' })
      if (!IDENTIFIER_RE.test(identifier)) {
        return reply.code(400).send({ error: 'Identifier must be 1-30 letters/underscores' })
      }
      const { data: existing } = await supabaseAdmin
        .from('communities')
        .select('id')
        .ilike('identifier', identifier)
        .maybeSingle()
      return { available: !existing }
    },
  )

  /** GET /communities/suggest?q= — top 10 community identifiers by member count */
  app.get<{ Querystring: { q?: string } }>(
    '/communities/suggest',
    { preHandler: requireAuth },
    async (request, reply) => {
      const q = (request.query.q ?? '').replace(/[%_]/g, '').trim()
      if (exceedsLimit(q, TEXT_LIMITS.communityIdentifier)) {
        return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.communityIdentifier} characters` })
      }

      let query = supabaseAdmin
        .from('communities')
        .select('id, identifier')
        .in('join_mode', ['public', 'invite_visible'])
        .limit(10)

      if (q) query = query.ilike('identifier', `%${q}%`)

      const { data: rows, error } = await query
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not suggest communities' })
      }

      const identifiers: { identifier: string; memberCount: number }[] = []
      for (const r of (rows ?? []) as { id: string; identifier: string }[]) {
        const count = await memberCount(r.id)
        identifiers.push({ identifier: r.identifier, memberCount: count })
      }
      identifiers.sort((a, b) => b.memberCount - a.memberCount)

      return { identifiers }
    },
  )

  /** GET /communities/suggestions — communities friends joined */
  app.get('/communities/suggestions', { preHandler: requireAuth }, async (request, reply) => {
    let friendIds: string[]
    try {
      friendIds = await acceptedFriendIds(request.userId)
    } catch {
      return reply.code(500).send({ error: 'Could not load friends' })
    }
    if (!friendIds.length) return { communities: [] }

    const { data: friendMemberships } = await supabaseAdmin
      .from('community_members')
      .select('community_id')
      .in('user_id', friendIds)
      .eq('status', 'joined')

    const commIds = [...new Set((friendMemberships ?? []).map((m) => m.community_id as string))]
    if (!commIds.length) return { communities: [] }

    const { data: myMemberships } = await supabaseAdmin
      .from('community_members')
      .select('community_id')
      .eq('user_id', request.userId)
    const myIds = new Set((myMemberships ?? []).map((m) => m.community_id as string))
    const notJoined = commIds.filter((id) => !myIds.has(id))
    if (!notJoined.length) return { communities: [] }

    const { data: rows, error } = await supabaseAdmin
      .from('communities')
      .select(COMMUNITY_SELECT)
      .in('id', notJoined)
      .in('join_mode', ['public', 'invite_visible'])
      .limit(20)
    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not load suggestions' })
    }

    const hides = await hiddenIdsFor(request.userId, 'community')
    const visibleRows: CommunityRow[] = []
    for (const r of (rows ?? []) as CommunityRow[]) {
      if (await communityAllowedForViewer(r, request.userId, hides)) visibleRows.push(r)
    }

    const avatarPaths = visibleRows.map((r) => r.avatar_storage_path)
    const avatarMap = await communityAvatarUrlsForPaths(avatarPaths)
    const itemMap = await hashtagItemsForCommunityIds(visibleRows.map((r) => r.id))

    const communities = await Promise.all(
      visibleRows.map((c) => {
        const items = itemMap.get(c.id) ?? []
        return toDto(c, request.userId, {
          avatarUrl: c.avatar_storage_path ? avatarMap.get(c.avatar_storage_path) ?? null : null,
          membership: null,
          roles: [],
          hashtags: items.map((i) => i.slug),
          hashtagItems: items,
        })
      }),
    )
    return { communities }
  })

  /** GET /communities/recommended — top 10 visible communities the user has not joined */
  app.get('/communities/recommended', { preHandler: requireAuth }, async (request, reply) => {
    const { data: myMemberships } = await supabaseAdmin
      .from('community_members')
      .select('community_id')
      .eq('user_id', request.userId)
    const myIds = new Set((myMemberships ?? []).map((m) => m.community_id as string))

    // Cap candidates then rank by member count (no denormalized count column).
    const { data: rows, error } = await supabaseAdmin
      .from('communities')
      .select(COMMUNITY_SELECT)
      .in('join_mode', ['public', 'invite_visible'])
      .limit(200)
    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not load recommended communities' })
    }

    const candidates = ((rows ?? []) as CommunityRow[]).filter((r) => !myIds.has(r.id))
    const hides = await hiddenIdsFor(request.userId, 'community')
    const allowed: CommunityRow[] = []
    for (const r of candidates) {
      if (await communityAllowedForViewer(r, request.userId, hides)) allowed.push(r)
    }
    const withCounts = await Promise.all(
      allowed.map(async (r) => ({ row: r, count: await memberCount(r.id) })),
    )
    withCounts.sort((a, b) => b.count - a.count)
    const top = withCounts.slice(0, 10)

    const avatarPaths = top.map((t) => t.row.avatar_storage_path)
    const avatarMap = await communityAvatarUrlsForPaths(avatarPaths)
    const itemMap = await hashtagItemsForCommunityIds(top.map((t) => t.row.id))

    const communities = await Promise.all(
      top.map(({ row: c, count }) => {
        const items = itemMap.get(c.id) ?? []
        return toDto(c, request.userId, {
          avatarUrl: c.avatar_storage_path ? avatarMap.get(c.avatar_storage_path) ?? null : null,
          membership: null,
          roles: [],
          hashtags: items.map((i) => i.slug),
          hashtagItems: items,
          count,
        })
      }),
    )
    return { communities }
  })

  /** GET /communities/:id */
  app.get<{ Params: { id: string } }>(
    '/communities/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await supabaseAdmin
        .from('communities')
        .select(COMMUNITY_SELECT)
        .eq('id', request.params.id)
        .maybeSingle()
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not load community' })
      }
      if (!row) return reply.code(404).send({ error: 'Community not found' })
      const c = row as CommunityRow
      if (c.join_mode === 'invite_hidden') {
        const mem = await getMembership(c.id, request.userId)
        if (!mem) return reply.code(404).send({ error: 'Community not found' })
      }
      if (!(await communityAllowedForViewer(c, request.userId))) {
        return reply.code(404).send({ error: 'Community not found' })
      }
      return await toDto(c, request.userId)
    },
  )

  /** GET /communities/:id/members */
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>(
    '/communities/:id/members',
    { preHandler: requireAuth },
    async (request, reply) => {
      const mem = await getMembership(request.params.id, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not a member' })
      }
      const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)
      const cursor = request.query.cursor?.trim()

      let query = supabaseAdmin
        .from('community_members')
        .select('user_id, status, joined_at')
        .eq('community_id', request.params.id)
        .eq('status', 'joined')
        .order('user_id', { ascending: true })
        .limit(limit + 1)
      if (cursor) query = query.gt('user_id', cursor)

      const { data: rows, error } = await query
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not list members' })
      }
      const page = rows ?? []
      const extra = page.length > limit
      const slice = extra ? page.slice(0, limit) : page
      const ids = slice.map((r) => r.user_id as string)
      if (!ids.length) return { members: [], nextCursor: null }

      const { data: profiles } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, username, avatar_storage_path, avatar_updated_at')
        .in('id', ids)
      const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]))
      const urls = await avatarUrlsForPaths(
        (profiles ?? []).map((p) => (p.avatar_storage_path as string | null) ?? null),
      )
      const rolesMap = await getCommunityRolesMap(request.params.id, ids)

      const members = ids.map((id) => {
        const p = byId.get(id)
        const path = (p?.avatar_storage_path as string | null) ?? null
        return {
          userId: id,
          fullName: (p?.full_name as string | null) ?? null,
          username: (p?.username as string | null) ?? null,
          avatarUrl: path ? urls.get(path) ?? null : null,
          avatarUpdatedAt: (p?.avatar_updated_at as string | null) ?? null,
          roles: rolesMap.get(id) ?? [],
        }
      })
      return { members, nextCursor: extra ? ids[ids.length - 1] ?? null : null }
    },
  )

  /** PATCH /communities/:id — admin edit */
  app.patch<{
    Params: { id: string }
    Body: { name?: string; description?: string | null; joinMode?: string; hashtags?: string[] }
  }>('/communities/:id', { preHandler: requireAuth }, async (request, reply) => {
    const mem = await getMembership(request.params.id, request.userId)
    if (!mem || mem.status !== 'joined') {
      return reply.code(403).send({ error: 'Admin only' })
    }
    if (!(await isCommunityAdmin(request.params.id, request.userId))) {
      return reply.code(403).send({ error: 'Admin only' })
    }

    const name = request.body?.name?.trim() ?? ''
    const descRaw = request.body?.description?.trim() ?? ''
    const description = descRaw.length > 0 ? descRaw : null
    const joinMode = request.body?.joinMode

    if (!name) return reply.code(400).send({ error: 'Name is required' })
    if (exceedsLimit(name, TEXT_LIMITS.communityName)) {
      return reply.code(400).send({ error: `Name must be at most ${TEXT_LIMITS.communityName} characters` })
    }
    if (description && exceedsLimit(description, TEXT_LIMITS.communityDescription)) {
      return reply.code(400).send({ error: `Description must be at most ${TEXT_LIMITS.communityDescription} characters` })
    }
    if (joinMode && !['public', 'invite_visible', 'invite_hidden'].includes(joinMode)) {
      return reply.code(400).send({ error: 'Invalid join mode' })
    }

    const tags = request.body?.hashtags !== undefined
      ? parseCommunityHashtagInput(request.body.hashtags)
      : null
    if (tags?.error) return reply.code(400).send({ error: tags.error })

    const update: Record<string, unknown> = { name, description }
    if (joinMode) update.join_mode = joinMode

    const { data: row, error } = await supabaseAdmin
      .from('communities')
      .update(update)
      .eq('id', request.params.id)
      .select(COMMUNITY_SELECT)
      .single()
    if (error || !row) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not update community' })
    }

    if (tags) {
      try {
        await replaceCommunityHashtags(request.params.id, tags.slugs)
      } catch (e) {
        const statusCode = (e as { statusCode?: number }).statusCode
        return reply.code(statusCode === 400 ? 400 : 500).send({
          error: e instanceof Error ? e.message : 'Could not save hashtags',
        })
      }
    }

    const dtoExtras = tags ? { hashtags: tags.slugs } : undefined
    return await toDto(row as CommunityRow, request.userId, dtoExtras)
  })

  /** DELETE /communities/:id — admin */
  app.delete<{ Params: { id: string } }>(
    '/communities/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const mem = await getMembership(request.params.id, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Admin only' })
      }
      if (!(await isCommunityAdmin(request.params.id, request.userId))) {
        return reply.code(403).send({ error: 'Admin only' })
      }
      const { error } = await supabaseAdmin
        .from('communities')
        .delete()
        .eq('id', request.params.id)
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not delete community' })
      }
      return { ok: true }
    },
  )

  /** POST /communities/:id/join */
  app.post<{ Params: { id: string } }>(
    '/communities/:id/join',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row } = await supabaseAdmin
        .from('communities')
        .select(COMMUNITY_SELECT)
        .eq('id', request.params.id)
        .maybeSingle()
      if (!row) return reply.code(404).send({ error: 'Community not found' })
      const c = row as CommunityRow

      const existing = await getMembership(c.id, request.userId)
      if (existing?.status === 'joined') {
        return await toDto(c, request.userId, { membership: { status: existing.status } })
      }

      /** Accept a manager invite (any join_mode). */
      if (existing?.status === 'invited') {
        const { error } = await supabaseAdmin
          .from('community_members')
          .update({ status: 'joined' })
          .eq('community_id', c.id)
          .eq('user_id', request.userId)
        if (error) {
          request.log.error(error)
          return reply.code(500).send({ error: 'Could not join' })
        }
        try {
          await addUserToDefaultCommunityChannels(c.id, request.userId)
        } catch (e) {
          request.log.error(e)
          return reply.code(500).send({ error: 'Could not join channels' })
        }
        return await toDto(c, request.userId, { membership: { status: 'joined' }, roles: [] })
      }

      if (c.join_mode === 'public') {
        const { error } = await supabaseAdmin.from('community_members').upsert(
          { community_id: c.id, user_id: request.userId, status: 'joined' },
          { onConflict: 'community_id,user_id' },
        )
        if (error) {
          request.log.error(error)
          return reply.code(500).send({ error: 'Could not join' })
        }
        try {
          await addUserToDefaultCommunityChannels(c.id, request.userId)
        } catch (e) {
          request.log.error(e)
          return reply.code(500).send({ error: 'Could not join channels' })
        }
        return await toDto(c, request.userId, { membership: { status: 'joined' }, roles: [] })
      }

      if (existing?.status === 'requested') {
        return reply.code(400).send({ error: 'Join request already pending' })
      }
      const { error } = await supabaseAdmin.from('community_members').insert({
        community_id: c.id,
        user_id: request.userId,
        status: 'requested',
      })
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not request to join' })
      }
      return await toDto(c, request.userId, { membership: { status: 'requested' }, roles: [] })
    },
  )

  /** POST /communities/:id/leave */
  app.post<{ Params: { id: string } }>(
    '/communities/:id/leave',
    { preHandler: requireAuth },
    async (request, reply) => {
      const mem = await getMembership(request.params.id, request.userId)
      if (!mem) return reply.code(400).send({ error: 'Not a member' })
      if (await isCommunityAdmin(request.params.id, request.userId)) {
        return reply.code(400).send({ error: 'Admin cannot leave. Transfer ownership first.' })
      }
      const { error } = await supabaseAdmin
        .from('community_members')
        .delete()
        .eq('community_id', request.params.id)
        .eq('user_id', request.userId)
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not leave' })
      }
      try {
        await removeUserFromCommunityChannels(request.params.id, request.userId)
      } catch (e) {
        request.log.error(e)
      }
      return { ok: true }
    },
  )

  /** GET /communities/:id/requests — manage_community: pending join requests */
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>(
    '/communities/:id/requests',
    { preHandler: requireAuth },
    async (request, reply) => {
      const mem = await getMembership(request.params.id, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(request.params.id, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)
      const cursor = request.query.cursor?.trim()

      let query = supabaseAdmin
        .from('community_members')
        .select('user_id, joined_at, invited_by')
        .eq('community_id', request.params.id)
        .eq('status', 'requested')
        .order('user_id', { ascending: true })
        .limit(limit + 1)
      if (cursor) query = query.gt('user_id', cursor)

      const { data: rows, error } = await query
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not list requests' })
      }
      const page = rows ?? []
      const extra = page.length > limit
      const slice = extra ? page.slice(0, limit) : page
      const ids = slice.map((r) => r.user_id as string)
      if (!ids.length) return { requests: [], nextCursor: null }

      const sponsorIds = [
        ...new Set(
          slice
            .map((r) => (r.invited_by as string | null) ?? null)
            .filter((id): id is string => Boolean(id)),
        ),
      ]
      const profileIds = [...new Set([...ids, ...sponsorIds])]

      const { data: profiles } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, username, avatar_storage_path, avatar_updated_at')
        .in('id', profileIds)
      const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]))
      const urls = await avatarUrlsForPaths(
        (profiles ?? []).map((p) => (p.avatar_storage_path as string | null) ?? null),
      )

      const requests = slice.map((row) => {
        const id = row.user_id as string
        const p = byId.get(id)
        const path = (p?.avatar_storage_path as string | null) ?? null
        const sponsorId = (row.invited_by as string | null) ?? null
        const sponsor = sponsorId ? byId.get(sponsorId) : undefined
        return {
          userId: id,
          fullName: (p?.full_name as string | null) ?? null,
          username: (p?.username as string | null) ?? null,
          avatarUrl: path ? urls.get(path) ?? null : null,
          avatarUpdatedAt: (p?.avatar_updated_at as string | null) ?? null,
          invitedBy: sponsorId
            ? {
                userId: sponsorId,
                fullName: (sponsor?.full_name as string | null) ?? null,
                username: (sponsor?.username as string | null) ?? null,
              }
            : null,
        }
      })
      return { requests, nextCursor: extra ? ids[ids.length - 1] ?? null : null }
    },
  )

  /** POST /communities/:id/requests/:userId/approve */
  app.post<{ Params: { id: string; userId: string } }>(
    '/communities/:id/requests/:userId/approve',
    { preHandler: requireAuth },
    async (request, reply) => {
      const mem = await getMembership(request.params.id, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(request.params.id, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const { error } = await supabaseAdmin
        .from('community_members')
        .update({ status: 'joined' })
        .eq('community_id', request.params.id)
        .eq('user_id', request.params.userId)
        .eq('status', 'requested')
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not approve' })
      }
      try {
        await addUserToDefaultCommunityChannels(request.params.id, request.params.userId)
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not add to channels' })
      }
      return { ok: true }
    },
  )

  /** POST /communities/:id/requests/:userId/reject */
  app.post<{ Params: { id: string; userId: string } }>(
    '/communities/:id/requests/:userId/reject',
    { preHandler: requireAuth },
    async (request, reply) => {
      const mem = await getMembership(request.params.id, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(request.params.id, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const { error } = await supabaseAdmin
        .from('community_members')
        .delete()
        .eq('community_id', request.params.id)
        .eq('user_id', request.params.userId)
        .eq('status', 'requested')
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not reject' })
      }
      return { ok: true }
    },
  )

  /** POST /communities/:id/invite — joined member invites a friend (direct or request). */
  app.post<{ Params: { id: string }; Body: { userId?: string } }>(
    '/communities/:id/invite',
    { preHandler: requireAuth },
    async (request, reply) => {
      const mem = await getMembership(request.params.id, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const targetId = request.body?.userId?.trim()
      if (!targetId) return reply.code(400).send({ error: 'userId required' })
      if (targetId === request.userId) {
        return reply.code(400).send({ error: 'Cannot invite yourself' })
      }

      const friendIds = await acceptedFriendIds(request.userId)
      if (!friendIds.includes(targetId)) {
        return reply.code(400).send({ error: 'Can only invite accepted friends' })
      }

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('id', targetId)
        .maybeSingle()
      if (!profile) return reply.code(404).send({ error: 'User not found' })

      const { data: community } = await supabaseAdmin
        .from('communities')
        .select('name, join_mode')
        .eq('id', request.params.id)
        .maybeSingle()
      if (!community) return reply.code(404).send({ error: 'Community not found' })

      const existing = await getMembership(request.params.id, targetId)
      if (existing?.status === 'joined') {
        return { ok: true, alreadyMember: true }
      }

      const canDirect =
        community.join_mode === 'public' ||
        (await canManageCommunity(request.params.id, request.userId))

      if (!canDirect) {
        if (existing?.status === 'invited') {
          return { ok: true }
        }
        if (existing?.status === 'requested') {
          return reply.code(400).send({ error: 'Join request already pending' })
        }
        const { error } = await supabaseAdmin.from('community_members').insert({
          community_id: request.params.id,
          user_id: targetId,
          status: 'requested',
          invited_by: request.userId,
        })
        if (error) {
          request.log.error(error)
          return reply.code(500).send({ error: 'Could not request invite' })
        }
        return { ok: true, requested: true }
      }

      const { error } = await supabaseAdmin.from('community_members').upsert(
        {
          community_id: request.params.id,
          user_id: targetId,
          status: 'invited',
          invited_by: request.userId,
        },
        { onConflict: 'community_id,user_id' },
      )
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not invite' })
      }

      const { data: inviter } = await supabaseAdmin
        .from('profiles')
        .select('full_name')
        .eq('id', request.userId)
        .maybeSingle()

      void notifyUsers(
        [targetId],
        communityInviteNotification({
          inviterName: inviter?.full_name ?? 'Someone',
          communityName: community.name ?? 'a community',
          communityId: request.params.id,
        }),
        { excludeUserId: request.userId, log: request.log },
      )

      return { ok: true }
    },
  )

  /** POST /communities/:id/roles — admin grant/revoke manage_events | manage_community */
  app.post<{
    Params: { id: string }
    Body: { userId?: string; role?: string; action?: 'grant' | 'revoke' }
  }>('/communities/:id/roles', { preHandler: requireAuth }, async (request, reply) => {
    const communityId = request.params.id
    const mem = await getMembership(communityId, request.userId)
    if (!mem || mem.status !== 'joined') {
      return reply.code(403).send({ error: 'Admin only' })
    }
    if (!(await isCommunityAdmin(communityId, request.userId))) {
      return reply.code(403).send({ error: 'Admin only' })
    }

    const targetUserId = request.body?.userId?.trim()
    const role = request.body?.role?.trim()
    const action = request.body?.action
    if (!targetUserId) return reply.code(400).send({ error: 'userId required' })
    if (!role || !ASSIGNABLE_ROLES.has(role as CommunityRole)) {
      return reply.code(400).send({ error: 'role must be manage_events or manage_community' })
    }
    if (action !== 'grant' && action !== 'revoke') {
      return reply.code(400).send({ error: "action must be 'grant' or 'revoke'" })
    }
    if (role === 'admin') {
      return reply.code(400).send({ error: 'Use transfer-admin to change admin' })
    }

    const targetMem = await getMembership(communityId, targetUserId)
    if (!targetMem || targetMem.status !== 'joined') {
      return reply.code(400).send({ error: 'Target must be a joined member' })
    }

    try {
      if (action === 'grant') {
        await grantCommunityRoles(communityId, targetUserId, [role as CommunityRole])
      } else {
        await revokeCommunityRole(communityId, targetUserId, role as CommunityRole)
      }
      try {
        await resyncChannelsAfterRoleChange(communityId, targetUserId)
      } catch (e) {
        request.log.error(e)
      }
    } catch (e) {
      request.log.error(e)
      return reply.code(500).send({ error: 'Could not update roles' })
    }
    return { ok: true, roles: await getCommunityRoles(communityId, targetUserId) }
  })

  /** POST /communities/:id/transfer-admin — admin only; email + password re-auth */
  app.post<{
    Params: { id: string }
    Body: { targetUserId?: string; email?: string; password?: string }
  }>('/communities/:id/transfer-admin', { preHandler: requireAuth }, async (request, reply) => {
    const communityId = request.params.id
    const mem = await getMembership(communityId, request.userId)
    if (!mem || mem.status !== 'joined') {
      return reply.code(403).send({ error: 'Admin only' })
    }
    if (!(await isCommunityAdmin(communityId, request.userId))) {
      return reply.code(403).send({ error: 'Admin only' })
    }

    const targetUserId = request.body?.targetUserId?.trim()
    const emailInput = request.body?.email?.trim() ?? ''
    const password = request.body?.password ?? ''
    if (!targetUserId) return reply.code(400).send({ error: 'targetUserId required' })
    if (!emailInput) return reply.code(400).send({ error: 'email required' })
    if (!password) return reply.code(400).send({ error: 'password required' })
    if (exceedsLimit(emailInput, TEXT_LIMITS.email)) {
      return reply.code(400).send({ error: `Email must be at most ${TEXT_LIMITS.email} characters` })
    }
    if (exceedsLimit(password, TEXT_LIMITS.password)) {
      return reply.code(400).send({ error: `Password must be at most ${TEXT_LIMITS.password} characters` })
    }
    if (targetUserId === request.userId) {
      return reply.code(400).send({ error: 'Cannot transfer admin to yourself' })
    }

    const targetMem = await getMembership(communityId, targetUserId)
    if (!targetMem || targetMem.status !== 'joined') {
      return reply.code(400).send({ error: 'Target must be a joined member' })
    }

    const email = await resolveUserEmail(request.userId, request.userEmail)
    if (!email) {
      return reply.code(400).send({ error: 'Could not verify account email' })
    }
    if (email.toLowerCase() !== emailInput.toLowerCase()) {
      return reply.code(401).send({ error: 'Invalid email or password' })
    }
    const passwordOk = await verifyUserPassword(email, password)
    if (!passwordOk) {
      return reply.code(401).send({ error: 'Invalid email or password' })
    }

    try {
      // Unique one-admin index: revoke before grant
      await revokeCommunityRole(communityId, request.userId, 'admin')
      await grantCommunityRoles(communityId, targetUserId, ['admin'])
    } catch (e) {
      request.log.error(e)
      // Best-effort restore if grant failed after revoke
      try {
        await grantCommunityRoles(communityId, request.userId, ['admin'])
      } catch (restoreErr) {
        request.log.error(restoreErr)
      }
      return reply.code(500).send({ error: 'Could not transfer admin' })
    }
    return { ok: true }
  })

  /** POST /communities/:id/kick — manage_community; cannot kick admin */
  app.post<{
    Params: { id: string }
    Body: { userId?: string }
  }>('/communities/:id/kick', { preHandler: requireAuth }, async (request, reply) => {
    const communityId = request.params.id
    const mem = await getMembership(communityId, request.userId)
    if (!mem || mem.status !== 'joined') {
      return reply.code(403).send({ error: 'Not allowed' })
    }
    if (!(await canManageCommunity(communityId, request.userId))) {
      return reply.code(403).send({ error: 'Not allowed' })
    }

    const targetUserId = request.body?.userId?.trim()
    if (!targetUserId) return reply.code(400).send({ error: 'userId required' })
    if (targetUserId === request.userId) {
      return reply.code(400).send({ error: 'Cannot kick yourself; leave instead' })
    }

    const targetMem = await getMembership(communityId, targetUserId)
    if (!targetMem || targetMem.status !== 'joined') {
      return reply.code(400).send({ error: 'User is not a joined member' })
    }
    if (await isCommunityAdmin(communityId, targetUserId)) {
      return reply.code(400).send({ error: 'Cannot kick the community admin' })
    }

    const { error } = await supabaseAdmin
      .from('community_members')
      .delete()
      .eq('community_id', communityId)
      .eq('user_id', targetUserId)
    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not kick member' })
    }
    try {
      await removeUserFromCommunityChannels(communityId, targetUserId)
    } catch (e) {
      request.log.error(e)
    }
    return { ok: true }
  })

  /**
   * GET /communities/:id/conversations — community channels + community event chats.
   * Channels only when joined. kind: all|channels|events. archived 0|1.
   */
  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; cursor?: string; q?: string; archived?: string; kind?: string }
  }>('/communities/:id/conversations', { preHandler: requireAuth }, async (request, reply) => {
    const communityId = request.params.id
    const { data: community } = await supabaseAdmin
      .from('communities')
      .select(COMMUNITY_SELECT)
      .eq('id', communityId)
      .maybeSingle()
    if (!community) return reply.code(404).send({ error: 'Community not found' })
    const c = community as CommunityRow
    const mem = await getMembership(communityId, request.userId)
    if (c.join_mode === 'invite_hidden' && (!mem || mem.status !== 'joined')) {
      return reply.code(404).send({ error: 'Community not found' })
    }

    const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)
    const cursor = request.query.cursor?.trim()
    const q = (request.query.q ?? '').trim().toLowerCase()
    const archivedWanted =
      request.query.archived === '1' || request.query.archived === 'true'
    const kindRaw = (request.query.kind ?? 'all').trim().toLowerCase()
    const kind =
      kindRaw === 'channels' || kindRaw === 'events' ? kindRaw : 'all'
    if (exceedsLimit(q, TEXT_LIMITS.search)) {
      return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.search} characters` })
    }

    type Item = {
      conversation_id: string
      last_read_at: string | null
      updated_at: string
      archived_at: string | null
      type: string
      name: string
      channelKind: string | null
      eventId: string | null
      position: number | null
    }
    const items: Item[] = []

    if (mem?.status === 'joined' && kind !== 'events') {
      const { data: channels } = await supabaseAdmin
        .from('community_conversations')
        .select(
          'conversation_id, name, kind, position, conversations ( id, type, archived_at, updated_at )',
        )
        .eq('community_id', communityId)
        .order('position', { ascending: true })

      for (const ch of channels ?? []) {
        const raw = ch.conversations as
          | { id: string; type: string; archived_at: string | null; updated_at: string }
          | { id: string; type: string; archived_at: string | null; updated_at: string }[]
          | null
        const conv = Array.isArray(raw) ? raw[0] ?? null : raw
        if (!conv) continue
        const { data: membership } = await supabaseAdmin
          .from('conversation_members')
          .select('last_read_at')
          .eq('conversation_id', conv.id)
          .eq('user_id', request.userId)
          .maybeSingle()
        if (!membership) continue
        items.push({
          conversation_id: conv.id,
          last_read_at: (membership.last_read_at as string | null) ?? null,
          updated_at: conv.updated_at,
          archived_at: conv.archived_at,
          type: 'community',
          name: ch.name as string,
          channelKind: ch.kind as string,
          eventId: null,
          position: ch.position as number,
        })
      }
    }

    if (kind !== 'channels') {
      let evQuery = supabaseAdmin
        .from('events')
        .select(
          'id, title, conversation_id, visibility, conversations ( id, type, archived_at, updated_at )',
        )
        .eq('organizer_community_id', communityId)
      if (mem?.status !== 'joined') {
        evQuery = evQuery.eq('visibility', 'public')
      }
      const { data: events } = await evQuery
      for (const ev of events ?? []) {
        const raw = ev.conversations as
          | { id: string; type: string; archived_at: string | null; updated_at: string }
          | { id: string; type: string; archived_at: string | null; updated_at: string }[]
          | null
        const conv = Array.isArray(raw) ? raw[0] ?? null : raw
        if (!conv) continue
        const { data: membership } = await supabaseAdmin
          .from('conversation_members')
          .select('last_read_at')
          .eq('conversation_id', conv.id)
          .eq('user_id', request.userId)
          .maybeSingle()
        if (!membership) continue
        items.push({
          conversation_id: conv.id,
          last_read_at: (membership.last_read_at as string | null) ?? null,
          updated_at: conv.updated_at,
          archived_at: conv.archived_at,
          type: 'event',
          name: ev.title as string,
          channelKind: null,
          eventId: ev.id as string,
          position: null,
        })
      }
    }

    let filtered = items.filter((i) => Boolean(i.archived_at) === archivedWanted)
    // Channels: stable shared position. Events (archived mix): activity order.
    if (kind === 'channels') {
      filtered.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    } else if (kind === 'events') {
      filtered.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1))
    } else {
      filtered.sort((a, b) => {
        if (a.type === 'community' && b.type === 'community') {
          return (a.position ?? 0) - (b.position ?? 0)
        }
        if (a.type === 'community') return -1
        if (b.type === 'community') return 1
        return b.updated_at > a.updated_at ? 1 : -1
      })
    }
    if (cursor && kind !== 'channels') {
      filtered = filtered.filter((i) => i.updated_at < cursor)
    }
    if (q) filtered = filtered.filter((i) => i.name.toLowerCase().includes(q))

    const conversationIds = filtered.map((i) => i.conversation_id)
    if (!conversationIds.length) {
      return { conversations: [], nextCursor: null }
    }

    const lastByConv = await lastVisibleMessagesByConversationIds(
      conversationIds,
      request.userId,
      (err, ctx) => request.log.warn({ err }, ctx),
    )

    const { data: recentMessages, error: recentErr } = await supabaseAdmin
      .from('messages')
      .select('id, conversation_id, body, created_at, sender_id, deleted_at, moderation_hidden_at')
      .in('conversation_id', conversationIds)
      .order('created_at', { ascending: false })
      .limit(1000)
    if (recentErr) {
      request.log.warn({ err: recentErr }, 'recent messages for unread')
    }

    const hideSets = await messageHideSets(request.userId)
    const unreadByConv = new Map<string, number>()
    const lastReadByConv = new Map(filtered.map((i) => [i.conversation_id, i.last_read_at]))
    for (const msg of recentMessages ?? []) {
      if (
        !messageAllowedForViewer(msg, request.userId, hideSets.personal, hideSets.global)
      ) {
        continue
      }
      if (msg.deleted_at) continue
      if (msg.sender_id === request.userId) continue
      const lastRead = lastReadByConv.get(msg.conversation_id)
      if (!lastRead || msg.created_at > lastRead) {
        unreadByConv.set(
          msg.conversation_id,
          (unreadByConv.get(msg.conversation_id) ?? 0) + 1,
        )
      }
    }

    const results = filtered.map((i) => {
      const last = lastByConv.get(i.conversation_id)
      return {
        id: i.conversation_id,
        type: i.type,
        name: i.name,
        channelKind: i.channelKind,
        eventId: i.eventId,
        communityId,
        position: i.position,
        archived_at: i.archived_at,
        updated_at: i.updated_at,
        lastReadAt: i.last_read_at,
        unreadCount: unreadByConv.get(i.conversation_id) ?? 0,
        lastMessage: last
          ? {
              body: last.deleted_at ? null : last.body,
              created_at: last.created_at,
              sender_id: last.sender_id,
            }
          : null,
      }
    })

    const page = results.slice(0, limit)
    const nextCursor =
      kind === 'channels'
        ? null
        : results.length > limit
          ? page[page.length - 1]?.updated_at ?? null
          : null
    return { conversations: page, nextCursor }
  })

  /** POST /communities/:id/channels — admin / manage_community create custom channel */
  app.post<{
    Params: { id: string }
    Body: { name?: string; roleAccess?: string[]; memberIds?: string[] }
  }>(
    '/communities/:id/channels',
    { preHandler: requireAuth },
    async (request, reply) => {
      const communityId = request.params.id
      const mem = await getMembership(communityId, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(communityId, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const name = request.body?.name?.trim() ?? ''
      if (!name) return reply.code(400).send({ error: 'Name is required' })
      if (exceedsLimit(name, TEXT_LIMITS.communityChannelName)) {
        return reply.code(400).send({
          error: `Name must be at most ${TEXT_LIMITS.communityChannelName} characters`,
        })
      }
      const roleAccess = (request.body?.roleAccess ?? []).filter(
        (r): r is CommunityRole =>
          r === 'admin' || r === 'manage_events' || r === 'manage_community',
      )
      const memberIds = Array.isArray(request.body?.memberIds)
        ? request.body.memberIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
        : []
      try {
        const row = await createCustomCommunityChannel({
          communityId,
          name,
          creatorUserId: request.userId,
          roleAccess,
          memberIds,
        })
        return reply.code(201).send({
          id: row.conversation_id,
          type: 'community',
          name: row.name,
          channelKind: row.kind,
          communityId,
          writeMode: row.write_mode,
          position: row.position,
        })
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not create chat' })
      }
    },
  )

  /** PUT /communities/:id/channels/order — shared position for all members */
  app.put<{ Params: { id: string }; Body: { conversationIds?: string[] } }>(
    '/communities/:id/channels/order',
    { preHandler: requireAuth },
    async (request, reply) => {
      const communityId = request.params.id
      const mem = await getMembership(communityId, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(communityId, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const conversationIds = Array.isArray(request.body?.conversationIds)
        ? request.body.conversationIds.filter((id): id is string => typeof id === 'string')
        : []
      if (!conversationIds.length) {
        return reply.code(400).send({ error: 'conversationIds required' })
      }
      try {
        await reorderCommunityChannels(communityId, conversationIds)
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not reorder channels'
        if (
          msg.includes('Unknown') ||
          msg.includes('Duplicate')
        ) {
          return reply.code(400).send({ error: msg })
        }
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not reorder channels' })
      }
    },
  )

  /** GET /communities/:id/channels/:conversationId — channel settings meta */
  app.get<{ Params: { id: string; conversationId: string } }>(
    '/communities/:id/channels/:conversationId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const communityId = request.params.id
      const conversationId = request.params.conversationId
      const mem = await getMembership(communityId, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(communityId, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      try {
        const settings = await getChannelSettings(communityId, conversationId)
        if (!settings) return reply.code(404).send({ error: 'Channel not found' })
        return settings
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not load channel' })
      }
    },
  )

  /** PATCH /communities/:id/channels/:conversationId — rename custom channel */
  app.patch<{ Params: { id: string; conversationId: string }; Body: { name?: string } }>(
    '/communities/:id/channels/:conversationId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const communityId = request.params.id
      const conversationId = request.params.conversationId
      const mem = await getMembership(communityId, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(communityId, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const name = request.body?.name?.trim() ?? ''
      if (!name) return reply.code(400).send({ error: 'Name is required' })
      if (exceedsLimit(name, TEXT_LIMITS.communityChannelName)) {
        return reply.code(400).send({
          error: `Name must be at most ${TEXT_LIMITS.communityChannelName} characters`,
        })
      }
      try {
        const updated = await patchCustomChannelName(communityId, conversationId, name)
        return { name: updated }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not rename channel'
        const code = msg === 'Channel not found' || msg.includes('Only custom') ? 404 : 500
        if (code === 500) request.log.error(e)
        return reply.code(code).send({ error: msg })
      }
    },
  )

  /** DELETE /communities/:id/channels/:conversationId — custom only */
  app.delete<{ Params: { id: string; conversationId: string } }>(
    '/communities/:id/channels/:conversationId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const communityId = request.params.id
      const conversationId = request.params.conversationId
      const mem = await getMembership(communityId, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(communityId, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      try {
        await deleteCustomCommunityChannel(communityId, conversationId)
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not delete channel'
        const status = (e as { statusCode?: number }).statusCode
        const code =
          status ??
          (msg === 'Channel not found'
            ? 404
            : msg.includes('cannot be deleted')
              ? 403
              : msg.includes('still has events')
                ? 400
                : 500)
        if (code === 500) request.log.error(e)
        return reply.code(code).send({ error: msg })
      }
    },
  )

  /** GET /communities/:id/channels/:conversationId/members — any joined member (mutations stay manage-only) */
  app.get<{
    Params: { id: string; conversationId: string }
    Querystring: { limit?: string; cursor?: string }
  }>(
    '/communities/:id/channels/:conversationId/members',
    { preHandler: requireAuth },
    async (request, reply) => {
      const communityId = request.params.id
      const conversationId = request.params.conversationId
      const mem = await getMembership(communityId, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)
      const cursor = request.query.cursor?.trim()
      try {
        return await listChannelMembers(communityId, conversationId, limit, cursor)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not list members'
        const code = msg === 'Channel not found' ? 404 : 500
        if (code === 500) request.log.error(e)
        return reply.code(code).send({ error: msg })
      }
    },
  )

  /** POST /communities/:id/channels/:conversationId/members */
  app.post<{
    Params: { id: string; conversationId: string }
    Body: { userId?: string }
  }>(
    '/communities/:id/channels/:conversationId/members',
    { preHandler: requireAuth },
    async (request, reply) => {
      const communityId = request.params.id
      const conversationId = request.params.conversationId
      const mem = await getMembership(communityId, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(communityId, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const userId = request.body?.userId?.trim()
      if (!userId) return reply.code(400).send({ error: 'userId required' })
      try {
        await addChannelMember(communityId, conversationId, userId)
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not add member'
        const code =
          msg === 'Channel not found' || msg.includes('Only custom')
            ? 404
            : msg.includes('joined community')
              ? 400
              : 500
        if (code === 500) request.log.error(e)
        return reply.code(code).send({ error: msg })
      }
    },
  )

  /** DELETE /communities/:id/channels/:conversationId/members/:userId */
  app.delete<{ Params: { id: string; conversationId: string; userId: string } }>(
    '/communities/:id/channels/:conversationId/members/:userId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const communityId = request.params.id
      const conversationId = request.params.conversationId
      const mem = await getMembership(communityId, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(communityId, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      try {
        await removeChannelMember(communityId, conversationId, request.params.userId)
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not remove member'
        const code =
          msg === 'Channel not found' || msg.includes('Only custom')
            ? 404
            : msg.includes('last channel')
              ? 400
              : 500
        if (code === 500) request.log.error(e)
        return reply.code(code).send({ error: msg })
      }
    },
  )

  /** PUT /communities/:id/channels/:conversationId/role-access */
  app.put<{
    Params: { id: string; conversationId: string }
    Body: { roles?: string[] }
  }>(
    '/communities/:id/channels/:conversationId/role-access',
    { preHandler: requireAuth },
    async (request, reply) => {
      const communityId = request.params.id
      const conversationId = request.params.conversationId
      const mem = await getMembership(communityId, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(communityId, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const rolesRaw = request.body?.roles
      if (!Array.isArray(rolesRaw)) {
        return reply.code(400).send({ error: 'roles array required' })
      }
      const roles = rolesRaw.filter((r): r is CommunityRole =>
        r === 'admin' || r === 'manage_events' || r === 'manage_community',
      )
      try {
        const roleAccess = await setChannelRoleAccess(communityId, conversationId, roles)
        return { roleAccess }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not update role access'
        const code = msg === 'Channel not found' || msg.includes('Only custom') ? 404 : 500
        if (code === 500) request.log.error(e)
        return reply.code(code).send({ error: msg })
      }
    },
  )

  /** POST /communities/:id/avatar */
  app.post<{ Params: { id: string } }>(
    '/communities/:id/avatar',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: comm } = await supabaseAdmin
        .from('communities')
        .select('created_by')
        .eq('id', request.params.id)
        .maybeSingle()
      if (!comm) return reply.code(404).send({ error: 'Community not found' })

      const deny = await assertCommunityAvatarUpload(
        request.params.id,
        request.userId,
        comm.created_by as string,
      )
      if (deny) return reply.code(403).send({ error: deny })

      const file = await request.file()
      if (!file) return reply.code(400).send({ error: 'Avatar file required' })

      const chunks: Buffer[] = []
      for await (const chunk of file.file) chunks.push(chunk)
      const buffer = Buffer.concat(chunks)

      try {
        const row = await saveCommunityAvatar(request.params.id, buffer)
        return await toDto(row, request.userId)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not save avatar'
        const code = msg === 'Invalid image file' || msg.includes('must be') ? 400 : 500
        if (code === 500) request.log.error(e)
        return reply.code(code).send({ error: msg })
      }
    },
  )

  /** GET /communities/by-invite/:token — preview for invite link landing */
  app.get<{ Params: { token: string } }>(
    '/communities/by-invite/:token',
    { preHandler: requireAuth },
    async (request, reply) => {
      const link = await getEnabledCommunityInviteLink(request.params.token)
      if (!link) return reply.code(404).send({ error: 'Invite link not found' })
      const { data: row } = await supabaseAdmin
        .from('communities')
        .select(COMMUNITY_SELECT)
        .eq('id', link.community_id)
        .maybeSingle()
      if (!row) return reply.code(404).send({ error: 'Community not found' })
      return await toDto(row as CommunityRow, request.userId)
    },
  )

  /** POST /communities/join-by-link — direct join via invite link token */
  app.post<{ Body: { token?: string } }>(
    '/communities/join-by-link',
    { preHandler: requireAuth },
    async (request, reply) => {
      const token = request.body?.token?.trim()
      if (!token) return reply.code(400).send({ error: 'token required' })

      const link = await getEnabledCommunityInviteLink(token)
      if (!link) return reply.code(404).send({ error: 'Invite link not found' })

      const { data: row } = await supabaseAdmin
        .from('communities')
        .select(COMMUNITY_SELECT)
        .eq('id', link.community_id)
        .maybeSingle()
      if (!row) return reply.code(404).send({ error: 'Community not found' })
      const c = row as CommunityRow

      const existing = await getMembership(c.id, request.userId)
      if (existing?.status === 'joined') {
        await recordCommunityInviteJoin(link.id, request.userId)
        return await toDto(c, request.userId)
      }

      const { error } = await supabaseAdmin.from('community_members').upsert(
        { community_id: c.id, user_id: request.userId, status: 'joined' },
        { onConflict: 'community_id,user_id' },
      )
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not join' })
      }
      try {
        await addUserToDefaultCommunityChannels(c.id, request.userId)
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not join channels' })
      }
      await recordCommunityInviteJoin(link.id, request.userId)
      return await toDto(c, request.userId)
    },
  )

  /** GET /communities/:id/invite-links — list invite links (manage_community) */
  app.get<{ Params: { id: string } }>(
    '/communities/:id/invite-links',
    { preHandler: requireAuth },
    async (request, reply) => {
      const mem = await getMembership(request.params.id, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(request.params.id, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      try {
        const links = await listCommunityInviteLinks(request.params.id)
        const joinsMap = await joinsForCommunityInviteLinks(links.map((l) => l.id))
        const allPaths = [...joinsMap.values()].flat().map((u) => u.avatarStoragePath)
        const urlMap = await avatarUrlsForPaths(allPaths)
        return {
          links: links.map((l) => {
            const joined = joinsMap.get(l.id) ?? []
            return {
              id: l.id,
              token: l.token,
              enabled: l.enabled,
              createdAt: l.created_at,
              joinCount: joined.length,
              joinedUsers: joined.map((u) => ({
                userId: u.userId,
                fullName: u.fullName,
                username: u.username,
                avatarUrl: u.avatarStoragePath
                  ? urlMap.get(u.avatarStoragePath) ?? null
                  : null,
                avatarUpdatedAt: u.avatarUpdatedAt,
              })),
            }
          }),
        }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not load invite links' })
      }
    },
  )

  /** POST /communities/:id/invite-links — generate invite link */
  app.post<{ Params: { id: string } }>(
    '/communities/:id/invite-links',
    { preHandler: requireAuth },
    async (request, reply) => {
      const communityId = request.params.id
      const mem = await getMembership(communityId, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(communityId, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const { data: row } = await supabaseAdmin
        .from('communities')
        .select('join_mode')
        .eq('id', communityId)
        .maybeSingle()
      if (!row) return reply.code(404).send({ error: 'Community not found' })
      try {
        const link = await createCommunityInviteLink(communityId, request.userId)
        return reply.code(201).send({
          id: link.id,
          token: link.token,
          enabled: link.enabled,
          createdAt: link.created_at,
          joinCount: 0,
          joinedUsers: [],
        })
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not create invite link' })
      }
    },
  )

  /** PATCH /communities/:id/invite-links/:linkId — enable/disable link */
  app.patch<{ Params: { id: string; linkId: string }; Body: { enabled?: boolean } }>(
    '/communities/:id/invite-links/:linkId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const communityId = request.params.id
      const mem = await getMembership(communityId, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(communityId, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (typeof request.body?.enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled boolean required' })
      }
      try {
        await setCommunityInviteLinkEnabled(
          request.params.linkId,
          communityId,
          request.body.enabled,
        )
        return { ok: true, enabled: request.body.enabled }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not update invite link' })
      }
    },
  )

  /** DELETE /communities/:id/invite-links/:linkId — manage_community */
  app.delete<{ Params: { id: string; linkId: string } }>(
    '/communities/:id/invite-links/:linkId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const communityId = request.params.id
      const mem = await getMembership(communityId, request.userId)
      if (!mem || mem.status !== 'joined') {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await canManageCommunity(communityId, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      try {
        await deleteCommunityInviteLink(request.params.linkId, communityId)
        return { ok: true }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not delete invite link' })
      }
    },
  )
}
