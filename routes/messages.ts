/**
 * Authenticated messaging HTTP API.
 *
 * Every route uses requireAuth. Mutations use supabaseAdmin after membership
 * and business-rule checks. Media lives in Storage bucket `chat-media`.
 * See `.cursor/rules/messaging.mdc`.
 */

import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { requireAuth } from '../middleware/auth.js'
import { supabaseAdmin } from '../services/supabase.js'
import {
  assertAttachmentPathOwned,
  assertMember,
  buildStoragePath,
  createSignedDownloadUrl,
  createSignedUpload,
  lastVisibleMessagesByConversationIds,
  messageThreadSelect,
  shouldRetryWithoutModerationHidden,
  storageObjectExists,
  validateAttachmentMeta,
  withinEditWindow,
  reencodeChatImageAttachment,
  type AttachmentInput,
} from '../services/messaging.js'
import { avatarUrlsForPaths } from '../services/avatars.js'
import { communityAvatarUrlsForPaths } from '../services/communities.js'
import { eventCoverUrlsForPaths } from '../services/eventCovers.js'
import { findOrCreateDirectConversation, sendCreatorWelcomeMessage } from '../services/conversations.js'
import { eventChatWriteBlocked, syncStaleEventChatArchives } from '../services/events.js'
import { notifyUsers } from '../services/notifications/dispatcher.js'
import { messageNotification } from '../services/notifications/templates.js'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'
import {
  assertCanWriteCommunityChannel,
  resolveCommunityIdForConversation,
} from '../services/communityChannels.js'
import {
  messageAllowedForViewer,
  messageHideSets,
} from '../services/moderation.js'

type CreateConversationBody = {
  type?: 'direct' | 'group'
  memberUsernames?: string[]
}

type PrepareAttachmentBody = {
  clientId?: string
  mimeType?: string
  sizeBytes?: number
  fileName?: string
}

type SendMessageBody = {
  body?: string | null
  clientId?: string
  attachments?: AttachmentInput[]
  replyToId?: string
}

type DirectConversationBody = {
  otherUserId?: string
}

type EditMessageBody = {
  body?: string
}

type ReadBody = {
  messageId?: string
}

type MessageWithAttachments = {
  message_attachments?: Array<{
    id?: string
    storage_path?: string
    mime_type?: string
    size_bytes?: number
    file_name?: string
  }> | null
}

/**
 * Attach signed download URLs to message attachment rows.
 */
async function withSignedAttachments(
  msg: MessageWithAttachments,
  log: { warn: (e: unknown) => void },
) {
  const attachments = []
  for (const att of msg.message_attachments ?? []) {
    let downloadUrl: string | null = null
    if (att?.storage_path) {
      try {
        downloadUrl = await createSignedDownloadUrl(att.storage_path)
      } catch (e) {
        log.warn(e)
      }
    }
    attachments.push({ ...att, downloadUrl })
  }
  return { ...msg, message_attachments: attachments }
}

async function notifyMessageRecipients(
  request: { userId: string; log: { warn: (e: unknown) => void } },
  conversationId: string,
  senderId: string,
  message: {
    id: string
    body: string | null
    created_at: string
    message_attachments?: unknown[] | null
  },
) {
  try {
    const { data: members } = await supabaseAdmin
      .from('conversation_members')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .neq('user_id', senderId)

    const recipientIds = (members ?? []).map((m) => m.user_id)
    if (recipientIds.length === 0) return

    const { data: sender } = await supabaseAdmin
      .from('profiles')
      .select('full_name')
      .eq('id', senderId)
      .maybeSingle()

    const senderName = sender?.full_name ?? 'Someone'
    const hasAttachment =
      Array.isArray(message.message_attachments) && message.message_attachments.length > 0

    let communityId: string | undefined
    try {
      communityId =
        (await resolveCommunityIdForConversation(conversationId)) ?? undefined
    } catch {
      communityId = undefined
    }

    void notifyUsers(
      recipientIds,
      messageNotification({
        senderName,
        senderId,
        body: message.body,
        conversationId,
        messageId: message.id,
        createdAt: message.created_at,
        hasAttachment,
        ...(communityId ? { communityId } : {}),
      }),
      { excludeUserId: senderId, log: request.log },
    )
  } catch (e) {
    request.log.warn(e)
  }
}

/**
 * Register messaging routes on the Fastify app.
 *
 * @auth Public registrar — all handlers use `requireAuth`
 * @param app - Fastify instance
 * @pre `supabaseAdmin` and messaging helpers configured
 * @post Conversation and message CRUD routes under `/conversations` and `/messages`
 */
export async function messageRoutes(app: FastifyInstance) {
  /**
   * GET `/conversations` — list conversations for the authenticated user.
   *
   * @auth Bearer required
   * @query limit, cursor, q, archived (`0` default / `1`), kind (`all`|`friends`|`events`|`communities`)
   * @returns 200 array of conversations with members, lastReadAt, unreadCount; `[]` when none
   * @errors 401 token invalid; 500 DB error
   * @pre `request.userId` set
   * @post Read-only; uses supabaseAdmin. Filters archived + kind before cursor pagination.
   */
  app.get<{
    Querystring: { limit?: string; cursor?: string; q?: string; archived?: string; kind?: string }
  }>('/conversations', { preHandler: requireAuth }, async (request, reply) => {
    const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)
    const cursor = request.query.cursor?.trim()
    const q = (request.query.q ?? '').trim().toLowerCase()
    const archivedWanted =
      request.query.archived === '1' || request.query.archived === 'true'
    const kindRaw = (request.query.kind ?? 'all').trim().toLowerCase()
    const kind =
      kindRaw === 'friends' || kindRaw === 'events' || kindRaw === 'communities'
        ? kindRaw
        : 'all'
    if (exceedsLimit(q, TEXT_LIMITS.search)) {
      return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.search} characters` })
    }

    const { data: memberships, error } = await supabaseAdmin
      .from('conversation_members')
      .select(
        'conversation_id, last_read_at, joined_at, conversations ( id, type, archived_at, created_at, updated_at )',
      )
      .eq('user_id', request.userId)

    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not list conversations' })
    }

    let items = (memberships ?? []).map((m) => {
      const raw = m.conversations as
        | { id: string; type: string; archived_at: string | null; created_at: string; updated_at: string }
        | { id: string; type: string; archived_at: string | null; created_at: string; updated_at: string }[]
        | null
      const conv = Array.isArray(raw) ? (raw[0] ?? null) : raw
      return {
        conversation_id: m.conversation_id,
        last_read_at: m.last_read_at,
        conv,
      }
    })

    items = items.filter((i) => i.conv)

    const staleEventConvIds = items
      .filter((i) => i.conv!.type === 'event' && !i.conv!.archived_at)
      .map((i) => i.conversation_id)
    if (staleEventConvIds.length > 0) {
      try {
        await syncStaleEventChatArchives(staleEventConvIds)
        const { data: refreshed } = await supabaseAdmin
          .from('conversations')
          .select('id, archived_at')
          .in('id', staleEventConvIds)
        const archivedById = new Map(
          (refreshed ?? []).map((c) => [c.id as string, c.archived_at as string | null]),
        )
        for (const item of items) {
          const next = archivedById.get(item.conversation_id)
          if (next !== undefined && item.conv) {
            item.conv.archived_at = next
          }
        }
      } catch (syncErr) {
        request.log.warn({ err: syncErr }, 'syncStaleEventChatArchives failed')
      }
    }

    items = items.filter((i) => {
      const isArchived = Boolean(i.conv!.archived_at)
      if (isArchived !== archivedWanted) return false
      if (kind === 'friends') return i.conv!.type === 'direct' || i.conv!.type === 'group'
      if (kind === 'events') return i.conv!.type === 'event'
      if (kind === 'communities') return i.conv!.type === 'community'
      return true
    })
    items.sort((a, b) => (b.conv!.updated_at > a.conv!.updated_at ? 1 : -1))

    if (cursor) {
      items = items.filter((i) => i.conv!.updated_at < cursor)
    }

    const conversationIds = items.map((i) => i.conversation_id)
    if (conversationIds.length === 0) {
      return { conversations: [], nextCursor: null }
    }

    const { data: members, error: membersError } = await supabaseAdmin
      .from('conversation_members')
      .select(
        'conversation_id, user_id, profiles ( id, username, full_name, avatar_storage_path, avatar_updated_at )',
      )
      .in('conversation_id', conversationIds)

    if (membersError) {
      request.log.error(membersError)
      return reply.code(500).send({ error: 'Could not load members' })
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
    const lastReadByConv = new Map(
      items.map((i) => [i.conversation_id, i.last_read_at as string | null]),
    )
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

    const avatarPaths: Array<string | null> = []
    for (const x of members ?? []) {
      const p = x.profiles as
        | { avatar_storage_path?: string | null; avatar_updated_at?: string | null }
        | { avatar_storage_path?: string | null; avatar_updated_at?: string | null }[]
        | null
      const prof = Array.isArray(p) ? p[0] : p
      avatarPaths.push(prof?.avatar_storage_path ?? null)
    }
    const urlMap = await avatarUrlsForPaths(avatarPaths)

    const { data: eventRows } = await supabaseAdmin
      .from('events')
      .select(
        'id, title, conversation_id, cover_storage_path, cover_updated_at, organizer_community_id, starts_at',
      )
      .in('conversation_id', conversationIds)
    const communityEventConvIds = new Set(
      (eventRows ?? [])
        .filter((e) => e.organizer_community_id)
        .map((e) => e.conversation_id as string),
    )
    // Community-organized event chats belong in the community UI, not /chat.
    items = items.filter((i) => !communityEventConvIds.has(i.conversation_id))
    if (items.length === 0) {
      return { conversations: [], nextCursor: null }
    }
    const remainingIds = new Set(items.map((i) => i.conversation_id))
    const communityConvIds = items
      .filter((i) => remainingIds.has(i.conversation_id) && i.conv!.type === 'community')
      .map((i) => i.conversation_id)
    type CommunityLink = {
      communityId: string
      name: string
      kind: string | null
      position: number | null
      communityName: string | null
      communityAvatarUrl: string | null
      communityAvatarUpdatedAt: string | null
    }
    const communityByConv = new Map<string, CommunityLink>()
    if (communityConvIds.length > 0) {
      const { data: links } = await supabaseAdmin
        .from('community_conversations')
        .select('conversation_id, community_id, name, kind, position')
        .in('conversation_id', communityConvIds)
      const communityIds = [
        ...new Set((links ?? []).map((l) => l.community_id as string).filter(Boolean)),
      ]
      const { data: comms } =
        communityIds.length > 0
          ? await supabaseAdmin
              .from('communities')
              .select('id, name, avatar_storage_path, avatar_updated_at')
              .in('id', communityIds)
          : { data: [] }
      const commById = new Map((comms ?? []).map((c) => [c.id as string, c]))
      const communityAvatarMap = await communityAvatarUrlsForPaths(
        (comms ?? []).map((c) => c.avatar_storage_path as string | null),
      )
      for (const link of links ?? []) {
        const comm = commById.get(link.community_id as string)
        const path = (comm?.avatar_storage_path as string | null | undefined) ?? null
        communityByConv.set(link.conversation_id as string, {
          communityId: link.community_id as string,
          name: (link.name as string) ?? '',
          kind: (link.kind as string | null) ?? null,
          position: (link.position as number | null) ?? null,
          communityName: (comm?.name as string | null | undefined) ?? null,
          communityAvatarUrl: path ? communityAvatarMap.get(path) ?? null : null,
          communityAvatarUpdatedAt:
            (comm?.avatar_updated_at as string | null | undefined) ?? null,
        })
      }
    }
    const eventRowsMain = (eventRows ?? []).filter(
      (e) => remainingIds.has(e.conversation_id as string),
    )
    const coverMap = await eventCoverUrlsForPaths(
      eventRowsMain.map((e) => e.cover_storage_path as string | null),
    )
    // Series: many events share one conversation — prefer the latest occurrence for title/cover.
    const eventByConv = new Map<string, (typeof eventRowsMain)[number]>()
    for (const e of eventRowsMain) {
      const convId = e.conversation_id as string
      const prev = eventByConv.get(convId)
      if (!prev || String(e.starts_at) > String(prev.starts_at)) {
        eventByConv.set(convId, e)
      }
    }

    let results = items.map((m) => {
      const people = (members ?? [])
        .filter((x) => x.conversation_id === m.conversation_id)
        .map((x) => {
          const p = x.profiles as
            | {
                id: string
                username: string
                full_name: string
                avatar_storage_path?: string | null
                avatar_updated_at?: string | null
              }
            | {
                id: string
                username: string
                full_name: string
                avatar_storage_path?: string | null
                avatar_updated_at?: string | null
              }[]
            | null
          const prof = Array.isArray(p) ? (p[0] ?? null) : p
          if (!prof) return null
          return {
            id: prof.id,
            username: prof.username,
            full_name: prof.full_name,
            avatarUrl: prof.avatar_storage_path
              ? urlMap.get(prof.avatar_storage_path) ?? null
              : null,
            avatarUpdatedAt: prof.avatar_updated_at ?? null,
          }
        })
        .filter(Boolean)

      const last = lastByConv.get(m.conversation_id)
      const ev = eventByConv.get(m.conversation_id)
      const coverPath = (ev?.cover_storage_path as string | null | undefined) ?? null
      const community = communityByConv.get(m.conversation_id)
      return {
        id: m.conv!.id,
        type: m.conv!.type,
        archived_at: m.conv!.archived_at ?? null,
        created_at: m.conv!.created_at,
        updated_at: m.conv!.updated_at,
        lastReadAt: m.last_read_at,
        unreadCount: unreadByConv.get(m.conversation_id) ?? 0,
        members: people,
        lastMessage: last
          ? {
              body: last.deleted_at ? null : last.body,
              created_at: last.created_at,
              sender_id: last.sender_id,
            }
          : null,
        eventId: ev?.id ?? null,
        eventTitle: (ev?.title as string | undefined) ?? null,
        coverUrl: coverPath ? coverMap.get(coverPath) ?? null : null,
        coverUpdatedAt: (ev?.cover_updated_at as string | null | undefined) ?? null,
        communityId: community?.communityId ?? null,
        name: community?.name ?? null,
        channelKind: community?.kind ?? null,
        position: community?.position ?? null,
        communityName: community?.communityName ?? null,
        communityAvatarUrl: community?.communityAvatarUrl ?? null,
        communityAvatarUpdatedAt: community?.communityAvatarUpdatedAt ?? null,
      }
    })

    if (q) {
      results = results.filter((c) => {
        if (c.eventTitle?.toLowerCase().includes(q)) return true
        if (c.name?.toLowerCase().includes(q)) return true
        if (c.communityName?.toLowerCase().includes(q)) return true
        return c.members.some(
          (member) =>
            member &&
            member.id !== request.userId &&
            (member.username.toLowerCase().includes(q) ||
              member.full_name.toLowerCase().includes(q)),
        )
      })
    }

    const page = results.slice(0, limit)
    const nextCursor =
      results.length > limit ? page[page.length - 1]?.updated_at ?? null : null

    return { conversations: page, nextCursor }
  })

  app.post<{ Body: DirectConversationBody }>(
    '/conversations/direct',
    { preHandler: requireAuth },
    async (request, reply) => {
      const otherUserId = request.body?.otherUserId?.trim()
      if (!otherUserId) {
        return reply.code(400).send({ error: 'otherUserId required' })
      }
      if (otherUserId === request.userId) {
        return reply.code(400).send({ error: 'Cannot chat with yourself' })
      }

      const { data: other } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('id', otherUserId)
        .maybeSingle()

      if (!other) {
        return reply.code(404).send({ error: 'User not found' })
      }

      try {
        const id = await findOrCreateDirectConversation(request.userId, otherUserId)
        return { id }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not open conversation' })
      }
    },
  )

  /**
   * POST `/conversations` — create group, or find-or-create direct by usernames.
   *
   * @auth Bearer required
   * @body type (`direct`|`group`), memberUsernames (usernames to add)
   * @returns 201 conversation row `{ id, type, created_at, updated_at }`
   * @errors 400 invalid members; 404 username not found; 500 create failed
   * @pre Direct: exactly one other user; reuses existing pair via findOrCreateDirectConversation
   * @post Groups insert new row; directs use direct_conversation_pairs uniqueness
   */
  app.post<{ Body: CreateConversationBody }>(
    '/conversations',
    { preHandler: requireAuth },
    async (request, reply) => {
      const type = request.body?.type === 'group' ? 'group' : 'direct'
      const usernames = [
        ...new Set(
          (request.body?.memberUsernames ?? [])
            .map((u) => u.trim().toLowerCase())
            .filter(Boolean),
        ),
      ]

      if (usernames.length === 0) {
        return reply.code(400).send({ error: 'memberUsernames required' })
      }

      const { data: profiles, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('id, username')
        .in('username', usernames)

      if (profileError) {
        request.log.error(profileError)
        return reply.code(500).send({ error: 'Could not resolve usernames' })
      }

      if (!profiles || profiles.length !== usernames.length) {
        return reply.code(404).send({ error: 'One or more usernames not found' })
      }

      const memberIds = new Set(profiles.map((p) => p.id))
      memberIds.add(request.userId)

      if (type === 'direct') {
        if (memberIds.size !== 2) {
          return reply.code(400).send({ error: 'Direct chats need exactly one other user' })
        }
        const otherUserId = [...memberIds].find((id) => id !== request.userId)
        if (!otherUserId) {
          return reply.code(400).send({ error: 'Direct chats need exactly one other user' })
        }
        try {
          const id = await findOrCreateDirectConversation(request.userId, otherUserId)
          const { data: conversation, error: loadError } = await supabaseAdmin
            .from('conversations')
            .select('id, type, created_at, updated_at')
            .eq('id', id)
            .single()
          if (loadError || !conversation) {
            request.log.error(loadError)
            return reply.code(500).send({ error: 'Could not open conversation' })
          }
          return reply.code(201).send(conversation)
        } catch (e) {
          request.log.error(e)
          return reply.code(500).send({ error: 'Could not open conversation' })
        }
      }

      const { data: conversation, error: convError } = await supabaseAdmin
        .from('conversations')
        .insert({ type })
        .select('id, type, created_at, updated_at')
        .single()

      if (convError || !conversation) {
        request.log.error(convError)
        return reply.code(500).send({ error: 'Could not create conversation' })
      }

      const rows = [...memberIds].map((userId) => ({
        conversation_id: conversation.id,
        user_id: userId,
        role: userId === request.userId ? 'admin' : 'member',
      }))

      const { error: memberError } = await supabaseAdmin
        .from('conversation_members')
        .insert(rows)

      if (memberError) {
        request.log.error(memberError)
        await supabaseAdmin.from('conversations').delete().eq('id', conversation.id)
        return reply.code(500).send({ error: 'Could not add members' })
      }

      try {
        await sendCreatorWelcomeMessage(conversation.id, request.userId, 'Group')
      } catch (e) {
        request.log.error(e)
      }

      return reply.code(201).send(conversation)
    },
  )

  /**
   * GET `/conversations/:id/messages` — paginated message history.
   *
   * @auth Bearer required + conversation membership
   * @query limit (max 100, default 50), before (ISO cursor for older messages)
   * @returns 200 array oldest-first with signed `downloadUrl` on attachments
   * @errors 401; 403 not member; 500 load failed
   * @pre `assertMember` passes
   * @post Read-only
   */
  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; before?: string }
  }>('/conversations/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
    const conversationId = request.params.id
    try {
      if (!(await assertMember(conversationId, request.userId))) {
        return reply.code(403).send({ error: 'Not a member of this conversation' })
      }
    } catch (e) {
      request.log.error(e)
      return reply.code(500).send({ error: 'Could not load messages' })
    }

    const limit = Math.min(Number(request.query.limit ?? 50) || 50, 100)
    // Flat select + separate attachments: embed join 500s on some community threads.
    const buildThreadQuery = () => {
      let q = supabaseAdmin
        .from('messages')
        .select(messageThreadSelect())
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (request.query.before) {
        q = q.lt('created_at', request.query.before)
      }
      return q
    }

    let { data, error } = await buildThreadQuery()
    if (shouldRetryWithoutModerationHidden(error)) {
      ;({ data, error } = await buildThreadQuery())
    }
    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not load messages' })
    }

    type ThreadMessageRow = {
      id: string
      conversation_id: string
      sender_id: string
      body: string | null
      client_id: string | null
      created_at: string
      edited_at: string | null
      deleted_at: string | null
      reply_to_id: string | null
      moderation_hidden_at?: string | null
    }
    const rows = (data ?? []) as unknown as ThreadMessageRow[]
    const messageIds = rows.map((m) => m.id)
    const attachmentsByMessage = new Map<
      string,
      Array<{
        id: string
        storage_path: string
        mime_type: string
        size_bytes: number
        file_name: string
      }>
    >()
    if (messageIds.length > 0) {
      const { data: attRows, error: attErr } = await supabaseAdmin
        .from('message_attachments')
        .select('id, message_id, storage_path, mime_type, size_bytes, file_name')
        .in('message_id', messageIds)
      if (attErr) {
        request.log.warn({ err: attErr }, 'message_attachments for thread')
      } else {
        for (const att of attRows ?? []) {
          const mid = att.message_id as string
          const list = attachmentsByMessage.get(mid) ?? []
          list.push({
            id: att.id as string,
            storage_path: att.storage_path as string,
            mime_type: att.mime_type as string,
            size_bytes: att.size_bytes as number,
            file_name: att.file_name as string,
          })
          attachmentsByMessage.set(mid, list)
        }
      }
    }

    const hideSets = await messageHideSets(request.userId)
    const messages = []
    for (const msg of rows) {
      if (
        !messageAllowedForViewer(msg, request.userId, hideSets.personal, hideSets.global)
      ) {
        continue
      }
      const attachments = []
      for (const att of attachmentsByMessage.get(msg.id) ?? []) {
        let downloadUrl: string | null = null
        try {
          downloadUrl = await createSignedDownloadUrl(att.storage_path)
        } catch (e) {
          request.log.warn(e)
        }
        attachments.push({ ...att, downloadUrl })
      }
      messages.push({ ...msg, message_attachments: attachments })
    }

    return messages.reverse()
  })

  /**
   * POST `/conversations/:id/attachments/prepare` — signed upload URL for chat media.
   *
   * @auth Bearer required + conversation membership
   * @body clientId, mimeType, sizeBytes, fileName
   * @returns 200 `{ clientId, storagePath, signedUrl, token, path }`
   * @errors 400 validation; 403 not member; 500 prepare failed
   * @pre Attachment meta passes `validateAttachmentMeta`
   * @post Client must PUT file to `signedUrl` before POST message
   */
  app.post<{ Params: { id: string }; Body: PrepareAttachmentBody }>(
    '/conversations/:id/attachments/prepare',
    { preHandler: requireAuth },
    async (request, reply) => {
      const conversationId = request.params.id
      if (!(await assertMember(conversationId, request.userId))) {
        return reply.code(403).send({ error: 'Not a member of this conversation' })
      }

      const clientId = request.body?.clientId ?? randomUUID()
      const mimeType = request.body?.mimeType ?? ''
      const sizeBytes = Number(request.body?.sizeBytes ?? 0)
      const fileName = request.body?.fileName ?? ''

      const validationError = validateAttachmentMeta({ mimeType, sizeBytes, fileName })
      if (validationError) {
        return reply.code(400).send({ error: validationError })
      }

      const storagePath = buildStoragePath({
        conversationId,
        userId: request.userId,
        clientId,
        fileName,
      })

      try {
        const signed = await createSignedUpload(storagePath)
        return {
          clientId,
          storagePath,
          signedUrl: signed.signedUrl,
          token: signed.token,
          path: signed.path,
        }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not prepare upload' })
      }
    },
  )

  /**
   * POST `/conversations/:id/messages` — send text and/or attachments.
   *
   * @auth Bearer required + conversation membership
   * @body body (optional text), clientId (idempotency), attachments (after upload)
   * @returns 201 message with attachments; 200 existing when same clientId
   * @errors 400 empty/invalid attachment; 403 not member; 500 send failed
   * @pre Text and/or attachments; storage objects exist; path owned by sender
   * @post Idempotent per (sender_id, client_id); updates conversation updated_at
   */
  app.post<{ Params: { id: string }; Body: SendMessageBody }>(
    '/conversations/:id/messages',
    { preHandler: requireAuth },
    async (request, reply) => {
      const conversationId = request.params.id
      if (!(await assertMember(conversationId, request.userId))) {
        return reply.code(403).send({ error: 'Not a member of this conversation' })
      }
      const canWrite = await assertCanWriteCommunityChannel(conversationId, request.userId)
      if (canWrite === false) {
        return reply.code(403).send({ error: 'You cannot post in this channel' })
      }
      if (await eventChatWriteBlocked(conversationId)) {
        return reply.code(403).send({ error: 'This event chat is archived' })
      }

      const clientId = request.body?.clientId ?? randomUUID()
      const rawBody = request.body?.body
      const body =
        typeof rawBody === 'string' && rawBody.trim().length > 0 ? rawBody.trim() : null
      const attachments = request.body?.attachments ?? []
      const replyToId = request.body?.replyToId?.trim()

      if (body && exceedsLimit(body, TEXT_LIMITS.messageBody)) {
        return reply.code(400).send({
          error: `Message must be at most ${TEXT_LIMITS.messageBody} characters`,
        })
      }

      if (!body && attachments.length === 0) {
        return reply.code(400).send({ error: 'Message must have text and/or attachments' })
      }

      if (replyToId) {
        const { data: parent } = await supabaseAdmin
          .from('messages')
          .select('id, conversation_id')
          .eq('id', replyToId)
          .maybeSingle()
        if (!parent || parent.conversation_id !== conversationId) {
          return reply.code(400).send({ error: 'Invalid reply target' })
        }
      }

      for (const att of attachments) {
        const validationError = validateAttachmentMeta({
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes,
          fileName: att.fileName,
        })
        if (validationError) {
          return reply.code(400).send({ error: validationError })
        }
        if (
          !assertAttachmentPathOwned({
            storagePath: att.storagePath,
            conversationId,
            userId: request.userId,
            clientId,
          })
        ) {
          return reply.code(400).send({ error: 'Invalid attachment path' })
        }
        try {
          const exists = await storageObjectExists(att.storagePath)
          if (!exists) {
            return reply.code(400).send({ error: 'Attachment not found in storage' })
          }
        } catch (e) {
          request.log.error(e)
          return reply.code(500).send({ error: 'Could not verify attachment' })
        }
      }

      const { data: existing } = await supabaseAdmin
        .from('messages')
        .select(
          'id, conversation_id, sender_id, body, client_id, created_at, edited_at, deleted_at, reply_to_id, message_attachments ( id, storage_path, mime_type, size_bytes, file_name )',
        )
        .eq('sender_id', request.userId)
        .eq('client_id', clientId)
        .maybeSingle()

      if (existing) {
        return existing
      }

      const { data: message, error: insertError } = await supabaseAdmin
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_id: request.userId,
          body,
          client_id: clientId,
          reply_to_id: replyToId ?? null,
        })
        .select('id, conversation_id, sender_id, body, client_id, created_at, edited_at, deleted_at, reply_to_id')
        .single()

      if (insertError || !message) {
        request.log.error(insertError)
        return reply.code(500).send({ error: 'Could not send message' })
      }

      if (attachments.length > 0) {
        const processed: AttachmentInput[] = []
        try {
          for (const a of attachments) {
            processed.push(await reencodeChatImageAttachment(a))
          }
        } catch (e) {
          request.log.error(e)
          await supabaseAdmin.from('messages').delete().eq('id', message.id)
          return reply.code(500).send({ error: 'Could not process image' })
        }

        const { error: attError } = await supabaseAdmin.from('message_attachments').insert(
          processed.map((a) => ({
            message_id: message.id,
            storage_path: a.storagePath,
            mime_type: a.mimeType,
            size_bytes: a.sizeBytes,
            file_name: a.fileName,
          })),
        )
        if (attError) {
          request.log.error(attError)
          await supabaseAdmin.from('messages').delete().eq('id', message.id)
          return reply.code(500).send({ error: 'Could not save attachments' })
        }
      }

      await supabaseAdmin
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversationId)

      const { data: full, error: loadError } = await supabaseAdmin
        .from('messages')
        .select(
          'id, conversation_id, sender_id, body, client_id, created_at, edited_at, deleted_at, reply_to_id, message_attachments ( id, storage_path, mime_type, size_bytes, file_name )',
        )
        .eq('id', message.id)
        .single()

      if (loadError || !full) {
        void notifyMessageRecipients(request, conversationId, request.userId, message)
        return reply.code(201).send(message)
      }

      void notifyMessageRecipients(request, conversationId, request.userId, full)
      // Signed download URLs so the sender UI can resolve attachments without a refetch
      return reply.code(201).send(await withSignedAttachments(full, request.log))
    },
  )

  /**
   * PATCH `/messages/:id` — edit own message within 15-minute window.
   *
   * @auth Bearer required; sender only
   * @body body (new text)
   * @returns 200 updated message
   * @errors 400 empty/deleted/expired window; 403 not sender; 404 not found; 500
   * @pre `withinEditWindow(created_at)` and not soft-deleted
   * @post Sets `edited_at`
   */
  app.patch<{ Params: { id: string }; Body: EditMessageBody }>(
    '/messages/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const body = request.body?.body?.trim()
        if (!body) {
          return reply.code(400).send({ error: 'body is required' })
        }
        if (exceedsLimit(body, TEXT_LIMITS.messageBody)) {
          return reply.code(400).send({
            error: `Message must be at most ${TEXT_LIMITS.messageBody} characters`,
          })
        }

        const { data: message, error } = await supabaseAdmin
          .from('messages')
          .select('id, sender_id, created_at, deleted_at, conversation_id')
          .eq('id', request.params.id)
          .maybeSingle()

        if (error || !message) {
          return reply.code(404).send({ error: 'Message not found' })
        }
        if (!(await assertMember(message.conversation_id, request.userId))) {
          return reply.code(403).send({ error: 'Not a member of this conversation' })
        }
        const canWrite = await assertCanWriteCommunityChannel(
          message.conversation_id,
          request.userId,
        )
        if (canWrite === false) {
          return reply.code(403).send({ error: 'You cannot post in this channel' })
        }
        if (await eventChatWriteBlocked(message.conversation_id)) {
          return reply.code(403).send({ error: 'This event chat is archived' })
        }
        if (message.sender_id !== request.userId) {
          return reply.code(403).send({ error: 'Not your message' })
        }
        if (message.deleted_at) {
          return reply.code(400).send({ error: 'Message already deleted' })
        }
        if (!withinEditWindow(message.created_at)) {
          return reply.code(400).send({ error: 'Edit window expired (15 minutes)' })
        }

        const { data: updated, error: updateError } = await supabaseAdmin
          .from('messages')
          .update({ body, edited_at: new Date().toISOString() })
          .eq('id', message.id)
          .select(
            'id, conversation_id, sender_id, body, client_id, created_at, edited_at, deleted_at, reply_to_id, message_attachments ( id, storage_path, mime_type, size_bytes, file_name )',
          )
          .single()

        if (updateError || !updated) {
          request.log.error(updateError)
          return reply.code(500).send({ error: 'Could not edit message' })
        }

        return await withSignedAttachments(updated, request.log)
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not edit message' })
      }
    },
  )

  /**
   * DELETE `/messages/:id` — soft-delete own message within 15-minute window.
   *
   * @auth Bearer required; sender only
   * @returns 204 on success (idempotent if already deleted)
   * @errors 400 expired window; 403 not sender; 404 not found; 500
   * @pre `withinEditWindow` unless already deleted
   * @post Sets `deleted_at`, clears `body`
   */
  app.delete<{ Params: { id: string } }>(
    '/messages/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const { data: message, error } = await supabaseAdmin
          .from('messages')
          .select('id, sender_id, created_at, deleted_at, conversation_id')
          .eq('id', request.params.id)
          .maybeSingle()

        if (error || !message) {
          return reply.code(404).send({ error: 'Message not found' })
        }
        if (!(await assertMember(message.conversation_id, request.userId))) {
          return reply.code(403).send({ error: 'Not a member of this conversation' })
        }
        if (message.sender_id !== request.userId) {
          return reply.code(403).send({ error: 'Not your message' })
        }
        if (message.deleted_at) {
          return reply.code(204).send()
        }
        if (!withinEditWindow(message.created_at)) {
          return reply.code(400).send({ error: 'Delete window expired (15 minutes)' })
        }

        const { error: updateError } = await supabaseAdmin
          .from('messages')
          .update({
            deleted_at: new Date().toISOString(),
            body: null,
          })
          .eq('id', message.id)

        if (updateError) {
          request.log.error(updateError)
          return reply.code(500).send({ error: 'Could not delete message' })
        }

        return reply.code(204).send()
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not delete message' })
      }
    },
  )

  /**
   * POST `/conversations/:id/read` — update read cursor for current user.
   *
   * @auth Bearer required + conversation membership
   * @body messageId (optional) — upsert into `message_reads`
   * @returns 200 `{ lastReadAt }`
   * @errors 401; 403 not member; 500 member update failed
   * @pre `assertMember` passes
   * @post Updates `conversation_members.last_read_at`; optional `message_reads` upsert
   */
  app.post<{ Params: { id: string }; Body: ReadBody }>(
    '/conversations/:id/read',
    { preHandler: requireAuth },
    async (request, reply) => {
      const conversationId = request.params.id
      if (!(await assertMember(conversationId, request.userId))) {
        return reply.code(403).send({ error: 'Not a member of this conversation' })
      }

      const now = new Date().toISOString()
      const { error: memberError } = await supabaseAdmin
        .from('conversation_members')
        .update({ last_read_at: now })
        .eq('conversation_id', conversationId)
        .eq('user_id', request.userId)

      if (memberError) {
        request.log.error(memberError)
        return reply.code(500).send({ error: 'Could not update read state' })
      }

      if (request.body?.messageId) {
        const { error: readError } = await supabaseAdmin.from('message_reads').upsert(
          {
            message_id: request.body.messageId,
            user_id: request.userId,
            seen_at: now,
          },
          { onConflict: 'message_id,user_id' },
        )
        if (readError) {
          request.log.error(readError)
        }
      }

      return { lastReadAt: now }
    },
  )
}
