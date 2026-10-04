/**
 * Event helpers: create with group chat, RSVP, join-limit, archive window.
 * Layer: service. Mutations via supabaseAdmin. See `.cursor/rules/events.mdc`.
 */

import { supabaseAdmin } from './supabase.js'

/** No new messages after this many ms past `ends_at`. */
export const EVENT_CHAT_ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

export type EventRow = {
  id: string
  organizer_user_id: string | null
  organizer_community_id: string | null
  organizer_conversation_id?: string | null
  visibility: 'public' | 'friends' | 'community' | 'channel'
  title: string
  description: string | null
  starts_at: string
  ends_at: string
  location_text: string | null
  location_short_text: string | null
  location_lat: number | null
  location_lng: number | null
  join_limit: number
  conversation_id: string | null
  chat_archived_at: string | null
  canceled_at: string | null
  is_repeating?: boolean
  parent_event_id?: string | null
  cover_storage_path: string | null
  cover_updated_at: string | null
  moderation_hidden_at?: string | null
  created_at: string
  updated_at: string
}

export const EVENT_SELECT_CORE =
  'id, organizer_user_id, organizer_community_id, organizer_conversation_id, visibility, title, description, starts_at, ends_at, location_text, location_short_text, location_lat, location_lng, join_limit, conversation_id, chat_archived_at, canceled_at, cover_storage_path, cover_updated_at, created_at, updated_at'

/**
 * Prefer full select after migrations. Soft-fallback callers may still use CORE
 * if `is_repeating` / `parent_event_id` columns are missing.
 */
export const EVENT_SELECT = `${EVENT_SELECT_CORE}, is_repeating, parent_event_id, moderation_hidden_at`

/** Series root id: children always point at the original root. */
export function seriesRootId(ev: { id: string; parent_event_id?: string | null }): string {
  return ev.parent_event_id ?? ev.id
}

/**
 * Accepted-friend profile ids for a user (unordered).
 */
export async function acceptedFriendIds(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('friend_requests')
    .select('requester_id, addressee_id')
    .eq('status', 'accepted')
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
  if (error) throw error
  return (data ?? []).map((r) => (r.requester_id === userId ? r.addressee_id : r.requester_id))
}

/**
 * Whether `userId` may see this event (service_role; does not rely on RLS).
 */
export async function userCanSeeEvent(row: EventRow, userId: string): Promise<boolean> {
  if (row.visibility === 'public') return true
  if (row.organizer_user_id === userId) return true
  if (row.visibility === 'friends') {
    const { data } = await supabaseAdmin
      .from('event_visible_friends')
      .select('user_id')
      .eq('event_id', row.id)
      .eq('user_id', userId)
      .maybeSingle()
    return Boolean(data)
  }
  if (row.visibility === 'community' && row.organizer_community_id) {
    const { data } = await supabaseAdmin
      .from('community_members')
      .select('user_id')
      .eq('community_id', row.organizer_community_id)
      .eq('user_id', userId)
      .maybeSingle()
    return Boolean(data)
  }
  if (row.visibility === 'channel' && row.organizer_conversation_id) {
    const { data: member } = await supabaseAdmin
      .from('conversation_members')
      .select('user_id')
      .eq('conversation_id', row.organizer_conversation_id)
      .eq('user_id', userId)
      .maybeSingle()
    if (member) return true
    if (row.organizer_community_id) {
      const { data: roles } = await supabaseAdmin
        .from('community_member_roles')
        .select('role')
        .eq('community_id', row.organizer_community_id)
        .eq('user_id', userId)
      const slugs = (roles ?? []).map((r) => r.role as string)
      if (slugs.includes('admin') || slugs.includes('manage_events')) return true
    }
  }
  return false
}

/**
 * PostgREST `or` filter for list queries (public, organizer, friends rows, community/channel).
 */
export async function visibleEventsOrFilter(userId: string): Promise<string> {
  const [{ data: friendRows }, { data: memberships }, { data: channelMemberships }, { data: manageRoles }] =
    await Promise.all([
      supabaseAdmin.from('event_visible_friends').select('event_id').eq('user_id', userId),
      supabaseAdmin.from('community_members').select('community_id').eq('user_id', userId),
      supabaseAdmin.from('conversation_members').select('conversation_id').eq('user_id', userId),
      supabaseAdmin
        .from('community_member_roles')
        .select('community_id')
        .eq('user_id', userId)
        .in('role', ['admin', 'manage_events']),
    ])
  const friendIds = (friendRows ?? []).map((r) => r.event_id as string)
  const communityIds = (memberships ?? []).map((r) => r.community_id as string)
  const conversationIds = (channelMemberships ?? []).map((r) => r.conversation_id as string)
  const managedCommunityIds = [
    ...new Set((manageRoles ?? []).map((r) => r.community_id as string)),
  ]
  const parts = [`visibility.eq.public`, `organizer_user_id.eq.${userId}`]
  if (friendIds.length) parts.push(`id.in.(${friendIds.join(',')})`)
  if (communityIds.length) {
    parts.push(`and(visibility.eq.community,organizer_community_id.in.(${communityIds.join(',')}))`)
  }
  if (conversationIds.length) {
    parts.push(
      `and(visibility.eq.channel,organizer_conversation_id.in.(${conversationIds.join(',')}))`,
    )
  }
  if (managedCommunityIds.length) {
    parts.push(
      `and(visibility.eq.channel,organizer_community_id.in.(${managedCommunityIds.join(',')}))`,
    )
  }
  return parts.join(',')
}

export type ParticipantStatus = 'invited' | 'interested' | 'joined' | 'denied'

/**
 * If this conversation is an event chat past max(ends_at)+3d among open
 * occurrences (or all canceled), stamp archived_at and return true.
 * Multiple events may share one conversation_id (series).
 */
export async function eventChatWriteBlocked(conversationId: string): Promise<boolean> {
  const { data: conv } = await supabaseAdmin
    .from('conversations')
    .select('id, type, archived_at')
    .eq('id', conversationId)
    .maybeSingle()

  if (!conv || conv.type !== 'event') return false
  if (conv.archived_at) return true

  const { data: events } = await supabaseAdmin
    .from('events')
    .select('id, ends_at, canceled_at')
    .eq('conversation_id', conversationId)

  if (!events?.length) return false

  const open = events.filter((e) => !e.canceled_at)
  if (open.length === 0) {
    await archiveEventChat(conversationId, events[0]!.id as string)
    return true
  }

  let maxEnds = 0
  for (const e of open) {
    const t = new Date(e.ends_at as string).getTime()
    if (t > maxEnds) maxEnds = t
  }
  const archiveAt = maxEnds + EVENT_CHAT_ARCHIVE_AFTER_MS
  if (Date.now() <= archiveAt) return false

  await archiveEventChat(conversationId, open[0]!.id as string)
  return true
}

/**
 * Create an event conversation and add the organizer as admin.
 */
export async function createEventConversation(organizerUserId: string): Promise<string> {
  const { data: conversation, error: convError } = await supabaseAdmin
    .from('conversations')
    .insert({ type: 'event' })
    .select('id')
    .single()

  if (convError || !conversation) {
    throw convError ?? new Error('Could not create event chat')
  }

  const { error: memberError } = await supabaseAdmin.from('conversation_members').insert({
    conversation_id: conversation.id,
    user_id: organizerUserId,
    role: 'admin',
  })

  if (memberError) {
    await supabaseAdmin.from('conversations').delete().eq('id', conversation.id)
    throw memberError
  }

  return conversation.id
}

/** Count joined rows for an event (does not take a lock; caller must re-check on insert). */
export async function countJoined(eventId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('event_participants')
    .select('user_id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .eq('status', 'joined')

  if (error) throw error
  return count ?? 0
}

/**
 * Ensure the user is a conversation member (join path).
 */
export async function addEventChatMember(conversationId: string, userId: string): Promise<void> {
  const { error } = await supabaseAdmin.from('conversation_members').upsert(
    {
      conversation_id: conversationId,
      user_id: userId,
      role: 'member',
    },
    { onConflict: 'conversation_id,user_id' },
  )
  if (error) throw error
}

/**
 * Stamp event chat archived (cancel or ends_at+3d).
 * Stamps chat_archived_at on all events sharing the conversation.
 */
export async function archiveEventChat(conversationId: string, _eventId?: string): Promise<void> {
  const now = new Date().toISOString()
  await supabaseAdmin.from('conversations').update({ archived_at: now }).eq('id', conversationId)
  await supabaseAdmin
    .from('events')
    .update({ chat_archived_at: now })
    .eq('conversation_id', conversationId)
}

/**
 * Clear archive stamps so the shared event chat accepts writes again (redo).
 */
export async function unarchiveEventChat(conversationId: string, _eventId?: string): Promise<void> {
  await supabaseAdmin.from('conversations').update({ archived_at: null }).eq('id', conversationId)
  await supabaseAdmin
    .from('events')
    .update({ chat_archived_at: null })
    .eq('conversation_id', conversationId)
}

/**
 * True when the conversation still has a non-canceled occurrence that is not
 * yet past ends_at+3d (series-aware).
 */
export async function seriesChatStillOpen(conversationId: string): Promise<boolean> {
  const { data: events } = await supabaseAdmin
    .from('events')
    .select('id, ends_at, canceled_at')
    .eq('conversation_id', conversationId)
  const open = (events ?? []).filter((e) => !e.canceled_at)
  if (!open.length) return false
  const now = Date.now()
  let maxEnds = 0
  for (const e of open) {
    const t = new Date(e.ends_at as string).getTime()
    if (t > maxEnds) maxEnds = t
  }
  return now <= maxEnds + EVENT_CHAT_ARCHIVE_AFTER_MS
}

/**
 * Remove chat membership only if the user is not joined on any other event
 * that shares this conversation.
 */
export async function removeEventChatMemberIfUnused(
  conversationId: string,
  userId: string,
  exceptEventId: string,
): Promise<void> {
  const { data: siblings } = await supabaseAdmin
    .from('events')
    .select('id')
    .eq('conversation_id', conversationId)
  const otherIds = (siblings ?? []).map((e) => e.id as string).filter((id) => id !== exceptEventId)
  if (otherIds.length) {
    const { data: stillJoined } = await supabaseAdmin
      .from('event_participants')
      .select('event_id')
      .eq('user_id', userId)
      .eq('status', 'joined')
      .in('event_id', otherIds)
      .limit(1)
    if (stillJoined?.length) return
  }
  await supabaseAdmin
    .from('conversation_members')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
}

/**
 * Archive event chats that are canceled or past ends_at+3d (list endpoint sync).
 * Series-aware: one conversation may map to many events.
 */
export async function syncStaleEventChatArchives(conversationIds: string[]): Promise<void> {
  if (conversationIds.length === 0) return

  const unique = [...new Set(conversationIds)]
  for (const convId of unique) {
    await eventChatWriteBlocked(convId)
  }
}

/**
 * Ensure chat membership for every joined participant across a series (or single event).
 */
export async function syncJoinedMembersToEventChat(
  conversationId: string,
  eventIds: string[],
): Promise<void> {
  if (!eventIds.length) return
  const { data: parts } = await supabaseAdmin
    .from('event_participants')
    .select('user_id')
    .in('event_id', eventIds)
    .eq('status', 'joined')
  const ids = [...new Set((parts ?? []).map((p) => p.user_id as string))]
  for (const uid of ids) {
    await addEventChatMember(conversationId, uid)
  }
}

/**
 * Event ids in the same series as `ev` (root + children).
 */
export async function seriesEventIds(ev: {
  id: string
  parent_event_id?: string | null
}): Promise<string[]> {
  const rootId = seriesRootId(ev)
  const { data: rows } = await supabaseAdmin
    .from('events')
    .select('id')
    .or(`id.eq.${rootId},parent_event_id.eq.${rootId}`)
  const ids = (rows ?? []).map((r) => r.id as string)
  if (!ids.includes(rootId)) ids.push(rootId)
  if (!ids.includes(ev.id)) ids.push(ev.id)
  return [...new Set(ids)]
}

/**
 * Create or reopen an event chat for this series and attach joined members.
 * New chats get a creator welcome; existing archived chats are unarchived only.
 * Returns the conversation id.
 */
export async function enableEventChatForSeries(
  ev: EventRow,
  actorUserId: string,
  opts?: { title?: string; sendWelcome?: (conversationId: string) => Promise<void> },
): Promise<string> {
  const ids = await seriesEventIds(ev)
  const { data: rows } = await supabaseAdmin
    .from('events')
    .select('id, conversation_id')
    .in('id', ids)
  const existing = (rows ?? [])
    .map((r) => r.conversation_id as string | null)
    .find((cid): cid is string => Boolean(cid))

  if (existing) {
    await unarchiveEventChat(existing)
    await supabaseAdmin
      .from('events')
      .update({ conversation_id: existing, chat_archived_at: null })
      .in('id', ids)
    await syncJoinedMembersToEventChat(existing, ids)
    return existing
  }

  const conversationId = await createEventConversation(actorUserId)
  await supabaseAdmin.from('events').update({ conversation_id: conversationId }).in('id', ids)
  await syncJoinedMembersToEventChat(conversationId, ids)
  if (opts?.sendWelcome) {
    await opts.sendWelcome(conversationId)
  }
  return conversationId
}

