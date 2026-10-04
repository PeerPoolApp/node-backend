/**
 * Admin catalog DTOs for users, events, communities, and messages.
 * Used by GET /admin/events and enriched GET /admin/reports.
 */

import { supabaseAdmin } from './supabase.js'
import { avatarUrlsForPaths } from './avatars.js'
import {
  communityAvatarUrlsForPaths,
  COMMUNITY_SELECT_CORE,
  memberCount,
} from './communities.js'
import { EVENT_SELECT, type EventRow } from './events.js'
import { eventCoverUrlsForPaths } from './eventCovers.js'
import { createHashtagGroupMediaUrl } from './hashtagGroupMedia.js'
import { hashtagItemsForCommunityIds, hashtagItemsForEventIds } from './hashtags.js'
import { createSignedDownloadUrl } from './messaging.js'
import { resolveGroupCoverPathForEvent } from './tagPropagation.js'
import { visibleTagsForUsers, type UserTagDto } from './userHashtags.js'

const PROFILE_ADMIN =
  'id, username, full_name, birthday, app_role, deleted_at, moderation_hidden_at, banned_at, ban_reason, ban_details, avatar_storage_path, avatar_updated_at, created_at'

export type AdminUserDto = {
  id: string
  username: string
  fullName: string
  birthday: string | null
  appRole: string | null
  bannedAt: string | null
  banReason: string | null
  banDetails: string | null
  moderationHiddenAt: string | null
  avatarUrl: string | null
  avatarUpdatedAt: string | null
  tags: UserTagDto[]
  createdAt: string | null
}

export type AdminOrganizerDto = {
  type: 'user' | 'community'
  id: string
  name: string
  avatarUrl: string | null
  avatarUpdatedAt: string | null
}

export type AdminEventDto = {
  id: string
  title: string
  description: string | null
  startsAt: string
  endsAt: string
  locationText: string | null
  locationShortText: string | null
  locationLat: number | null
  locationLng: number | null
  joinLimit: number
  joinedCount: number
  interestedCount: number
  myStatus: null
  organizer: AdminOrganizerDto
  conversationId: string | null
  chatArchivedAt: string | null
  visibility: string
  organizerConversationId: string | null
  coverUrl: string | null
  coverUpdatedAt: string | null
  hashtags: string[]
  hashtagItems: { slug: string; groupSlug?: string | null; groupIconUrl?: string | null }[]
  canceledAt: string | null
  moderationHiddenAt: string | null
}

export type AdminCommunityDto = {
  id: string
  name: string
  identifier: string
  description: string | null
  joinMode: string
  avatarUrl: string | null
  avatarUpdatedAt: string | null
  memberCount: number
  myRoles: string[]
  myStatus: null
  createdBy: string
  hashtags: string[]
  hashtagItems: { slug: string; groupSlug?: string | null; groupIconUrl?: string | null }[]
  moderationHiddenAt: string | null
}

export type AdminMessageDto = {
  id: string
  conversationId: string
  senderId: string
  body: string | null
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  moderationHiddenAt: string | null
  sender: AdminUserDto | null
  message_attachments: Array<{
    id: string
    storage_path: string
    mime_type: string
    size_bytes: number
    file_name: string
    downloadUrl: string | null
  }>
}

/**
 * Profile rows → FriendUserRow-ready admin user DTOs (avatars + tags).
 */
export async function adminUsersByIds(ids: string[]): Promise<Map<string, AdminUserDto>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const map = new Map<string, AdminUserDto>()
  if (!unique.length) return map
  const { data: page, error } = await supabaseAdmin.from('profiles').select(PROFILE_ADMIN).in('id', unique)
  if (error) throw error
  const urlMap = await avatarUrlsForPaths((page ?? []).map((p) => p.avatar_storage_path as string | null))
  const tagsMap = await visibleTagsForUsers(unique)
  for (const p of page ?? []) {
    map.set(p.id as string, {
      id: p.id as string,
      username: (p.username as string) ?? '',
      fullName: (p.full_name as string) ?? '',
      birthday: (p.birthday as string | null) ?? null,
      appRole: (p.app_role as string | null) ?? null,
      bannedAt: (p.banned_at as string | null) ?? null,
      banReason: (p.ban_reason as string | null) ?? null,
      banDetails: (p.ban_details as string | null) ?? null,
      moderationHiddenAt: (p.moderation_hidden_at as string | null) ?? null,
      avatarUrl: p.avatar_storage_path
        ? urlMap.get(p.avatar_storage_path as string) ?? null
        : null,
      avatarUpdatedAt: (p.avatar_updated_at as string | null) ?? null,
      tags: tagsMap.get(p.id as string) ?? [],
      createdAt: (p.created_at as string | null) ?? null,
    })
  }
  return map
}

async function organizersForEvents(rows: EventRow[]): Promise<Map<string, AdminOrganizerDto>> {
  const out = new Map<string, AdminOrganizerDto>()
  const userIds = [...new Set(rows.map((r) => r.organizer_user_id).filter((id): id is string => Boolean(id)))]
  const communityIds = [
    ...new Set(rows.map((r) => r.organizer_community_id).filter((id): id is string => Boolean(id))),
  ]
  const [{ data: profiles }, { data: communities }] = await Promise.all([
    userIds.length
      ? supabaseAdmin
          .from('profiles')
          .select('id, full_name, username, avatar_storage_path, avatar_updated_at')
          .in('id', userIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    communityIds.length
      ? supabaseAdmin
          .from('communities')
          .select('id, name, avatar_storage_path, avatar_updated_at')
          .in('id', communityIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ])
  const userUrls = await avatarUrlsForPaths(
    (profiles ?? []).map((p) => p.avatar_storage_path as string | null),
  )
  const communityUrls = await communityAvatarUrlsForPaths(
    (communities ?? []).map((c) => c.avatar_storage_path as string | null),
  )
  const profileById = new Map((profiles ?? []).map((p) => [p.id as string, p]))
  const communityById = new Map((communities ?? []).map((c) => [c.id as string, c]))
  for (const row of rows) {
    if (row.organizer_user_id) {
      const profile = profileById.get(row.organizer_user_id)
      out.set(row.id, {
        type: 'user',
        id: row.organizer_user_id,
        name: (profile?.full_name as string) || (profile?.username as string) || 'User',
        avatarUrl: profile?.avatar_storage_path
          ? userUrls.get(profile.avatar_storage_path as string) ?? null
          : null,
        avatarUpdatedAt: (profile?.avatar_updated_at as string | null) ?? null,
      })
    } else if (row.organizer_community_id) {
      const community = communityById.get(row.organizer_community_id)
      out.set(row.id, {
        type: 'community',
        id: row.organizer_community_id,
        name: (community?.name as string) ?? 'Community',
        avatarUrl: community?.avatar_storage_path
          ? communityUrls.get(community.avatar_storage_path as string) ?? null
          : null,
        avatarUpdatedAt: (community?.avatar_updated_at as string | null) ?? null,
      })
    }
  }
  return out
}

/**
 * Map event rows to EventItem-shaped admin DTOs (covers, organizer, hashtags, counts).
 */
export async function adminEventDtosFromRows(rows: EventRow[]): Promise<AdminEventDto[]> {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const [coverMap, itemMap, organizers, { data: parts }] = await Promise.all([
    eventCoverUrlsForPaths(rows.map((r) => r.cover_storage_path)),
    hashtagItemsForEventIds(ids),
    organizersForEvents(rows),
    supabaseAdmin
      .from('event_participants')
      .select('event_id, status')
      .in('event_id', ids)
      .in('status', ['joined', 'interested']),
  ])
  const joined = new Map<string, number>()
  const interested = new Map<string, number>()
  for (const p of parts ?? []) {
    const eid = p.event_id as string
    if (p.status === 'joined') joined.set(eid, (joined.get(eid) ?? 0) + 1)
    if (p.status === 'interested') interested.set(eid, (interested.get(eid) ?? 0) + 1)
  }

  const dtos: AdminEventDto[] = []
  for (const row of rows) {
    const hashtagItems = itemMap.get(row.id) ?? []
    let coverUrl = row.cover_storage_path ? coverMap.get(row.cover_storage_path) ?? null : null
    let coverUpdatedAt = row.cover_updated_at ?? null
    if (!coverUrl && !row.cover_storage_path) {
      const groupCover = await resolveGroupCoverPathForEvent(row.id)
      if (groupCover) {
        coverUrl = await createHashtagGroupMediaUrl(groupCover.path)
        coverUpdatedAt = groupCover.updatedAt
      }
    }
    dtos.push({
      id: row.id,
      title: row.title,
      description: row.description,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      locationText: row.location_text,
      locationShortText: row.location_short_text,
      locationLat: row.location_lat,
      locationLng: row.location_lng,
      joinLimit: row.join_limit,
      joinedCount: joined.get(row.id) ?? 0,
      interestedCount: interested.get(row.id) ?? 0,
      myStatus: null,
      organizer: organizers.get(row.id) ?? {
        type: 'user',
        id: row.organizer_user_id ?? row.organizer_community_id ?? row.id,
        name: 'Unknown',
        avatarUrl: null,
        avatarUpdatedAt: null,
      },
      conversationId: row.conversation_id,
      chatArchivedAt: row.chat_archived_at,
      visibility: row.visibility,
      organizerConversationId: row.organizer_conversation_id ?? null,
      coverUrl,
      coverUpdatedAt,
      hashtags: hashtagItems.map((i) => i.slug),
      hashtagItems,
      canceledAt: row.canceled_at,
      moderationHiddenAt: row.moderation_hidden_at ?? null,
    })
  }
  return dtos
}

export async function adminEventsByIds(ids: string[]): Promise<Map<string, AdminEventDto>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const map = new Map<string, AdminEventDto>()
  if (!unique.length) return map
  const { data, error } = await supabaseAdmin.from('events').select(EVENT_SELECT).in('id', unique)
  if (error) throw error
  const dtos = await adminEventDtosFromRows((data ?? []) as EventRow[])
  for (const d of dtos) map.set(d.id, d)
  return map
}

export async function adminCommunitiesByIds(ids: string[]): Promise<Map<string, AdminCommunityDto>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const map = new Map<string, AdminCommunityDto>()
  if (!unique.length) return map
  const { data, error } = await supabaseAdmin
    .from('communities')
    .select(`${COMMUNITY_SELECT_CORE}, moderation_hidden_at`)
    .in('id', unique)
  if (error) throw error
  const page = data ?? []
  const pageIds = page.map((c) => c.id as string)
  const [urlMap, itemMap, counts] = await Promise.all([
    communityAvatarUrlsForPaths(page.map((c) => c.avatar_storage_path as string | null)),
    hashtagItemsForCommunityIds(pageIds),
    Promise.all(pageIds.map(async (id) => [id, await memberCount(id)] as const)),
  ])
  const countById = new Map(counts)
  for (const c of page) {
    const hashtagItems = itemMap.get(c.id as string) ?? []
    map.set(c.id as string, {
      id: c.id as string,
      name: c.name as string,
      identifier: c.identifier as string,
      description: (c.description as string | null) ?? null,
      joinMode: c.join_mode as string,
      avatarUrl: c.avatar_storage_path
        ? urlMap.get(c.avatar_storage_path as string) ?? null
        : null,
      avatarUpdatedAt: (c.avatar_updated_at as string | null) ?? null,
      memberCount: countById.get(c.id as string) ?? 0,
      myRoles: [],
      myStatus: null,
      createdBy: c.created_by as string,
      hashtags: hashtagItems.map((i) => i.slug),
      hashtagItems,
      moderationHiddenAt: (c.moderation_hidden_at as string | null) ?? null,
    })
  }
  return map
}

export async function adminMessagesByIds(ids: string[]): Promise<Map<string, AdminMessageDto>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const map = new Map<string, AdminMessageDto>()
  if (!unique.length) return map
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select(
      'id, conversation_id, sender_id, body, created_at, edited_at, deleted_at, moderation_hidden_at, message_attachments ( id, storage_path, mime_type, size_bytes, file_name )',
    )
    .in('id', unique)
  if (error) throw error
  const senderIds = [...new Set((data ?? []).map((m) => m.sender_id as string))]
  const senders = await adminUsersByIds(senderIds)
  for (const msg of data ?? []) {
    const attachments = []
    for (const att of msg.message_attachments ?? []) {
      let downloadUrl: string | null = null
      try {
        downloadUrl = await createSignedDownloadUrl(att.storage_path as string)
      } catch {
        downloadUrl = null
      }
      attachments.push({
        id: att.id as string,
        storage_path: att.storage_path as string,
        mime_type: att.mime_type as string,
        size_bytes: att.size_bytes as number,
        file_name: att.file_name as string,
        downloadUrl,
      })
    }
    map.set(msg.id as string, {
      id: msg.id as string,
      conversationId: msg.conversation_id as string,
      senderId: msg.sender_id as string,
      body: (msg.body as string | null) ?? null,
      createdAt: msg.created_at as string,
      editedAt: (msg.edited_at as string | null) ?? null,
      deletedAt: (msg.deleted_at as string | null) ?? null,
      moderationHiddenAt: (msg.moderation_hidden_at as string | null) ?? null,
      sender: senders.get(msg.sender_id as string) ?? null,
      message_attachments: attachments,
    })
  }
  return map
}
