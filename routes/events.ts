/**
 * Events HTTP API: list, create, detail, cover, RSVP, participants, edit, cancel, notify.
 * Layer: route. requireAuth. Mutations via supabaseAdmin. See `.cursor/rules/events.mdc`.
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { supabaseAdmin } from '../services/supabase.js'
import { avatarUrlsForPaths } from '../services/avatars.js'
import { communityAvatarUrlsForPaths } from '../services/communities.js'
import { notifyUsers } from '../services/notifications/dispatcher.js'
import { eventInviteNotification, eventNoticeNotification } from '../services/notifications/templates.js'
import {
  addEventChatMember,
  archiveEventChat,
  unarchiveEventChat,
  acceptedFriendIds,
  countJoined,
  createEventConversation,
  enableEventChatForSeries,
  EVENT_SELECT,
  EVENT_SELECT_CORE,
  removeEventChatMemberIfUnused,
  seriesChatStillOpen,
  seriesRootId,
  userCanSeeEvent,
  visibleEventsOrFilter,
  type EventRow,
  type ParticipantStatus,
} from '../services/events.js'
import {
  attachEventHashtags,
  findAllowedHashtagBySlug,
  hashtagItemsForEventIds,
  replaceEventHashtags,
  slugsForEventIds,
  type HashtagSuggestItem,
} from '../services/hashtags.js'
import { eventAllowedForViewer, globallyHiddenIds, hiddenIdsFor } from '../services/moderation.js'
import {
  createEventCoverDownloadUrl,
  eventCoverUrlsForPaths,
  processEventCover,
  uploadEventCover,
  validateEventCoverUpload,
} from '../services/eventCovers.js'
import { createHashtagGroupMediaUrl } from '../services/hashtagGroupMedia.js'
import { resolveGroupCoverPathForEvent } from '../services/tagPropagation.js'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'
import { normalizeHashtagSlug } from '../lib/hashtags.js'
import {
  createEventInviteLink,
  deleteEventInviteLink,
  getEnabledEventInviteLink,
  listEventInviteLinks,
  recordEventInviteJoin,
  setEventInviteLinkEnabled,
} from '../services/inviteLinks.js'
import {
  canManageCommunityEvents,
  canManageEvent,
  getEventRoles,
  grantEventRoles,
  isEventOrganizer,
  revokeEventRole,
  verifyUserPassword,
} from '../services/roles.js'
import { sendCreatorWelcomeMessage } from '../services/conversations.js'
import { matchesOriginFilter, type EventOriginKind } from '../lib/eventOrigin.js'

type EventVisibility = 'public' | 'friends' | 'community' | 'channel'

type CreateBody = {
  title?: string
  description?: string | null
  startsAt?: string
  endsAt?: string
  locationText?: string | null
  locationShortText?: string | null
  locationLat?: number | null
  locationLng?: number | null
  joinLimit?: number
  visibility?: EventVisibility
  friendUserIds?: string[]
  allFriends?: boolean
  hashtags?: string[]
  notifyInvites?: boolean
  /** When set, create as community-organized (requires manage_events). */
  organizerCommunityId?: string | null
  /** Channel-scoped community event (requires visibility=channel). */
  organizerConversationId?: string | null
  /** Opt-in. When true, create/enable event chat; omit/false on create → no chat. */
  createChat?: boolean
}

type PatchBody = CreateBody

type NotifyBody = {
  audience?: 'interested' | 'invited' | 'community'
}

type InviteBody = {
  username?: string
}

type OrganizerDto = {
  type: 'user' | 'community'
  id: string
  name: string
  avatarUrl: string | null
  avatarUpdatedAt: string | null
}

export type JoinedFriendDto = {
  id: string
  fullName: string | null
  username: string | null
  avatarUrl: string | null
  avatarUpdatedAt: string | null
}

export type ParticipantFriendDto = JoinedFriendDto & {
  status: ParticipantStatus
}

export type EventDto = {
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
  invitedCount: number
  /** Joined members of organizer community (0 when not community-organized). */
  communityJoinedCount: number
  myStatus: ParticipantStatus | null
  organizer: OrganizerDto
  conversationId: string | null
  chatArchivedAt: string | null
  visibility: EventVisibility
  /** Set when visibility=channel (community channel that scopes the event). */
  organizerConversationId: string | null
  coverUrl: string | null
  coverUpdatedAt: string | null
  hashtags: string[]
  /** Slug + group meta for chip icons (same order as hashtags). */
  hashtagItems: HashtagSuggestItem[]
  canceledAt: string | null
  updatedAt: string
  isRepeating: boolean
  isFavourite: boolean
  parentEventId: string | null
  occurrenceHistory?: { startsAt: string; endsAt: string }[]
  seriesOccurrences?: { id: string; startsAt: string; endsAt: string; isCurrent?: boolean }[]
  visibleFriendIds?: string[]
  /** Up to 5 accepted friends of the viewer who have joined. */
  joinedFriends?: JoinedFriendDto[]
  /** True when more than 5 accepted friends have joined. */
  joinedFriendsMore?: boolean
  /** Up to 5 accepted friends of the viewer who are interested. */
  interestedFriends?: JoinedFriendDto[]
  /** True when more than 5 accepted friends are interested. */
  interestedFriendsMore?: boolean
  /** Up to 5 accepted friends with any RSVP (incl. invited/denied) for calendar glows. */
  participantFriends?: ParticipantFriendDto[]
  participantFriendsMore?: boolean
}

function parseIso(value: string | undefined): Date | null {
  if (!value?.trim()) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function canceledMessage(ev: EventRow): string | null {
  return ev.canceled_at ? 'Event is canceled' : null
}

async function assertCanManageEvent(
  ev: EventRow,
  userId: string,
): Promise<true | { status: number; error: string }> {
  const ok = await canManageEvent(ev.id, userId, {
    organizerCommunityId: ev.organizer_community_id,
    organizerUserId: ev.organizer_user_id,
  })
  if (!ok) return { status: 403, error: 'Only an organizer or manager can do that' }
  return true
}

async function organizerName(userId: string): Promise<string> {
  const { data: me } = await supabaseAdmin
    .from('profiles')
    .select('full_name, username')
    .eq('id', userId)
    .maybeSingle()
  return me?.full_name || me?.username || 'Someone'
}

async function resolveFriendIds(
  userId: string,
  visibility: EventVisibility,
  body: { allFriends?: boolean; friendUserIds?: string[] },
): Promise<{ friendIds: string[]; error?: string }> {
  const requested = Array.isArray(body.friendUserIds) ? body.friendUserIds : []
  const wantsFriends = Boolean(body.allFriends) || requested.length > 0
  // Friends visibility always resolves; public/community only when ids/allFriends sent.
  if (visibility !== 'friends' && !wantsFriends) return { friendIds: [] }
  try {
    const accepted = await acceptedFriendIds(userId)
    const acceptedSet = new Set(accepted)
    if (body.allFriends) return { friendIds: accepted }
    const friendIds: string[] = []
    for (const id of requested) {
      if (typeof id !== 'string' || !acceptedSet.has(id)) {
        return { friendIds: [], error: 'Each selected user must be an accepted friend' }
      }
      if (!friendIds.includes(id)) friendIds.push(id)
    }
    return { friendIds }
  } catch {
    return { friendIds: [], error: 'Could not load friends' }
  }
}

/**
 * Internal community events: invitees must be joined community members (not necessarily friends).
 * Non-members in the request are dropped silently.
 */
async function resolveCommunityMemberInviteIds(
  userId: string,
  communityId: string,
  body: { allFriends?: boolean; friendUserIds?: string[] },
): Promise<{ friendIds: string[]; error?: string }> {
  const requested = Array.isArray(body.friendUserIds) ? body.friendUserIds : []
  const wants = Boolean(body.allFriends) || requested.length > 0
  if (!wants) return { friendIds: [] }
  try {
    const { data: members, error } = await supabaseAdmin
      .from('community_members')
      .select('user_id')
      .eq('community_id', communityId)
      .eq('status', 'joined')
    if (error) return { friendIds: [], error: 'Could not load community members' }
    const memberSet = new Set(
      (members ?? [])
        .map((m) => m.user_id as string)
        .filter((id) => id !== userId),
    )
    if (body.allFriends) return { friendIds: [...memberSet] }
    const friendIds: string[] = []
    for (const id of requested) {
      if (typeof id === 'string' && memberSet.has(id) && !friendIds.includes(id)) {
        friendIds.push(id)
      }
    }
    return { friendIds }
  } catch {
    return { friendIds: [], error: 'Could not load community members' }
  }
}

/** Channel-scoped events: invitees are conversation members only. */
async function resolveChannelMemberInviteIds(
  userId: string,
  conversationId: string,
  body: { allFriends?: boolean; friendUserIds?: string[] },
): Promise<{ friendIds: string[]; error?: string }> {
  const requested = Array.isArray(body.friendUserIds) ? body.friendUserIds : []
  const wants = Boolean(body.allFriends) || requested.length > 0
  if (!wants) return { friendIds: [] }
  try {
    const { data: members, error } = await supabaseAdmin
      .from('conversation_members')
      .select('user_id')
      .eq('conversation_id', conversationId)
    if (error) return { friendIds: [], error: 'Could not load channel members' }
    const memberSet = new Set(
      (members ?? [])
        .map((m) => m.user_id as string)
        .filter((id) => id !== userId),
    )
    if (body.allFriends) return { friendIds: [...memberSet] }
    const friendIds: string[] = []
    for (const id of requested) {
      if (typeof id === 'string' && memberSet.has(id) && !friendIds.includes(id)) {
        friendIds.push(id)
      }
    }
    return { friendIds }
  } catch {
    return { friendIds: [], error: 'Could not load channel members' }
  }
}

/** Assert conversation is a community channel of `communityId`; caller may scope to it. */
async function assertCommunityChannel(
  communityId: string,
  conversationId: string,
  userId: string,
): Promise<{ status: number; error: string } | null> {
  const { data: link } = await supabaseAdmin
    .from('community_conversations')
    .select('conversation_id')
    .eq('community_id', communityId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (!link) {
    return { status: 400, error: 'Channel must belong to the organizer community' }
  }
  const { data: member } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle()
  if (member) return null
  const { data: roles } = await supabaseAdmin
    .from('community_member_roles')
    .select('role')
    .eq('community_id', communityId)
    .eq('user_id', userId)
  const slugs = (roles ?? []).map((r) => r.role as string)
  if (slugs.includes('admin') || slugs.includes('manage_community')) return null
  return { status: 403, error: 'You must be a member of that channel' }
}

async function resolveEventInviteeIds(
  userId: string,
  visibility: EventVisibility,
  organizerCommunityId: string | null,
  organizerConversationId: string | null,
  body: { allFriends?: boolean; friendUserIds?: string[] },
): Promise<{ friendIds: string[]; error?: string }> {
  if (organizerCommunityId && visibility === 'channel' && organizerConversationId) {
    return resolveChannelMemberInviteIds(userId, organizerConversationId, body)
  }
  if (organizerCommunityId && visibility === 'community') {
    return resolveCommunityMemberInviteIds(userId, organizerCommunityId, body)
  }
  return resolveFriendIds(userId, visibility, body)
}

function parseHashtagInput(raw: unknown): { slugs: string[]; error?: string } {
  const hashtagInput = Array.isArray(raw) ? raw : []
  if (hashtagInput.length > 3) return { slugs: [], error: 'At most 3 hashtags' }
  const slugs: string[] = []
  for (const item of hashtagInput) {
    if (typeof item !== 'string' || !normalizeHashtagSlug(item)) {
      return { slugs: [], error: 'Invalid hashtag' }
    }
    slugs.push(item)
  }
  return { slugs }
}

async function organizerFor(row: EventRow): Promise<OrganizerDto> {
  if (row.organizer_user_id) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, username, avatar_storage_path, avatar_updated_at')
      .eq('id', row.organizer_user_id)
      .maybeSingle()
    const urls = await avatarUrlsForPaths([profile?.avatar_storage_path ?? null])
    return {
      type: 'user',
      id: row.organizer_user_id,
      name: profile?.full_name || profile?.username || 'User',
      avatarUrl: profile?.avatar_storage_path
        ? urls.get(profile.avatar_storage_path) ?? null
        : null,
      avatarUpdatedAt: profile?.avatar_updated_at ?? null,
    }
  }
  const { data: community } = await supabaseAdmin
    .from('communities')
    .select('id, name, avatar_storage_path, avatar_updated_at')
    .eq('id', row.organizer_community_id)
    .maybeSingle()
  const urls = await communityAvatarUrlsForPaths([community?.avatar_storage_path ?? null])
  return {
    type: 'community',
    id: row.organizer_community_id!,
    name: community?.name ?? 'Community',
    avatarUrl: community?.avatar_storage_path
      ? urls.get(community.avatar_storage_path) ?? null
      : null,
    avatarUpdatedAt: community?.avatar_updated_at ?? null,
  }
}

/**
 * Batch: accepted friends of `userId` with the given RSVP status on each event (cap 5 + more flag).
 * Pass `friendIds` when batching multiple statuses to avoid reloading friendships.
 */
async function friendsByEventIds(
  eventIds: string[],
  userId: string,
  status: 'joined' | 'interested',
  friendIds?: string[],
): Promise<Map<string, { friends: JoinedFriendDto[]; more: boolean }>> {
  const out = new Map<string, { friends: JoinedFriendDto[]; more: boolean }>()
  for (const id of eventIds) out.set(id, { friends: [], more: false })
  if (!eventIds.length) return out

  const idsFriends = friendIds ?? (await acceptedFriendIds(userId))
  if (!idsFriends.length) return out

  const { data: parts, error } = await supabaseAdmin
    .from('event_participants')
    .select('event_id, user_id')
    .in('event_id', eventIds)
    .eq('status', status)
    .in('user_id', idsFriends)
    .order('user_id', { ascending: true })
  if (error || !parts?.length) return out

  const userIdSet = new Set((parts ?? []).map((p) => p.user_id as string))
  const ids = [...userIdSet]
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, username, avatar_storage_path, avatar_updated_at')
    .in('id', ids)
  const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]))
  const urls = await avatarUrlsForPaths(
    (profiles ?? []).map((p) => (p.avatar_storage_path as string | null) ?? null),
  )

  const grouped = new Map<string, string[]>()
  for (const p of parts) {
    const eid = p.event_id as string
    const uid = p.user_id as string
    const list = grouped.get(eid) ?? []
    list.push(uid)
    grouped.set(eid, list)
  }

  for (const [eid, uids] of grouped) {
    const more = uids.length > 5
    const slice = uids.slice(0, 5)
    const friends: JoinedFriendDto[] = slice.map((id) => {
      const prof = byId.get(id)
      const path = (prof?.avatar_storage_path as string | null) ?? null
      return {
        id,
        fullName: (prof?.full_name as string | null) ?? null,
        username: (prof?.username as string | null) ?? null,
        avatarUrl: path ? urls.get(path) ?? null : null,
        avatarUpdatedAt: (prof?.avatar_updated_at as string | null) ?? null,
      }
    })
    out.set(eid, { friends, more })
  }
  return out
}

const PARTICIPANT_FRIEND_STATUS_ORDER: ParticipantStatus[] = [
  'joined',
  'interested',
  'invited',
  'denied',
]

/**
 * Accepted friends with any RSVP on each event (cap 5 + more), for calendar status glows.
 */
async function participantFriendsByEventIds(
  eventIds: string[],
  userId: string,
  friendIds?: string[],
): Promise<Map<string, { friends: ParticipantFriendDto[]; more: boolean }>> {
  const out = new Map<string, { friends: ParticipantFriendDto[]; more: boolean }>()
  for (const id of eventIds) out.set(id, { friends: [], more: false })
  if (!eventIds.length) return out

  const idsFriends = friendIds ?? (await acceptedFriendIds(userId))
  if (!idsFriends.length) return out

  const { data: parts, error } = await supabaseAdmin
    .from('event_participants')
    .select('event_id, user_id, status')
    .in('event_id', eventIds)
    .in('status', PARTICIPANT_FRIEND_STATUS_ORDER)
    .in('user_id', idsFriends)
  if (error || !parts?.length) return out

  const userIdSet = new Set((parts ?? []).map((p) => p.user_id as string))
  const ids = [...userIdSet]
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, username, avatar_storage_path, avatar_updated_at')
    .in('id', ids)
  const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]))
  const urls = await avatarUrlsForPaths(
    (profiles ?? []).map((p) => (p.avatar_storage_path as string | null) ?? null),
  )

  const grouped = new Map<string, { user_id: string; status: ParticipantStatus }[]>()
  for (const p of parts) {
    const eid = p.event_id as string
    const list = grouped.get(eid) ?? []
    list.push({
      user_id: p.user_id as string,
      status: p.status as ParticipantStatus,
    })
    grouped.set(eid, list)
  }

  for (const [eid, rows] of grouped) {
    rows.sort((a, b) => {
      const ai = PARTICIPANT_FRIEND_STATUS_ORDER.indexOf(a.status)
      const bi = PARTICIPANT_FRIEND_STATUS_ORDER.indexOf(b.status)
      if (ai !== bi) return ai - bi
      return a.user_id.localeCompare(b.user_id)
    })
    const more = rows.length > 5
    const slice = rows.slice(0, 5)
    const friends: ParticipantFriendDto[] = slice.map((r) => {
      const prof = byId.get(r.user_id)
      const path = (prof?.avatar_storage_path as string | null) ?? null
      return {
        id: r.user_id,
        fullName: (prof?.full_name as string | null) ?? null,
        username: (prof?.username as string | null) ?? null,
        avatarUrl: path ? urls.get(path) ?? null : null,
        avatarUpdatedAt: (prof?.avatar_updated_at as string | null) ?? null,
        status: r.status,
      }
    })
    out.set(eid, { friends, more })
  }
  return out
}

async function toDto(
  row: EventRow,
  userId: string,
  extras?: {
    coverUrl?: string | null
    coverUpdatedAt?: string | null
    hashtags?: string[]
    hashtagItems?: HashtagSuggestItem[]
    isFavourite?: boolean
    occurrenceHistory?: { startsAt: string; endsAt: string }[]
    seriesOccurrences?: { id: string; startsAt: string; endsAt: string; isCurrent?: boolean }[]
    includeHistory?: boolean
    joinedFriends?: JoinedFriendDto[]
    joinedFriendsMore?: boolean
    interestedFriends?: JoinedFriendDto[]
    interestedFriendsMore?: boolean
    participantFriends?: ParticipantFriendDto[]
    participantFriendsMore?: boolean
  },
): Promise<EventDto> {
  const [
    { count: joinedCount },
    { count: interestedCount },
    { count: invitedCount },
    { data: mine },
    organizer,
  ] = await Promise.all([
    supabaseAdmin
      .from('event_participants')
      .select('user_id', { count: 'exact', head: true })
      .eq('event_id', row.id)
      .eq('status', 'joined'),
    supabaseAdmin
      .from('event_participants')
      .select('user_id', { count: 'exact', head: true })
      .eq('event_id', row.id)
      .eq('status', 'interested'),
    supabaseAdmin
      .from('event_participants')
      .select('user_id', { count: 'exact', head: true })
      .eq('event_id', row.id)
      .eq('status', 'invited'),
    supabaseAdmin
      .from('event_participants')
      .select('status')
      .eq('event_id', row.id)
      .eq('user_id', userId)
      .maybeSingle(),
    organizerFor(row),
  ])

  let coverUrl = extras?.coverUrl ?? null
  let coverUpdatedAt =
    extras?.coverUpdatedAt !== undefined
      ? extras.coverUpdatedAt
      : ((row.cover_updated_at as string | null) ?? null)
  if (coverUrl === undefined || (coverUrl === null && row.cover_storage_path && extras === undefined)) {
    coverUrl = row.cover_storage_path
      ? await createEventCoverDownloadUrl(row.cover_storage_path)
      : null
  }
  if (!coverUrl && !row.cover_storage_path && extras?.coverUrl === undefined) {
    const groupCover = await resolveGroupCoverPathForEvent(row.id)
    if (groupCover) {
      coverUrl = await createHashtagGroupMediaUrl(groupCover.path)
      coverUpdatedAt = groupCover.updatedAt
    }
  }

  let hashtagItems = extras?.hashtagItems
  if (!hashtagItems) {
    const map = await hashtagItemsForEventIds([row.id])
    hashtagItems = map.get(row.id) ?? []
  }
  const hashtags = extras?.hashtags ?? hashtagItems.map((i) => i.slug)

  let isFavourite = extras?.isFavourite
  if (isFavourite === undefined) {
    const { data: fav, error: favErr } = await supabaseAdmin
      .from('event_favourites')
      .select('event_id')
      .eq('event_id', row.id)
      .eq('user_id', userId)
      .maybeSingle()
    isFavourite = !favErr && Boolean(fav)
  }

  let occurrenceHistory = extras?.occurrenceHistory
  let seriesOccurrences = extras?.seriesOccurrences

  if (extras?.includeHistory) {
    const rootId = seriesRootId(row)
    if (seriesOccurrences === undefined) {
      const { data: seriesRows } = await supabaseAdmin
        .from('events')
        .select('id, starts_at, ends_at, parent_event_id')
        .or(`id.eq.${rootId},parent_event_id.eq.${rootId}`)
        .order('starts_at', { ascending: true })
        .limit(50)
      seriesOccurrences = (seriesRows ?? []).map((s) => ({
        id: s.id as string,
        startsAt: s.starts_at as string,
        endsAt: s.ends_at as string,
        isCurrent: s.id === row.id,
      }))
      // Only expose when there is more than one occurrence (a real series).
      if (seriesOccurrences.length <= 1) seriesOccurrences = undefined
    }

    if (occurrenceHistory === undefined) {
      const { data: hist } = await supabaseAdmin
        .from('event_occurrence_history')
        .select('starts_at, ends_at')
        .eq('event_id', rootId)
        .order('starts_at', { ascending: false })
        .limit(20)
      occurrenceHistory = (hist ?? []).map((h) => ({
        startsAt: h.starts_at as string,
        endsAt: h.ends_at as string,
      }))
      if (!occurrenceHistory.length) occurrenceHistory = undefined
    }
  }

  let visibleFriendIds: string[] | undefined
  if (row.organizer_user_id === userId && row.visibility === 'friends') {
    const { data: vis } = await supabaseAdmin
      .from('event_visible_friends')
      .select('user_id')
      .eq('event_id', row.id)
    visibleFriendIds = (vis ?? []).map((r) => r.user_id as string)
  }

  let communityJoinedCount = 0
  if (row.organizer_community_id) {
    const { count } = await supabaseAdmin
      .from('community_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('community_id', row.organizer_community_id)
      .eq('status', 'joined')
    communityJoinedCount = count ?? 0
  }

  let joinedFriends = extras?.joinedFriends
  let joinedFriendsMore = extras?.joinedFriendsMore
  let interestedFriends = extras?.interestedFriends
  let interestedFriendsMore = extras?.interestedFriendsMore
  let participantFriends = extras?.participantFriends
  let participantFriendsMore = extras?.participantFriendsMore
  if (
    joinedFriends === undefined ||
    interestedFriends === undefined ||
    participantFriends === undefined
  ) {
    const ids = [row.id]
    const friendIds = await acceptedFriendIds(userId)
    const [joinedMap, interestedMap, participantMap] = await Promise.all([
      joinedFriends === undefined
        ? friendsByEventIds(ids, userId, 'joined', friendIds)
        : null,
      interestedFriends === undefined
        ? friendsByEventIds(ids, userId, 'interested', friendIds)
        : null,
      participantFriends === undefined
        ? participantFriendsByEventIds(ids, userId, friendIds)
        : null,
    ])
    if (joinedMap) {
      const entry = joinedMap.get(row.id) ?? { friends: [], more: false }
      joinedFriends = entry.friends
      joinedFriendsMore = entry.more
    }
    if (interestedMap) {
      const entry = interestedMap.get(row.id) ?? { friends: [], more: false }
      interestedFriends = entry.friends
      interestedFriendsMore = entry.more
    }
    if (participantMap) {
      const entry = participantMap.get(row.id) ?? { friends: [], more: false }
      participantFriends = entry.friends
      participantFriendsMore = entry.more
    }
  }
  joinedFriends = joinedFriends ?? []
  interestedFriends = interestedFriends ?? []
  participantFriends = participantFriends ?? []

  return {
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
    joinedCount: joinedCount ?? 0,
    interestedCount: interestedCount ?? 0,
    invitedCount: invitedCount ?? 0,
    communityJoinedCount,
    myStatus: (mine?.status as ParticipantStatus | undefined) ?? null,
    organizer,
    conversationId: row.conversation_id,
    chatArchivedAt: row.chat_archived_at,
    visibility: row.visibility,
    organizerConversationId: row.organizer_conversation_id ?? null,
    coverUrl,
    coverUpdatedAt,
    hashtags,
    hashtagItems,
    canceledAt: row.canceled_at,
    updatedAt: row.updated_at,
    isRepeating: Boolean(row.is_repeating),
    isFavourite: Boolean(isFavourite),
    parentEventId: row.parent_event_id ?? null,
    ...(occurrenceHistory ? { occurrenceHistory } : {}),
    ...(seriesOccurrences ? { seriesOccurrences } : {}),
    ...(visibleFriendIds ? { visibleFriendIds } : {}),
    ...(joinedFriends.length ? { joinedFriends } : {}),
    ...(joinedFriendsMore ? { joinedFriendsMore: true } : {}),
    ...(interestedFriends.length ? { interestedFriends } : {}),
    ...(interestedFriendsMore ? { interestedFriendsMore: true } : {}),
    ...(participantFriends.length ? { participantFriends } : {}),
    ...(participantFriendsMore ? { participantFriendsMore: true } : {}),
  }
}

function eventSelectFull() {
  return supabaseAdmin.from('events').select(EVENT_SELECT)
}

function eventSelectCore() {
  return supabaseAdmin.from('events').select(EVENT_SELECT_CORE)
}

/** Prefer full select (series columns). Soft-fallback in list path uses CORE. */
function eventSelect() {
  return eventSelectFull()
}

function isMissingSeriesColumnError(err: { message?: string; code?: string } | null): boolean {
  const msg = (err?.message ?? '').toLowerCase()
  return (
    msg.includes('is_repeating') ||
    msg.includes('parent_event_id') ||
    msg.includes('moderation_hidden_at')
  )
}

/** Loose builder so CORE/full select share one soft-fallback path. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventSelectBuilder = (q: any) => any

async function runEventSelect(
  build: EventSelectBuilder,
): Promise<{ rows: EventRow[]; error: { message?: string; code?: string } | null }> {
  const first = await build(eventSelectFull())
  if (first.error && isMissingSeriesColumnError(first.error)) {
    console.error(
      '[events] EVENT_SELECT missing series cols; retrying CORE',
      first.error.message,
      first.error.code,
    )
    const second = await build(eventSelectCore())
    if (second.error) return { rows: [], error: second.error }
    return { rows: (second.data ?? []) as EventRow[], error: null }
  }
  if (first.error) return { rows: [], error: first.error }
  return { rows: (first.data ?? []) as EventRow[], error: null }
}

async function toDtoPage(rows: EventRow[], userId: string): Promise<EventDto[]> {
  const coverMap = await eventCoverUrlsForPaths(rows.map((r) => r.cover_storage_path))
  const itemMap = await hashtagItemsForEventIds(rows.map((r) => r.id))
  const groupCoverByEvent = new Map<string, { url: string; updatedAt: string | null }>()
  await Promise.all(
    rows
      .filter((r) => !r.cover_storage_path)
      .map(async (r) => {
        try {
          const groupCover = await resolveGroupCoverPathForEvent(r.id)
          if (!groupCover) return
          const url = await createHashtagGroupMediaUrl(groupCover.path)
          if (url) groupCoverByEvent.set(r.id, { url, updatedAt: groupCover.updatedAt })
        } catch (e) {
          console.error('[events] group cover for', r.id, e)
        }
      }),
  )
  const favIds = new Set<string>()
  if (rows.length) {
    const { data: favs, error: favErr } = await supabaseAdmin
      .from('event_favourites')
      .select('event_id')
      .eq('user_id', userId)
      .in(
        'event_id',
        rows.map((r) => r.id),
      )
    // Table may be missing until migration is applied — treat as no favourites.
    if (!favErr) {
      for (const f of favs ?? []) favIds.add(f.event_id as string)
    }
  }
  const eventIds = rows.map((r) => r.id)
  const friendIds = await acceptedFriendIds(userId)
  const [joinedMap, interestedMap, participantMap] = await Promise.all([
    friendsByEventIds(eventIds, userId, 'joined', friendIds),
    friendsByEventIds(eventIds, userId, 'interested', friendIds),
    participantFriendsByEventIds(eventIds, userId, friendIds),
  ])
  return Promise.all(
    rows.map((row) => {
      const jf = joinedMap.get(row.id) ?? { friends: [], more: false }
      const intf = interestedMap.get(row.id) ?? { friends: [], more: false }
      const pf = participantMap.get(row.id) ?? { friends: [], more: false }
      const ownCover = row.cover_storage_path
        ? coverMap.get(row.cover_storage_path) ?? null
        : null
      const group = groupCoverByEvent.get(row.id)
      const items = itemMap.get(row.id) ?? []
      return toDto(row, userId, {
        coverUrl: ownCover ?? group?.url ?? null,
        coverUpdatedAt: ownCover
          ? (row.cover_updated_at as string | null)
          : (group?.updatedAt ?? null),
        hashtags: items.map((i) => i.slug),
        hashtagItems: items,
        isFavourite: favIds.has(row.id),
        joinedFriends: jf.friends,
        joinedFriendsMore: jf.more,
        interestedFriends: intf.friends,
        interestedFriendsMore: intf.more,
        participantFriends: pf.friends,
        participantFriendsMore: pf.more,
      })
    }),
  )
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function parseIdList(raw: string | undefined): { ids: string[] } | { error: string } {
  if (!raw?.trim()) return { ids: [] }
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
  if (ids.length > 50) return { error: 'At most 50 ids' }
  for (const id of ids) {
    if (!UUID_RE.test(id)) return { error: 'Invalid id' }
  }
  return { ids }
}

/**
 * Visible event rows for list/stamps. `ids` skips cursor pagination.
 */
async function queryVisibleEventRows(
  userId: string,
  opts: { limit: number; cursor?: string | undefined; q?: string; ids?: string[] | undefined; communityId?: string | undefined },
): Promise<{ rows: EventRow[]; extra: boolean } | { error: string; status: number }> {
  let orFilter: string
  try {
    orFilter = await visibleEventsOrFilter(userId)
  } catch (e) {
    console.error('[events] visibleEventsOrFilter', e)
    return { error: 'Could not list events', status: 500 }
  }

  if (opts.ids && opts.ids.length > 0) {
    const { rows, error } = await runEventSelect((q) => q.or(orFilter).in('id', opts.ids!))
    if (error) {
      console.error('[events] list by ids', error.message, error.code)
      return { error: 'Could not list events', status: 500 }
    }
    const hides = await hiddenIdsFor(userId, 'event')
    const kept: EventRow[] = []
    for (const row of rows) {
      if (await eventAllowedForViewer(row, userId, hides)) kept.push(row)
    }
    return { rows: kept, extra: false }
  }

  const q = (opts.q ?? '').trim()
  let tagIds: string[] | null = null

  if (q.startsWith('#')) {
    try {
      const tag = await findAllowedHashtagBySlug(q)
      if (!tag) return { rows: [], extra: false }
      const { data: links, error: linkErr } = await supabaseAdmin
        .from('event_hashtags')
        .select('event_id')
        .eq('hashtag_id', tag.id)
      if (linkErr) throw linkErr
      tagIds = [...new Set((links ?? []).map((l) => l.event_id as string))]
      if (tagIds.length === 0) return { rows: [], extra: false }
    } catch (e) {
      console.error('[events] hashtag filter', e)
      return { error: 'Could not list events', status: 500 }
    }
  }

  const { rows: page, error } = await runEventSelect((base) => {
    let query = base.or(orFilter).order('starts_at', { ascending: false }).limit(opts.limit + 1)
    if (opts.cursor) query = query.lt('starts_at', opts.cursor)
    if (opts.communityId) query = query.eq('organizer_community_id', opts.communityId)
    if (tagIds) query = query.in('id', tagIds)
    else if (q) {
      const safe = q.replace(/[%_,]/g, '')
      query = query.ilike('title', `%${safe}%`)
    }
    return query
  })
  if (error) {
    console.error('[events] list query', error.message, error.code)
    return { error: 'Could not list events', status: 500 }
  }
  const extra = page.length > opts.limit
  const sliced = extra ? page.slice(0, opts.limit) : page
  const hides = await hiddenIdsFor(userId, 'event')
  const kept: EventRow[] = []
  for (const row of sliced) {
    if (await eventAllowedForViewer(row, userId, hides)) kept.push(row)
  }
  return { rows: kept, extra }
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

type AgendaKind = 'all' | 'friends' | 'groups' | 'events'

function parseDateOnly(value: string | undefined): Date | null {
  if (!value?.trim() || !DATE_ONLY_RE.test(value.trim())) return null
  const d = new Date(`${value.trim()}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

function parseAgendaKind(raw: string | undefined): AgendaKind | null {
  const kind = (raw ?? 'all').trim()
  if (kind === 'all' || kind === 'friends' || kind === 'groups' || kind === 'events') return kind
  return null
}

function agendaKindToOrigin(kind: AgendaKind): EventOriginKind | 'all' {
  if (kind === 'groups') return 'group'
  if (kind === 'events') return 'event'
  if (kind === 'friends') return 'friends'
  return 'all'
}

function rowMatchesAgendaKind(row: EventRow, kind: AgendaKind): boolean {
  if (kind === 'all') return true
  return matchesOriginFilter(
    {
      visibility: row.visibility,
      organizer: { type: row.organizer_community_id ? 'community' : 'user' },
    },
    agendaKindToOrigin(kind),
  )
}

/** Visible events overlapping a local date range (MyTime agenda). */
async function queryAgendaRows(
  userId: string,
  from: string,
  to: string,
  kind: AgendaKind,
): Promise<{ rows: EventRow[] } | { error: string; status: number }> {
  let orFilter: string
  try {
    orFilter = await visibleEventsOrFilter(userId)
  } catch {
    return { error: 'Could not load agenda', status: 500 }
  }
  const rangeStart = new Date(`${from}T00:00:00`)
  const rangeEnd = new Date(`${to}T23:59:59.999`)
  const { data: rows, error } = await eventSelect()
    .or(orFilter)
    .lt('starts_at', rangeEnd.toISOString())
    .gt('ends_at', rangeStart.toISOString())
    .order('starts_at', { ascending: true })
    .limit(200)
  if (error) return { error: 'Could not load agenda', status: 500 }
  const hides = await hiddenIdsFor(userId, 'event')
  const visible: EventRow[] = []
  for (const row of (rows ?? []) as EventRow[]) {
    if (await eventAllowedForViewer(row, userId, hides)) visible.push(row)
  }
  const filtered = visible.filter((row) => rowMatchesAgendaKind(row, kind))
  return { rows: filtered }
}

export async function eventRoutes(app: FastifyInstance) {
  /**
   * GET `/events` — paginated events the caller can see.
   * `ids` (comma UUIDs) returns those visible rows as full DTOs (no cursor).
   */
  app.get<{ Querystring: { limit?: string; cursor?: string; q?: string; ids?: string; communityId?: string } }>(
    '/events',
    { preHandler: requireAuth },
    async (request, reply) => {
      const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)
      const cursor = request.query.cursor?.trim()
      const q = (request.query.q ?? '').trim()
      const communityId = request.query.communityId?.trim()
      if (exceedsLimit(q, TEXT_LIMITS.search)) {
        return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.search} characters` })
      }
      const parsedIds = parseIdList(request.query.ids)
      if ('error' in parsedIds) return reply.code(400).send({ error: parsedIds.error })

      const listed = await queryVisibleEventRows(request.userId, {
        limit,
        cursor,
        q,
        ids: parsedIds.ids.length ? parsedIds.ids : undefined,
        communityId,
      })
      if ('error' in listed) return reply.code(listed.status).send({ error: listed.error })

      const events = await toDtoPage(listed.rows, request.userId)
      return {
        events,
        nextCursor:
          listed.extra && !parsedIds.ids.length
            ? listed.rows[listed.rows.length - 1]?.starts_at ?? null
            : null,
      }
    },
  )

  /**
   * GET `/events/stamps` — id + updatedAt + startsAt only (cache invalidation).
   */
  app.get<{ Querystring: { limit?: string; cursor?: string; q?: string; ids?: string } }>(
    '/events/stamps',
    { preHandler: requireAuth },
    async (request, reply) => {
      const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)
      const cursor = request.query.cursor?.trim()
      const q = (request.query.q ?? '').trim()
      if (exceedsLimit(q, TEXT_LIMITS.search)) {
        return reply.code(400).send({ error: `Query must be at most ${TEXT_LIMITS.search} characters` })
      }
      const parsedIds = parseIdList(request.query.ids)
      if ('error' in parsedIds) return reply.code(400).send({ error: parsedIds.error })

      const listed = await queryVisibleEventRows(request.userId, {
        limit,
        cursor,
        q,
        ids: parsedIds.ids.length ? parsedIds.ids : undefined,
      })
      if ('error' in listed) return reply.code(listed.status).send({ error: listed.error })

      return {
        events: listed.rows.map((row) => ({
          id: row.id,
          updatedAt: row.updated_at,
          startsAt: row.starts_at,
        })),
        nextCursor:
          listed.extra && !parsedIds.ids.length
            ? listed.rows[listed.rows.length - 1]?.starts_at ?? null
            : null,
      }
    },
  )

  /**
   * GET `/events/agenda` — events in a date window for MyTime calendar (no cursor).
   */
  app.get<{ Querystring: { from?: string; to?: string; kind?: string } }>(
    '/events/agenda',
    { preHandler: requireAuth },
    async (request, reply) => {
      const from = request.query.from?.trim() ?? ''
      const to = request.query.to?.trim() ?? ''
      const kind = parseAgendaKind(request.query.kind)
      if (!parseDateOnly(from) || !parseDateOnly(to)) {
        return reply.code(400).send({ error: 'from and to must be YYYY-MM-DD' })
      }
      if (from > to) return reply.code(400).send({ error: 'from must be on or before to' })
      if (!kind) return reply.code(400).send({ error: 'Invalid kind' })

      const listed = await queryAgendaRows(request.userId, from, to, kind)
      if ('error' in listed) return reply.code(listed.status).send({ error: listed.error })

      const events = await toDtoPage(listed.rows, request.userId)
      return { events }
    },
  )

  /**
   * GET `/events/past` — past events the user can edit (Last) or favourites.
   * Last: up to 10 past non-canceled events where user is organizer / manage_event /
   * community admin|manage_events.
   */
  app.get<{ Querystring: { filter?: string; limit?: string; cursor?: string } }>(
    '/events/past',
    { preHandler: requireAuth },
    async (request, reply) => {
      const filter = (request.query.filter ?? 'last').trim()
      if (filter !== 'last' && filter !== 'favourite') {
        return reply.code(400).send({ error: 'filter must be last or favourite' })
      }
      const nowIso = new Date().toISOString()
      const userId = request.userId

      if (filter === 'last') {
        const idSet = new Set<string>()

        const { data: asOrganizer } = await supabaseAdmin
          .from('events')
          .select('id')
          .eq('organizer_user_id', userId)
          .is('canceled_at', null)
          .lt('ends_at', nowIso)
          .order('ends_at', { ascending: false })
          .limit(30)
        for (const r of asOrganizer ?? []) idSet.add(r.id as string)

        const { data: roleRows } = await supabaseAdmin
          .from('event_member_roles')
          .select('event_id')
          .eq('user_id', userId)
          .in('role', ['organizer', 'manage_event'])
        const roleEventIds = [...new Set((roleRows ?? []).map((r) => r.event_id as string))]
        if (roleEventIds.length) {
          const { data: roleEvents } = await supabaseAdmin
            .from('events')
            .select('id')
            .in('id', roleEventIds)
            .is('canceled_at', null)
            .lt('ends_at', nowIso)
          for (const r of roleEvents ?? []) idSet.add(r.id as string)
        }

        const { data: manageRoles } = await supabaseAdmin
          .from('community_member_roles')
          .select('community_id')
          .eq('user_id', userId)
          .in('role', ['admin', 'manage_events'])
        const communityIds = [
          ...new Set((manageRoles ?? []).map((r) => r.community_id as string)),
        ]
        if (communityIds.length) {
          const { data: communityEvents } = await supabaseAdmin
            .from('events')
            .select('id')
            .in('organizer_community_id', communityIds)
            .is('canceled_at', null)
            .lt('ends_at', nowIso)
            .order('ends_at', { ascending: false })
            .limit(30)
          for (const r of communityEvents ?? []) idSet.add(r.id as string)
        }

        const ids = [...idSet]
        if (!ids.length) return { events: [], nextCursor: null }

        const { data: rows, error } = await eventSelect()
          .in('id', ids)
          .is('canceled_at', null)
          .lt('ends_at', nowIso)
          .order('ends_at', { ascending: false })
          .limit(10)
        if (error) {
          request.log.error(error)
          return reply.code(500).send({ error: 'Could not load past events' })
        }
        const events = await toDtoPage((rows ?? []) as EventRow[], userId)
        return { events, nextCursor: null }
      }

      const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 50)
      const cursor = request.query.cursor?.trim() || null

      let favQuery = supabaseAdmin
        .from('event_favourites')
        .select('event_id, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit + 1)
      if (cursor) favQuery = favQuery.lt('created_at', cursor)

      const { data: favRows, error: favErr } = await favQuery
      if (favErr) {
        request.log.error(favErr)
        return reply.code(500).send({ error: 'Could not load favourites' })
      }
      const page = favRows ?? []
      const extra = page.length > limit
      const slice = extra ? page.slice(0, limit) : page
      const favIds = slice.map((r) => r.event_id as string)
      if (!favIds.length) return { events: [], nextCursor: null }

      const { data: rows, error } = await eventSelect().in('id', favIds)
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not load favourites' })
      }
      const byId = new Map((rows ?? []).map((r) => [r.id as string, r as EventRow]))
      const ordered = favIds.map((id) => byId.get(id)).filter((r): r is EventRow => Boolean(r))
      const events = await toDtoPage(ordered, userId)
      return {
        events,
        nextCursor: extra ? slice[slice.length - 1]?.created_at ?? null : null,
      }
    },
  )

  /**
   * POST `/events` — create user-organized event + event chat.
   */
  app.post<{ Body: CreateBody }>('/events', { preHandler: requireAuth }, async (request, reply) => {
    const title = request.body?.title?.trim() ?? ''
    const descriptionRaw = request.body?.description?.trim() ?? ''
    const description = descriptionRaw.length > 0 ? descriptionRaw : null
    const starts = parseIso(request.body?.startsAt)
    const ends = parseIso(request.body?.endsAt)
    const locationTextRaw = request.body?.locationText?.trim() ?? ''
    const locationText = locationTextRaw.length > 0 ? locationTextRaw : null
    const locationShortRaw = request.body?.locationShortText?.trim() ?? ''
    const locationShortText =
      locationShortRaw.length > 0
        ? locationShortRaw
        : locationText
    const locationLat =
      typeof request.body?.locationLat === 'number' ? request.body.locationLat : null
    const locationLng =
      typeof request.body?.locationLng === 'number' ? request.body.locationLng : null
    const joinLimit = Number(request.body?.joinLimit)
    const visibility = (request.body?.visibility ?? 'public') as EventVisibility
    const organizerCommunityId = request.body?.organizerCommunityId?.trim() || null
    const tags = parseHashtagInput(request.body?.hashtags)
    if (tags.error) return reply.code(400).send({ error: tags.error })
    const hashtagInput = tags.slugs

    if (
      visibility !== 'public' &&
      visibility !== 'friends' &&
      visibility !== 'community' &&
      visibility !== 'channel'
    ) {
      return reply.code(400).send({ error: 'Invalid visibility' })
    }

    const organizerConversationId =
      visibility === 'channel' ? request.body?.organizerConversationId?.trim() || null : null

    if (organizerCommunityId) {
      if (visibility === 'friends') {
        return reply.code(400).send({ error: 'Community events cannot use friends visibility' })
      }
      if (visibility !== 'public' && visibility !== 'community' && visibility !== 'channel') {
        return reply.code(400).send({ error: 'Invalid visibility for community event' })
      }
      if (visibility === 'channel') {
        if (!organizerConversationId) {
          return reply.code(400).send({ error: 'Channel events require a channel' })
        }
        const channelErr = await assertCommunityChannel(
          organizerCommunityId,
          organizerConversationId,
          request.userId,
        )
        if (channelErr) return reply.code(channelErr.status).send({ error: channelErr.error })
      }
      const allowed = await canManageCommunityEvents(organizerCommunityId, request.userId)
      if (!allowed) {
        return reply.code(403).send({ error: 'You cannot create events for this community' })
      }
      const { data: community } = await supabaseAdmin
        .from('communities')
        .select('id, join_mode')
        .eq('id', organizerCommunityId)
        .maybeSingle()
      if (!community) return reply.code(404).send({ error: 'Community not found' })
      if (visibility === 'public' && community.join_mode === 'invite_hidden') {
        return reply.code(400).send({
          error: 'Hidden communities can only create internal (members-only) events',
        })
      }
    } else if (visibility === 'community' || visibility === 'channel') {
      return reply
        .code(400)
        .send({ error: 'Community or channel visibility requires a community organizer' })
    }

    if (!title) return reply.code(400).send({ error: 'Title is required' })
    if (exceedsLimit(title, TEXT_LIMITS.eventTitle)) {
      return reply.code(400).send({ error: `Title must be at most ${TEXT_LIMITS.eventTitle} characters` })
    }
    if (description && exceedsLimit(description, TEXT_LIMITS.eventDescription)) {
      return reply.code(400).send({
        error: `Description must be at most ${TEXT_LIMITS.eventDescription} characters`,
      })
    }
    if (locationText && exceedsLimit(locationText, TEXT_LIMITS.locationText)) {
      return reply.code(400).send({
        error: `Location must be at most ${TEXT_LIMITS.locationText} characters`,
      })
    }
    if (locationShortText && exceedsLimit(locationShortText, TEXT_LIMITS.locationText)) {
      return reply.code(400).send({
        error: `Short location must be at most ${TEXT_LIMITS.locationText} characters`,
      })
    }
    if (!starts || !ends) {
      return reply.code(400).send({ error: 'Start and end date/time are required' })
    }
    if (ends <= starts) {
      return reply.code(400).send({ error: 'End must be after start' })
    }
    if (!Number.isInteger(joinLimit) || joinLimit < 1) {
      return reply.code(400).send({ error: 'Join limit must be a positive integer' })
    }
    const hasCoords = locationLat != null && locationLng != null
    if (hasCoords) {
      if (locationLat < -90 || locationLat > 90 || locationLng < -180 || locationLng > 180) {
        return reply.code(400).send({ error: 'Invalid coordinates' })
      }
    }
    if (!locationText && !hasCoords) {
      return reply.code(400).send({ error: 'Location text or coordinates required' })
    }
    if ((locationLat == null) !== (locationLng == null)) {
      return reply.code(400).send({ error: 'Latitude and longitude must both be set' })
    }

    const friends = await resolveEventInviteeIds(
      request.userId,
      visibility,
      organizerCommunityId,
      organizerConversationId,
      request.body ?? {},
    )
    if (friends.error) {
      return reply
        .code(
          friends.error === 'Could not load friends' ||
            friends.error === 'Could not load community members' ||
            friends.error === 'Could not load channel members'
            ? 500
            : 400,
        )
        .send({ error: friends.error })
    }
    const friendIds = friends.friendIds
    if (request.body?.notifyInvites) {
      if (visibility === 'friends') {
        /* ok — invite selected friends */
      } else if (organizerCommunityId) {
        /* ok — invite joined community members */
      } else if (friendIds.length) {
        /* ok — public event + optional friend invites */
      } else {
        return reply.code(400).send({
          error: 'Invites require friends visibility, a community organizer, or selected friends',
        })
      }
    }

    let conversationId: string | null = null
    const wantChat = request.body?.createChat === true
    if (wantChat) {
      try {
        conversationId = await createEventConversation(request.userId)
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not create event chat' })
      }
    }

    const { data: row, error } = await supabaseAdmin
      .from('events')
      .insert({
        organizer_user_id: organizerCommunityId ? null : request.userId,
        organizer_community_id: organizerCommunityId,
        organizer_conversation_id: organizerConversationId,
        visibility,
        title,
        description,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        location_text: locationText,
        location_short_text: locationShortText,
        location_lat: hasCoords ? locationLat : null,
        location_lng: hasCoords ? locationLng : null,
        join_limit: joinLimit,
        conversation_id: conversationId,
      })
      .select(EVENT_SELECT)
      .single()

    if (error || !row) {
      if (conversationId) {
        await supabaseAdmin.from('conversations').delete().eq('id', conversationId)
      }
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not create event' })
    }

    const rowFinal = { ...(row as EventRow), is_repeating: Boolean((row as EventRow).is_repeating) }

    if (conversationId) {
      try {
        await sendCreatorWelcomeMessage(conversationId, request.userId, title)
      } catch (e) {
        request.log.error(e)
      }
    }

    const { error: joinSelf } = await supabaseAdmin.from('event_participants').insert({
      event_id: rowFinal.id,
      user_id: request.userId,
      status: 'joined',
    })
    if (joinSelf) {
      request.log.error(joinSelf)
    }

    if (!organizerCommunityId) {
      try {
        await grantEventRoles(rowFinal.id, request.userId, ['organizer'])
      } catch (e) {
        request.log.error(e)
      }
    }

    if (visibility === 'friends' && friendIds.length) {
      const { error: visErr } = await supabaseAdmin.from('event_visible_friends').insert(
        friendIds.map((user_id) => ({ event_id: rowFinal.id, user_id })),
      )
      if (visErr) {
        request.log.error(visErr)
        return reply.code(500).send({ error: 'Event created but friends visibility failed' })
      }
    }

    const inviteFriends =
      friendIds.length > 0 &&
      (visibility !== 'friends' || Boolean(request.body?.notifyInvites))
    if (inviteFriends) {
      const inviteRows = friendIds.map((user_id) => ({
        event_id: rowFinal.id,
        user_id,
        status: 'invited' as const,
        invited_by: request.userId,
      }))
      const { error: invErr } = await supabaseAdmin.from('event_participants').insert(inviteRows)
      if (invErr) {
        request.log.error(invErr)
        return reply.code(500).send({ error: 'Event created but invites failed' })
      }
      const name = await organizerName(request.userId)
      void notifyUsers(
        friendIds,
        eventInviteNotification({
          organizerName: name,
          eventTitle: title,
          eventId: rowFinal.id,
        }),
        { log: request.log, excludeUserId: request.userId },
      )
    }

    if (request.body?.notifyInvites && organizerCommunityId && visibility === 'community') {
      const { data: members, error: memErr } = await supabaseAdmin
        .from('community_members')
        .select('user_id')
        .eq('community_id', organizerCommunityId)
        .eq('status', 'joined')
      if (memErr) {
        request.log.error(memErr)
        return reply.code(500).send({ error: 'Event created but community invites failed' })
      }
      const friendIdSet = new Set(friendIds)
      const memberIds = (members ?? [])
        .map((m) => m.user_id as string)
        .filter((id) => id !== request.userId && !friendIdSet.has(id))
      if (memberIds.length) {
        const inviteRows = memberIds.map((user_id) => ({
          event_id: rowFinal.id,
          user_id,
          status: 'invited' as const,
          invited_by: request.userId,
        }))
        const { error: invErr } = await supabaseAdmin.from('event_participants').insert(inviteRows)
        if (invErr) {
          request.log.error(invErr)
          return reply.code(500).send({ error: 'Event created but community invites failed' })
        }
        const name = await organizerName(request.userId)
        void notifyUsers(
          memberIds,
          eventInviteNotification({
            organizerName: name,
            eventTitle: title,
            eventId: rowFinal.id,
          }),
          { log: request.log, excludeUserId: request.userId },
        )
      }
    }

    if (
      request.body?.notifyInvites &&
      visibility === 'channel' &&
      organizerConversationId
    ) {
      const { data: members, error: memErr } = await supabaseAdmin
        .from('conversation_members')
        .select('user_id')
        .eq('conversation_id', organizerConversationId)
      if (memErr) {
        request.log.error(memErr)
        return reply.code(500).send({ error: 'Event created but channel invites failed' })
      }
      const friendIdSet = new Set(friendIds)
      const memberIds = (members ?? [])
        .map((m) => m.user_id as string)
        .filter((id) => id !== request.userId && !friendIdSet.has(id))
      if (memberIds.length) {
        const inviteRows = memberIds.map((user_id) => ({
          event_id: rowFinal.id,
          user_id,
          status: 'invited' as const,
          invited_by: request.userId,
        }))
        const { error: invErr } = await supabaseAdmin.from('event_participants').insert(inviteRows)
        if (invErr) {
          request.log.error(invErr)
          return reply.code(500).send({ error: 'Event created but channel invites failed' })
        }
        const name = await organizerName(request.userId)
        void notifyUsers(
          memberIds,
          eventInviteNotification({
            organizerName: name,
            eventTitle: title,
            eventId: rowFinal.id,
          }),
          { log: request.log, excludeUserId: request.userId },
        )
      }
    }

    if (hashtagInput.length) {
      try {
        await attachEventHashtags(rowFinal.id, hashtagInput)
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 500
        request.log.error(e)
        return reply.code(status).send({
          error: e instanceof Error ? e.message : 'Could not save hashtags',
        })
      }
    }

    return reply.code(201).send(await toDto(rowFinal, request.userId))
  })

  /**
   * GET `/events/:id`
   */
  app.get<{ Params: { id: string } }>(
    '/events/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not load event' })
      }
      if (!row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      if (!(await userCanSeeEvent(ev, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      if (!(await eventAllowedForViewer(ev, request.userId))) {
        return reply.code(404).send({ error: 'Event not found' })
      }
      return await toDto(ev, request.userId, { includeHistory: true })
    },
  )

  /**
   * POST `/events/:id/favourite` — star a past event for the create hub.
   */
  app.post<{ Params: { id: string } }>(
    '/events/:id/favourite',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      if (!(await userCanSeeEvent(ev, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const { error: upsertErr } = await supabaseAdmin.from('event_favourites').upsert(
        { user_id: request.userId, event_id: ev.id },
        { onConflict: 'user_id,event_id' },
      )
      if (upsertErr) {
        request.log.error(upsertErr)
        return reply.code(500).send({ error: 'Could not favourite event' })
      }
      return await toDto(ev, request.userId, { isFavourite: true, includeHistory: true })
    },
  )

  /**
   * DELETE `/events/:id/favourite`
   */
  app.delete<{ Params: { id: string } }>(
    '/events/:id/favourite',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      const { error: delErr } = await supabaseAdmin
        .from('event_favourites')
        .delete()
        .eq('user_id', request.userId)
        .eq('event_id', ev.id)
      if (delErr) {
        request.log.error(delErr)
        return reply.code(500).send({ error: 'Could not unfavourite event' })
      }
      return await toDto(ev, request.userId, { isFavourite: false, includeHistory: true })
    },
  )

  /**
   * POST `/events/:id/redo` — create a child occurrence under the series root,
   * share the root chat, keep separate RSVP, resend invites to prior joined/invited.
   */
  app.post<{ Params: { id: string }; Body: { startsAt?: string; endsAt?: string } }>(
    '/events/:id/redo',
    { preHandler: requireAuth },
    async (request, reply) => {
      const starts = parseIso(request.body?.startsAt)
      const ends = parseIso(request.body?.endsAt)
      if (!starts || !ends) return reply.code(400).send({ error: 'startsAt and endsAt required' })
      if (ends.getTime() <= starts.getTime()) {
        return reply.code(400).send({ error: 'endsAt must be after startsAt' })
      }

      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const source = row as EventRow
      const manage = await assertCanManageEvent(source, request.userId)
      if (manage !== true) return reply.code(manage.status).send({ error: manage.error })
      if (source.canceled_at) return reply.code(403).send({ error: 'Canceled events cannot be redone' })

      const rootId = seriesRootId(source)
      let root = source
      if (rootId !== source.id) {
        const { data: rootRow, error: rootErr } = await eventSelect().eq('id', rootId).maybeSingle()
        if (rootErr || !rootRow) {
          return reply.code(500).send({ error: 'Could not load series root' })
        }
        root = rootRow as EventRow
      }

      const { data: child, error: insErr } = await supabaseAdmin
        .from('events')
        .insert({
          organizer_user_id: source.organizer_user_id,
          organizer_community_id: source.organizer_community_id,
          organizer_conversation_id: source.organizer_conversation_id ?? null,
          visibility: source.visibility,
          title: source.title,
          description: source.description,
          starts_at: starts.toISOString(),
          ends_at: ends.toISOString(),
          location_text: source.location_text,
          location_short_text: source.location_short_text,
          location_lat: source.location_lat,
          location_lng: source.location_lng,
          join_limit: source.join_limit,
          conversation_id: root.conversation_id,
          parent_event_id: rootId,
          is_repeating: true,
          cover_storage_path: source.cover_storage_path,
          cover_updated_at: source.cover_updated_at,
        })
        .select(EVENT_SELECT)
        .single()

      if (insErr || !child) {
        request.log.error(insErr)
        return reply.code(500).send({
          error: insErr?.message?.includes('parent_event_id')
            ? 'Could not create occurrence (apply DB migration event_series_parent)'
            : 'Could not create child event',
        })
      }

      const childRow = child as EventRow

      if (!root.is_repeating) {
        await supabaseAdmin.from('events').update({ is_repeating: true }).eq('id', rootId)
      }

      // Organizer joined + roles on the new occurrence (fresh RSVP count).
      const organizerUserId = source.organizer_user_id ?? request.userId
      const { error: joinSelf } = await supabaseAdmin.from('event_participants').insert({
        event_id: childRow.id,
        user_id: organizerUserId,
        status: 'joined',
      })
      if (joinSelf) request.log.error(joinSelf)

      if (!source.organizer_community_id) {
        try {
          await grantEventRoles(childRow.id, organizerUserId, ['organizer'])
        } catch (e) {
          request.log.error(e)
        }
      }

      // Copy friends visibility from source.
      if (source.visibility === 'friends') {
        const { data: vis } = await supabaseAdmin
          .from('event_visible_friends')
          .select('user_id')
          .eq('event_id', source.id)
        const friendIds = (vis ?? []).map((v) => v.user_id as string)
        if (friendIds.length) {
          const { error: visErr } = await supabaseAdmin.from('event_visible_friends').insert(
            friendIds.map((user_id) => ({ event_id: childRow.id, user_id })),
          )
          if (visErr) request.log.error(visErr)
        }
      }

      // Copy hashtags from source.
      try {
        const tagMap = await slugsForEventIds([source.id])
        const slugs = tagMap.get(source.id) ?? []
        if (slugs.length) await attachEventHashtags(childRow.id, slugs)
      } catch (e) {
        request.log.error(e)
      }

      // Resend invites: prior joined + invited on source (not auto-joined, not interested-only).
      const { data: priorParts } = await supabaseAdmin
        .from('event_participants')
        .select('user_id, status')
        .eq('event_id', source.id)
        .in('status', ['joined', 'invited'])

      const inviteIds = [
        ...new Set(
          (priorParts ?? [])
            .map((p) => p.user_id as string)
            .filter((id) => id !== organizerUserId),
        ),
      ]
      if (inviteIds.length) {
        const inviteRows = inviteIds.map((user_id) => ({
          event_id: childRow.id,
          user_id,
          status: 'invited' as const,
          invited_by: request.userId,
        }))
        const { error: invErr } = await supabaseAdmin.from('event_participants').insert(inviteRows)
        if (invErr) {
          request.log.error(invErr)
        } else {
          const name = await organizerName(request.userId)
          void notifyUsers(
            inviteIds,
            eventInviteNotification({
              organizerName: name,
              eventTitle: childRow.title,
              eventId: childRow.id,
            }),
            { log: request.log, excludeUserId: request.userId },
          )
        }
      }

      try {
        if (root.conversation_id) {
          await unarchiveEventChat(root.conversation_id, childRow.id)
        }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not reopen event chat' })
      }

      const refreshed = {
        ...childRow,
        chat_archived_at: null,
        is_repeating: true,
        parent_event_id: rootId,
      }
      return reply.code(201).send(await toDto(refreshed, request.userId, { includeHistory: true }))
    },
  )

  /**
   * POST `/events/:id/cover` — optional 16:9 cover (manage event / community manage_events|admin).
   */
  app.post<{ Params: { id: string } }>(
    '/events/:id/cover',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      const coverPerm = await assertCanManageEvent(ev, request.userId)
      if (coverPerm !== true) {
        return reply.code(coverPerm.status).send({ error: coverPerm.error })
      }
      const canceled = canceledMessage(ev)
      if (canceled) return reply.code(403).send({ error: canceled })

      const file = await request.file()
      if (!file) {
        return reply.code(400).send({ error: 'cover file required' })
      }

      const chunks: Buffer[] = []
      for await (const chunk of file.file) {
        chunks.push(chunk)
      }
      const buffer = Buffer.concat(chunks)

      const validationError = validateEventCoverUpload(buffer)
      if (validationError) {
        return reply.code(400).send({ error: validationError })
      }

      let webp: Buffer
      try {
        webp = await processEventCover(buffer)
      } catch (e) {
        request.log.warn(e)
        return reply.code(400).send({ error: 'Invalid image file' })
      }

      let storagePath: string
      try {
        storagePath = await uploadEventCover(ev.id, webp)
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not upload cover' })
      }

      const now = new Date().toISOString()
      const { data: fresh, error: upd } = await supabaseAdmin
        .from('events')
        .update({ cover_storage_path: storagePath, cover_updated_at: now })
        .eq('id', ev.id)
        .select(EVENT_SELECT)
        .single()

      if (upd || !fresh) {
        request.log.error(upd)
        return reply.code(500).send({ error: 'Could not save cover' })
      }

      return await toDto(fresh as EventRow, request.userId)
    },
  )

  /**
   * POST `/events/:id/interested` — toggle save (does not take a join slot).
   */
  app.post<{ Params: { id: string } }>(
    '/events/:id/interested',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      if (!(await userCanSeeEvent(ev, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const canceled = canceledMessage(ev)
      if (canceled) return reply.code(403).send({ error: canceled })

      const { data: mine } = await supabaseAdmin
        .from('event_participants')
        .select('status, invited_by')
        .eq('event_id', ev.id)
        .eq('user_id', request.userId)
        .maybeSingle()

      if (mine?.status === 'joined') {
        return reply.code(400).send({ error: 'Already joined' })
      }

      if (mine?.status === 'interested') {
        if (mine.invited_by) {
          await supabaseAdmin
            .from('event_participants')
            .update({ status: 'invited' })
            .eq('event_id', ev.id)
            .eq('user_id', request.userId)
        } else {
          await supabaseAdmin
            .from('event_participants')
            .delete()
            .eq('event_id', ev.id)
            .eq('user_id', request.userId)
        }
      } else if (mine?.status === 'invited') {
        await supabaseAdmin
          .from('event_participants')
          .update({ status: 'interested' })
          .eq('event_id', ev.id)
          .eq('user_id', request.userId)
      } else {
        const { error: ins } = await supabaseAdmin.from('event_participants').insert({
          event_id: ev.id,
          user_id: request.userId,
          status: 'interested',
        })
        if (ins) {
          request.log.error(ins)
          return reply.code(500).send({ error: 'Could not save event' })
        }
      }

      const { data: fresh } = await eventSelect().eq('id', ev.id).single()
      return await toDto(fresh as EventRow, request.userId)
    },
  )

  /**
   * POST `/events/:id/join` — take a slot and enter the event chat.
   */
  app.post<{ Params: { id: string } }>(
    '/events/:id/join',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      if (!(await userCanSeeEvent(ev, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const canceled = canceledMessage(ev)
      if (canceled) return reply.code(403).send({ error: canceled })

      const { data: mine } = await supabaseAdmin
        .from('event_participants')
        .select('status, invited_by')
        .eq('event_id', ev.id)
        .eq('user_id', request.userId)
        .maybeSingle()

      if (mine?.status === 'joined') {
        return await toDto(ev, request.userId)
      }

      const joined = await countJoined(ev.id)
      if (joined >= ev.join_limit) {
        return reply.code(409).send({ error: 'Event is full' })
      }

      if (mine) {
        const { error: upd } = await supabaseAdmin
          .from('event_participants')
          .update({ status: 'joined' })
          .eq('event_id', ev.id)
          .eq('user_id', request.userId)
        if (upd) {
          request.log.error(upd)
          return reply.code(500).send({ error: 'Could not join' })
        }
      } else {
        const { error: ins } = await supabaseAdmin.from('event_participants').insert({
          event_id: ev.id,
          user_id: request.userId,
          status: 'joined',
        })
        if (ins) {
          request.log.error(ins)
          return reply.code(500).send({ error: 'Could not join' })
        }
      }

      try {
        if (ev.conversation_id) {
          await addEventChatMember(ev.conversation_id, request.userId)
        }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Joined but could not open chat' })
      }

      const { data: fresh } = await eventSelect().eq('id', ev.id).single()
      return await toDto(fresh as EventRow, request.userId)
    },
  )

  /**
   * POST `/events/:id/leave` — set RSVP to denied and leave event chat. Organizer cannot leave.
   */
  app.post<{ Params: { id: string } }>(
    '/events/:id/leave',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      if (
        ev.organizer_user_id === request.userId ||
        (await isEventOrganizer(ev.id, request.userId))
      ) {
        return reply.code(403).send({ error: 'Organizer cannot leave; cancel the event instead' })
      }
      if (!(await userCanSeeEvent(ev, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }

      const { data: mine } = await supabaseAdmin
        .from('event_participants')
        .select('status')
        .eq('event_id', ev.id)
        .eq('user_id', request.userId)
        .maybeSingle()

      if (!mine || (mine.status !== 'joined' && mine.status !== 'interested')) {
        return reply.code(400).send({ error: 'Not a participant' })
      }

      const wasJoined = mine.status === 'joined'
      const { error: upd } = await supabaseAdmin
        .from('event_participants')
        .update({ status: 'denied' })
        .eq('event_id', ev.id)
        .eq('user_id', request.userId)
      if (upd) {
        request.log.error(upd)
        return reply.code(500).send({ error: 'Could not leave' })
      }

      if (wasJoined && ev.conversation_id) {
        await removeEventChatMemberIfUnused(ev.conversation_id, request.userId, ev.id)
      }

      const { data: fresh } = await eventSelect().eq('id', ev.id).single()
      return await toDto(fresh as EventRow, request.userId)
    },
  )

  /**
   * POST `/events/:id/deny` — decline invite / leave interest or join → `denied`.
   * Organizer cannot deny themselves.
   */
  app.post<{ Params: { id: string } }>(
    '/events/:id/deny',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      if (
        ev.organizer_user_id === request.userId ||
        (await isEventOrganizer(ev.id, request.userId))
      ) {
        return reply.code(403).send({ error: 'Organizer cannot deny the event' })
      }
      if (!(await userCanSeeEvent(ev, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }

      const { data: mine } = await supabaseAdmin
        .from('event_participants')
        .select('status')
        .eq('event_id', ev.id)
        .eq('user_id', request.userId)
        .maybeSingle()

      if (mine?.status === 'denied') {
        return await toDto(ev, request.userId)
      }

      const wasJoined = mine?.status === 'joined'
      if (mine) {
        if (
          mine.status !== 'invited' &&
          mine.status !== 'interested' &&
          mine.status !== 'joined'
        ) {
          return reply.code(400).send({ error: 'Cannot deny from this status' })
        }
        const { error: upd } = await supabaseAdmin
          .from('event_participants')
          .update({ status: 'denied' })
          .eq('event_id', ev.id)
          .eq('user_id', request.userId)
        if (upd) {
          request.log.error(upd)
          return reply.code(500).send({ error: 'Could not deny' })
        }
      } else {
        const { error: ins } = await supabaseAdmin.from('event_participants').insert({
          event_id: ev.id,
          user_id: request.userId,
          status: 'denied',
        })
        if (ins) {
          request.log.error(ins)
          return reply.code(500).send({ error: 'Could not deny' })
        }
      }

      if (wasJoined && ev.conversation_id) {
        await removeEventChatMemberIfUnused(ev.conversation_id, request.userId, ev.id)
      }

      const { data: fresh } = await eventSelect().eq('id', ev.id).single()
      return await toDto(fresh as EventRow, request.userId)
    },
  )

  /**
   * POST `/events/:id/invite` — one row per user; may notify again.
   */
  app.post<{ Params: { id: string }; Body: InviteBody }>(
    '/events/:id/invite',
    { preHandler: requireAuth },
    async (request, reply) => {
      const username = request.body?.username?.trim().toLowerCase() ?? ''
      if (!username) return reply.code(400).send({ error: 'username required' })
      if (exceedsLimit(username, TEXT_LIMITS.username)) {
        return reply.code(400).send({ error: `Username must be at most ${TEXT_LIMITS.username} characters` })
      }

      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      const invitePerm = await assertCanManageEvent(ev, request.userId)
      if (invitePerm !== true) return reply.code(invitePerm.status).send({ error: invitePerm.error })
      const canceled = canceledMessage(ev)
      if (canceled) return reply.code(403).send({ error: canceled })

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, username')
        .eq('username', username)
        .maybeSingle()
      if (!profile) return reply.code(404).send({ error: 'User not found' })
      if (profile.id === request.userId) {
        return reply.code(400).send({ error: 'Cannot invite yourself' })
      }

      const { data: existing } = await supabaseAdmin
        .from('event_participants')
        .select('status, invited_by')
        .eq('event_id', ev.id)
        .eq('user_id', profile.id)
        .maybeSingle()

      if (!existing) {
        const { error: ins } = await supabaseAdmin.from('event_participants').insert({
          event_id: ev.id,
          user_id: profile.id,
          status: 'invited',
          invited_by: request.userId,
        })
        if (ins) {
          request.log.error(ins)
          return reply.code(500).send({ error: 'Could not invite' })
        }
      } else if (existing.status === 'invited' && !existing.invited_by) {
        await supabaseAdmin
          .from('event_participants')
          .update({ invited_by: request.userId })
          .eq('event_id', ev.id)
          .eq('user_id', profile.id)
      }

      const { data: me } = await supabaseAdmin
        .from('profiles')
        .select('full_name, username')
        .eq('id', request.userId)
        .maybeSingle()

      void notifyUsers(
        [profile.id],
        eventInviteNotification({
          organizerName: me?.full_name || me?.username || 'Someone',
          eventTitle: ev.title,
          eventId: ev.id,
        }),
        { log: request.log },
      )

      return { ok: true }
    },
  )

  /**
   * GET `/events/:id/participants` — joined, interested, or invited; cursor by user_id.
   */
  app.get<{
    Params: { id: string }
    Querystring: { status?: string; limit?: string; cursor?: string }
  }>(
    '/events/:id/participants',
    { preHandler: requireAuth },
    async (request, reply) => {
      const rawStatus = request.query.status
      const status =
        rawStatus === 'interested' || rawStatus === 'invited' ? rawStatus : 'joined'
      const limit = Math.min(Number(request.query.limit ?? 20) || 20, 50)
      const cursor = request.query.cursor?.trim()

      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      if (!(await userCanSeeEvent(ev, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }

      let query = supabaseAdmin
        .from('event_participants')
        .select('user_id')
        .eq('event_id', ev.id)
        .eq('status', status)
        .order('user_id', { ascending: true })
        .limit(limit + 1)
      if (cursor) query = query.gt('user_id', cursor)

      const { data: parts, error: partErr } = await query
      if (partErr) {
        request.log.error(partErr)
        return reply.code(500).send({ error: 'Could not list participants' })
      }
      const page = parts ?? []
      const extra = page.length > limit
      const slice = extra ? page.slice(0, limit) : page
      const ids = slice.map((p) => p.user_id as string)
      if (ids.length === 0) {
        return { participants: [], nextCursor: null }
      }

      const { data: profiles } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, username, avatar_storage_path, avatar_updated_at')
        .in('id', ids)
      const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]))
      const urls = await avatarUrlsForPaths(
        (profiles ?? []).map((p) => (p.avatar_storage_path as string | null) ?? null),
      )

      const participants = ids.map((id) => {
        const p = byId.get(id)
        const path = (p?.avatar_storage_path as string | null) ?? null
        return {
          id,
          fullName: (p?.full_name as string | null) ?? null,
          username: (p?.username as string | null) ?? null,
          avatarUrl: path ? urls.get(path) ?? null : null,
          avatarUpdatedAt: (p?.avatar_updated_at as string | null) ?? null,
        }
      })

      return {
        participants,
        nextCursor: extra ? ids[ids.length - 1] ?? null : null,
      }
    },
  )

  /**
   * PATCH `/events/:id` — organizer edit (not after cancel).
   */
  app.patch<{ Params: { id: string }; Body: PatchBody }>(
    '/events/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      const editPerm = await assertCanManageEvent(ev, request.userId)
      if (editPerm !== true) return reply.code(editPerm.status).send({ error: editPerm.error })
      const canceled = canceledMessage(ev)
      if (canceled) return reply.code(403).send({ error: canceled })

      const title = request.body?.title?.trim() ?? ''
      const descriptionRaw = request.body?.description?.trim() ?? ''
      const description = descriptionRaw.length > 0 ? descriptionRaw : null
      const starts = parseIso(request.body?.startsAt)
      const ends = parseIso(request.body?.endsAt)
      const locationTextRaw = request.body?.locationText?.trim() ?? ''
      const locationText = locationTextRaw.length > 0 ? locationTextRaw : null
      const locationShortRaw = request.body?.locationShortText?.trim() ?? ''
      const locationShortText =
        locationShortRaw.length > 0 ? locationShortRaw : locationText
      const locationLat =
        typeof request.body?.locationLat === 'number' ? request.body.locationLat : null
      const locationLng =
        typeof request.body?.locationLng === 'number' ? request.body.locationLng : null
      const joinLimit = Number(request.body?.joinLimit)
      const visibility = (request.body?.visibility ?? ev.visibility) as EventVisibility
      const tags = parseHashtagInput(request.body?.hashtags)
      if (tags.error) return reply.code(400).send({ error: tags.error })

      if (
        visibility !== 'public' &&
        visibility !== 'friends' &&
        visibility !== 'community' &&
        visibility !== 'channel'
      ) {
        return reply.code(400).send({ error: 'Invalid visibility' })
      }
      const organizerConversationId =
        visibility === 'channel'
          ? request.body?.organizerConversationId?.trim() ||
            ev.organizer_conversation_id ||
            null
          : null
      if ((visibility === 'community' || visibility === 'channel') && !ev.organizer_community_id) {
        return reply
          .code(400)
          .send({ error: 'Community or channel visibility requires a community organizer' })
      }
      if (visibility === 'channel') {
        if (!organizerConversationId) {
          return reply.code(400).send({ error: 'Channel events require a channel' })
        }
        const channelErr = await assertCommunityChannel(
          ev.organizer_community_id!,
          organizerConversationId,
          request.userId,
        )
        if (channelErr) return reply.code(channelErr.status).send({ error: channelErr.error })
      }
      if (ev.organizer_community_id && visibility === 'friends') {
        return reply.code(400).send({ error: 'Community events cannot use friends visibility' })
      }
      if (ev.organizer_community_id && visibility === 'public') {
        const { data: community } = await supabaseAdmin
          .from('communities')
          .select('join_mode')
          .eq('id', ev.organizer_community_id)
          .maybeSingle()
        if (community?.join_mode === 'invite_hidden') {
          return reply.code(400).send({
            error: 'Hidden communities can only use internal (members-only) visibility',
          })
        }
      }
      if (!title) return reply.code(400).send({ error: 'Title is required' })
      if (exceedsLimit(title, TEXT_LIMITS.eventTitle)) {
        return reply.code(400).send({ error: `Title must be at most ${TEXT_LIMITS.eventTitle} characters` })
      }
      if (description && exceedsLimit(description, TEXT_LIMITS.eventDescription)) {
        return reply.code(400).send({
          error: `Description must be at most ${TEXT_LIMITS.eventDescription} characters`,
        })
      }
      if (locationText && exceedsLimit(locationText, TEXT_LIMITS.locationText)) {
        return reply.code(400).send({
          error: `Location must be at most ${TEXT_LIMITS.locationText} characters`,
        })
      }
      if (locationShortText && exceedsLimit(locationShortText, TEXT_LIMITS.locationText)) {
        return reply.code(400).send({
          error: `Short location must be at most ${TEXT_LIMITS.locationText} characters`,
        })
      }
      if (!starts || !ends) {
        return reply.code(400).send({ error: 'Start and end date/time are required' })
      }
      if (ends <= starts) {
        return reply.code(400).send({ error: 'End must be after start' })
      }
      if (!Number.isInteger(joinLimit) || joinLimit < 1) {
        return reply.code(400).send({ error: 'Join limit must be a positive integer' })
      }
      const joined = await countJoined(ev.id)
      if (joinLimit < joined) {
        return reply.code(400).send({ error: 'Join limit cannot be below current joined count' })
      }
      const hasCoords = locationLat != null && locationLng != null
      if (hasCoords) {
        if (locationLat < -90 || locationLat > 90 || locationLng < -180 || locationLng > 180) {
          return reply.code(400).send({ error: 'Invalid coordinates' })
        }
      }
      if (!locationText && !hasCoords) {
        return reply.code(400).send({ error: 'Location text or coordinates required' })
      }
      if ((locationLat == null) !== (locationLng == null)) {
        return reply.code(400).send({ error: 'Latitude and longitude must both be set' })
      }

      const friends = await resolveEventInviteeIds(
        request.userId,
        visibility,
        ev.organizer_community_id,
        organizerConversationId,
        request.body ?? {},
      )
      if (friends.error) {
        return reply
          .code(
            friends.error === 'Could not load friends' ||
              friends.error === 'Could not load community members' ||
              friends.error === 'Could not load channel members'
              ? 500
              : 400,
          )
          .send({ error: friends.error })
      }

      const { data: fresh, error: upd } = await supabaseAdmin
        .from('events')
        .update({
          visibility,
          organizer_conversation_id: organizerConversationId,
          title,
          description,
          starts_at: starts.toISOString(),
          ends_at: ends.toISOString(),
          location_text: locationText,
          location_short_text: locationShortText,
          location_lat: hasCoords ? locationLat : null,
          location_lng: hasCoords ? locationLng : null,
          join_limit: joinLimit,
        })
        .eq('id', ev.id)
        .select(EVENT_SELECT)
        .single()
      if (upd || !fresh) {
        request.log.error(upd)
        return reply.code(500).send({ error: 'Could not update event' })
      }

      await supabaseAdmin.from('event_visible_friends').delete().eq('event_id', ev.id)
      if (visibility === 'friends' && friends.friendIds.length) {
        const { error: visErr } = await supabaseAdmin.from('event_visible_friends').insert(
          friends.friendIds.map((user_id) => ({ event_id: ev.id, user_id })),
        )
        if (visErr) {
          request.log.error(visErr)
          return reply.code(500).send({ error: 'Event updated but friends visibility failed' })
        }
      }

      try {
        await replaceEventHashtags(ev.id, tags.slugs)
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 500
        request.log.error(e)
        return reply.code(status).send({
          error: e instanceof Error ? e.message : 'Could not save hashtags',
        })
      }

      // Optional chat: create/unarchive when enabling; archive (keep id) when disabling.
      let chatRow = fresh as EventRow
      if (typeof request.body?.createChat === 'boolean') {
        const wantChat = request.body.createChat
        const hasChat = Boolean(ev.conversation_id)
        const archived = Boolean(ev.chat_archived_at)
        if (wantChat && (!hasChat || archived)) {
          try {
            const conversationId = await enableEventChatForSeries(ev, request.userId, {
              sendWelcome: async (cid) => {
                await sendCreatorWelcomeMessage(cid, request.userId, title)
              },
            })
            chatRow = {
              ...chatRow,
              conversation_id: conversationId,
              chat_archived_at: null,
            }
          } catch (e) {
            request.log.error(e)
            return reply.code(500).send({ error: 'Could not enable event chat' })
          }
        } else if (!wantChat && hasChat && !archived) {
          try {
            await archiveEventChat(ev.conversation_id!, ev.id)
            chatRow = { ...chatRow, chat_archived_at: new Date().toISOString() }
          } catch (e) {
            request.log.error(e)
            return reply.code(500).send({ error: 'Could not disable event chat' })
          }
        }
      }

      const { data: afterChat } = await eventSelect().eq('id', ev.id).single()
      return await toDto((afterChat ?? chatRow) as EventRow, request.userId)
    },
  )

  /**
   * POST `/events/:id/cancel` — organizer; archives event chat.
   */
  app.post<{ Params: { id: string } }>(
    '/events/:id/cancel',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      const cancelPerm = await assertCanManageEvent(ev, request.userId)
      if (cancelPerm !== true) return reply.code(cancelPerm.status).send({ error: cancelPerm.error })
      if (ev.canceled_at) return await toDto(ev, request.userId)

      const now = new Date().toISOString()
      const { data: fresh, error: upd } = await supabaseAdmin
        .from('events')
        .update({ canceled_at: now })
        .eq('id', ev.id)
        .select(EVENT_SELECT)
        .single()
      if (upd || !fresh) {
        request.log.error(upd)
        return reply.code(500).send({ error: 'Could not cancel event' })
      }
      // Only archive the shared chat when no other open occurrence remains.
      if (ev.conversation_id && !(await seriesChatStillOpen(ev.conversation_id))) {
        await archiveEventChat(ev.conversation_id, ev.id)
      }
      const { data: after } = await eventSelect().eq('id', ev.id).single()
      return await toDto((after ?? fresh) as EventRow, request.userId)
    },
  )

  /**
   * POST `/events/:id/notify` — organizer push to interested / invited / community.
   */
  app.post<{ Params: { id: string }; Body: NotifyBody }>(
    '/events/:id/notify',
    { preHandler: requireAuth },
    async (request, reply) => {
      const audience = request.body?.audience
      if (audience !== 'interested' && audience !== 'invited' && audience !== 'community') {
        return reply.code(400).send({ error: 'Invalid audience' })
      }

      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      const notifyPerm = await assertCanManageEvent(ev, request.userId)
      if (notifyPerm !== true) return reply.code(notifyPerm.status).send({ error: notifyPerm.error })
      const canceled = canceledMessage(ev)
      if (canceled) return reply.code(403).send({ error: canceled })

      if (audience === 'community') {
        if (!ev.organizer_community_id) {
          return reply.code(400).send({ error: 'Not a community event' })
        }
        const { data: members, error: memErr } = await supabaseAdmin
          .from('community_members')
          .select('user_id')
          .eq('community_id', ev.organizer_community_id)
          .eq('status', 'joined')
        if (memErr) {
          request.log.error(memErr)
          return reply.code(500).send({ error: 'Could not load recipients' })
        }
        const userIds = (members ?? []).map((m) => m.user_id as string)
        const name = await organizerName(request.userId)
        void notifyUsers(
          userIds,
          eventNoticeNotification({
            organizerName: name,
            eventTitle: ev.title,
            eventId: ev.id,
          }),
          { log: request.log, excludeUserId: request.userId },
        )
        return { ok: true, count: userIds.length }
      }

      if (audience === 'invited' && !ev.organizer_community_id && ev.visibility !== 'friends') {
        return reply.code(400).send({ error: 'Invites apply to friends visibility' })
      }

      const status = audience === 'interested' ? 'interested' : 'invited'
      const { data: parts, error: partErr } = await supabaseAdmin
        .from('event_participants')
        .select('user_id')
        .eq('event_id', ev.id)
        .eq('status', status)
      if (partErr) {
        request.log.error(partErr)
        return reply.code(500).send({ error: 'Could not load recipients' })
      }
      const userIds = (parts ?? []).map((p) => p.user_id as string)
      const name = await organizerName(request.userId)
      const payload =
        audience === 'invited'
          ? eventInviteNotification({
              organizerName: name,
              eventTitle: ev.title,
              eventId: ev.id,
            })
          : eventNoticeNotification({
              organizerName: name,
              eventTitle: ev.title,
              eventId: ev.id,
            })
      void notifyUsers(userIds, payload, { log: request.log, excludeUserId: request.userId })
      return { ok: true, count: userIds.length }
    },
  )

  /**
   * POST `/events/:id/roles` — grant/revoke manage_event (organizer only).
   */
  app.post<{
    Params: { id: string }
    Body: { userId?: string; role?: string; action?: 'grant' | 'revoke' }
  }>('/events/:id/roles', { preHandler: requireAuth }, async (request, reply) => {
    const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
    if (error || !row) return reply.code(404).send({ error: 'Event not found' })
    const ev = row as EventRow
    if (ev.organizer_community_id) {
      return reply.code(400).send({ error: 'Use community roles for community-organized events' })
    }
    if (!(await isEventOrganizer(ev.id, request.userId))) {
      return reply.code(403).send({ error: 'Only the organizer can assign roles' })
    }
    const targetUserId = request.body?.userId?.trim() ?? ''
    const role = request.body?.role?.trim() ?? ''
    const action = request.body?.action
    if (!targetUserId || role !== 'manage_event' || (action !== 'grant' && action !== 'revoke')) {
      return reply.code(400).send({ error: 'userId, role=manage_event, and action required' })
    }
    if (targetUserId === request.userId) {
      return reply.code(400).send({ error: 'Cannot change your own organizer role here' })
    }
    const { data: part } = await supabaseAdmin
      .from('event_participants')
      .select('status')
      .eq('event_id', ev.id)
      .eq('user_id', targetUserId)
      .eq('status', 'joined')
      .maybeSingle()
    if (!part) return reply.code(400).send({ error: 'User must be a joined participant' })
    try {
      if (action === 'grant') await grantEventRoles(ev.id, targetUserId, ['manage_event'])
      else await revokeEventRole(ev.id, targetUserId, 'manage_event')
    } catch (e) {
      request.log.error(e)
      return reply.code(500).send({ error: 'Could not update role' })
    }
    const roles = await getEventRoles(ev.id, targetUserId)
    return { ok: true, userId: targetUserId, roles }
  })

  /**
   * POST `/events/:id/transfer-organizer` — password-confirmed ownership transfer.
   */
  app.post<{
    Params: { id: string }
    Body: { targetUserId?: string; password?: string }
  }>('/events/:id/transfer-organizer', { preHandler: requireAuth }, async (request, reply) => {
    const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
    if (error || !row) return reply.code(404).send({ error: 'Event not found' })
    const ev = row as EventRow
    if (ev.organizer_community_id) {
      return reply.code(400).send({ error: 'Community events have no user organizer to transfer' })
    }
    if (!(await isEventOrganizer(ev.id, request.userId))) {
      return reply.code(403).send({ error: 'Only the organizer can transfer ownership' })
    }
    const targetUserId = request.body?.targetUserId?.trim() ?? ''
    const password = request.body?.password ?? ''
    if (!targetUserId || !password) {
      return reply.code(400).send({ error: 'targetUserId and password required' })
    }
    const email = request.userEmail
    if (!email) return reply.code(400).send({ error: 'Could not verify account email' })
    if (!(await verifyUserPassword(email, password))) {
      return reply.code(401).send({ error: 'Password incorrect' })
    }
    const { data: part } = await supabaseAdmin
      .from('event_participants')
      .select('status')
      .eq('event_id', ev.id)
      .eq('user_id', targetUserId)
      .eq('status', 'joined')
      .maybeSingle()
    if (!part) return reply.code(400).send({ error: 'Target must be a joined participant' })
    try {
      await revokeEventRole(ev.id, request.userId, 'organizer')
      await grantEventRoles(ev.id, targetUserId, ['organizer'])
      await supabaseAdmin
        .from('events')
        .update({ organizer_user_id: targetUserId })
        .eq('id', ev.id)
    } catch (e) {
      request.log.error(e)
      try {
        await grantEventRoles(ev.id, request.userId, ['organizer'])
        await revokeEventRole(ev.id, targetUserId, 'organizer')
      } catch {
        /* best effort restore */
      }
      return reply.code(500).send({ error: 'Could not transfer organizer' })
    }
    const { data: fresh } = await eventSelect().eq('id', ev.id).maybeSingle()
    return fresh ? await toDto(fresh as EventRow, request.userId) : { ok: true }
  })

  /** GET /events/by-invite/:token — preview for invite link landing */
  app.get<{ Params: { token: string } }>(
    '/events/by-invite/:token',
    { preHandler: requireAuth },
    async (request, reply) => {
      const link = await getEnabledEventInviteLink(request.params.token)
      if (!link) return reply.code(404).send({ error: 'Invite link not found' })
      const { data: row, error } = await eventSelect().eq('id', link.event_id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      if (!(await userCanSeeEvent(ev, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      return await toDto(ev, request.userId)
    },
  )

  /** POST /events/join-by-link — add invited participant via link */
  app.post<{ Body: { token?: string } }>(
    '/events/join-by-link',
    { preHandler: requireAuth },
    async (request, reply) => {
      const token = request.body?.token?.trim()
      if (!token) return reply.code(400).send({ error: 'token required' })

      const link = await getEnabledEventInviteLink(token)
      if (!link) return reply.code(404).send({ error: 'Invite link not found' })

      const { data: row, error } = await eventSelect().eq('id', link.event_id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      if (!(await userCanSeeEvent(ev, request.userId))) {
        return reply.code(403).send({ error: 'Not allowed' })
      }
      const canceled = canceledMessage(ev)
      if (canceled) return reply.code(403).send({ error: canceled })

      const { data: existing } = await supabaseAdmin
        .from('event_participants')
        .select('status')
        .eq('event_id', ev.id)
        .eq('user_id', request.userId)
        .maybeSingle()

      if (!existing) {
        const { error: ins } = await supabaseAdmin.from('event_participants').insert({
          event_id: ev.id,
          user_id: request.userId,
          status: 'invited',
        })
        if (ins) {
          request.log.error(ins)
          return reply.code(500).send({ error: 'Could not join via link' })
        }
      } else if (existing.status !== 'joined' && existing.status !== 'invited') {
        const { error: upd } = await supabaseAdmin
          .from('event_participants')
          .update({ status: 'invited' })
          .eq('event_id', ev.id)
          .eq('user_id', request.userId)
        if (upd) {
          request.log.error(upd)
          return reply.code(500).send({ error: 'Could not join via link' })
        }
      }

      await recordEventInviteJoin(link.id, request.userId)
      const { data: fresh } = await eventSelect().eq('id', ev.id).single()
      return await toDto(fresh as EventRow, request.userId)
    },
  )

  /** GET /events/:id/invite-links — list invite links (organizer) */
  app.get<{ Params: { id: string } }>(
    '/events/:id/invite-links',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      const perm = await assertCanManageEvent(ev, request.userId)
      if (perm !== true) return reply.code(perm.status).send({ error: perm.error })
      const links = await listEventInviteLinks(ev.id)
      return {
        links: links.map((l) => ({
          id: l.id,
          token: l.token,
          enabled: l.enabled,
          createdAt: l.created_at,
        })),
      }
    },
  )

  /** POST /events/:id/invite-links — generate invite link */
  app.post<{ Params: { id: string } }>(
    '/events/:id/invite-links',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      const perm = await assertCanManageEvent(ev, request.userId)
      if (perm !== true) return reply.code(perm.status).send({ error: perm.error })
      const canceled = canceledMessage(ev)
      if (canceled) return reply.code(403).send({ error: canceled })
      try {
        const link = await createEventInviteLink(ev.id, request.userId)
        return reply.code(201).send({
          id: link.id,
          token: link.token,
          enabled: link.enabled,
          createdAt: link.created_at,
        })
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not create invite link' })
      }
    },
  )

  /** PATCH /events/:id/invite-links/:linkId — enable/disable link */
  app.patch<{ Params: { id: string; linkId: string }; Body: { enabled?: boolean } }>(
    '/events/:id/invite-links/:linkId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      const perm = await assertCanManageEvent(ev, request.userId)
      if (perm !== true) return reply.code(perm.status).send({ error: perm.error })
      if (typeof request.body?.enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled boolean required' })
      }
      try {
        await setEventInviteLinkEnabled(request.params.linkId, ev.id, request.body.enabled)
        return { ok: true, enabled: request.body.enabled }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not update invite link' })
      }
    },
  )

  /** DELETE /events/:id/invite-links/:linkId — remove invite link */
  app.delete<{ Params: { id: string; linkId: string } }>(
    '/events/:id/invite-links/:linkId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: row, error } = await eventSelect().eq('id', request.params.id).maybeSingle()
      if (error || !row) return reply.code(404).send({ error: 'Event not found' })
      const ev = row as EventRow
      const perm = await assertCanManageEvent(ev, request.userId)
      if (perm !== true) return reply.code(perm.status).send({ error: perm.error })
      try {
        await deleteEventInviteLink(request.params.linkId, ev.id)
        return { ok: true }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not delete invite link' })
      }
    },
  )
}
