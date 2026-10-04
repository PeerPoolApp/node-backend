/**
 * Invite link tokens for communities and events (Phase 4).
 * Layer: service. Mutations via supabaseAdmin.
 */

import { randomBytes } from 'node:crypto'
import { supabaseAdmin } from './supabase.js'

export function generateInviteToken(): string {
  return randomBytes(24).toString('base64url')
}

export type CommunityInviteLinkRow = {
  id: string
  community_id: string
  token: string
  enabled: boolean
  created_by: string
  created_at: string
}

export type EventInviteLinkRow = {
  id: string
  event_id: string
  token: string
  enabled: boolean
  created_by: string
  created_at: string
}

export async function getEnabledCommunityInviteLink(
  token: string,
): Promise<CommunityInviteLinkRow | null> {
  const { data } = await supabaseAdmin
    .from('community_invite_links')
    .select('id, community_id, token, enabled, created_by, created_at')
    .eq('token', token)
    .eq('enabled', true)
    .maybeSingle()
  return (data as CommunityInviteLinkRow | null) ?? null
}

export async function getEnabledEventInviteLink(
  token: string,
): Promise<EventInviteLinkRow | null> {
  const { data } = await supabaseAdmin
    .from('event_invite_links')
    .select('id, event_id, token, enabled, created_by, created_at')
    .eq('token', token)
    .eq('enabled', true)
    .maybeSingle()
  return (data as EventInviteLinkRow | null) ?? null
}

export async function createCommunityInviteLink(
  communityId: string,
  createdBy: string,
): Promise<CommunityInviteLinkRow> {
  const token = generateInviteToken()
  const { data, error } = await supabaseAdmin
    .from('community_invite_links')
    .insert({ community_id: communityId, token, created_by: createdBy })
    .select('id, community_id, token, enabled, created_by, created_at')
    .single()
  if (error || !data) throw error ?? new Error('Could not create invite link')
  return data as CommunityInviteLinkRow
}

export async function createEventInviteLink(
  eventId: string,
  createdBy: string,
): Promise<EventInviteLinkRow> {
  const token = generateInviteToken()
  const { data, error } = await supabaseAdmin
    .from('event_invite_links')
    .insert({ event_id: eventId, token, created_by: createdBy })
    .select('id, event_id, token, enabled, created_by, created_at')
    .single()
  if (error || !data) throw error ?? new Error('Could not create invite link')
  return data as EventInviteLinkRow
}

export async function setCommunityInviteLinkEnabled(
  linkId: string,
  communityId: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('community_invite_links')
    .update({ enabled })
    .eq('id', linkId)
    .eq('community_id', communityId)
  if (error) throw error
}

export async function setEventInviteLinkEnabled(
  linkId: string,
  eventId: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('event_invite_links')
    .update({ enabled })
    .eq('id', linkId)
    .eq('event_id', eventId)
  if (error) throw error
}

export async function recordCommunityInviteJoin(linkId: string, userId: string): Promise<void> {
  await supabaseAdmin.from('community_invite_link_joins').upsert(
    { link_id: linkId, user_id: userId },
    { onConflict: 'link_id,user_id', ignoreDuplicates: true },
  )
}

export async function recordEventInviteJoin(linkId: string, userId: string): Promise<void> {
  await supabaseAdmin.from('event_invite_link_joins').upsert(
    { link_id: linkId, user_id: userId },
    { onConflict: 'link_id,user_id', ignoreDuplicates: true },
  )
}

export type FriendInviteLinkRow = {
  id: string
  token: string
  enabled: boolean
  created_by: string
  created_at: string
}

export async function getEnabledFriendInviteLink(
  token: string,
): Promise<FriendInviteLinkRow | null> {
  const { data } = await supabaseAdmin
    .from('friend_invite_links')
    .select('id, token, enabled, created_by, created_at')
    .eq('token', token)
    .eq('enabled', true)
    .maybeSingle()
  return (data as FriendInviteLinkRow | null) ?? null
}

/** Get-or-create a single enabled friend invite link for this user. */
export async function getOrCreateFriendInviteLink(
  createdBy: string,
): Promise<FriendInviteLinkRow> {
  const { data: existingRows } = await supabaseAdmin
    .from('friend_invite_links')
    .select('id, token, enabled, created_by, created_at')
    .eq('created_by', createdBy)
    .eq('enabled', true)
    .order('created_at', { ascending: false })
    .limit(1)
  const existing = existingRows?.[0]
  if (existing) return existing as FriendInviteLinkRow

  const token = generateInviteToken()
  const { data, error } = await supabaseAdmin
    .from('friend_invite_links')
    .insert({ token, created_by: createdBy })
    .select('id, token, enabled, created_by, created_at')
    .single()
  if (error || !data) throw error ?? new Error('Could not create friend invite link')
  return data as FriendInviteLinkRow
}

export async function recordFriendInviteJoin(linkId: string, userId: string): Promise<void> {
  await supabaseAdmin.from('friend_invite_link_joins').upsert(
    { link_id: linkId, user_id: userId },
    { onConflict: 'link_id,user_id', ignoreDuplicates: true },
  )
}

export async function listCommunityInviteLinks(
  communityId: string,
): Promise<CommunityInviteLinkRow[]> {
  const { data, error } = await supabaseAdmin
    .from('community_invite_links')
    .select('id, community_id, token, enabled, created_by, created_at')
    .eq('community_id', communityId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as CommunityInviteLinkRow[]
}

export type InviteLinkJoinedUserRow = {
  userId: string
  fullName: string | null
  username: string | null
  avatarStoragePath: string | null
  avatarUpdatedAt: string | null
}

/** Joins for many links: map linkId → users. */
export async function joinsForCommunityInviteLinks(
  linkIds: string[],
): Promise<Map<string, InviteLinkJoinedUserRow[]>> {
  const map = new Map<string, InviteLinkJoinedUserRow[]>()
  if (!linkIds.length) return map
  const { data: joins, error } = await supabaseAdmin
    .from('community_invite_link_joins')
    .select('link_id, user_id, joined_at')
    .in('link_id', linkIds)
    .order('joined_at', { ascending: true })
  if (error) throw error
  const userIds = [...new Set((joins ?? []).map((j) => j.user_id as string))]
  const profileMap = new Map<
    string,
    {
      full_name: string | null
      username: string | null
      avatar_storage_path: string | null
      avatar_updated_at: string | null
    }
  >()
  if (userIds.length) {
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, username, avatar_storage_path, avatar_updated_at')
      .in('id', userIds)
    for (const p of profiles ?? []) {
      profileMap.set(p.id as string, {
        full_name: (p.full_name as string | null) ?? null,
        username: (p.username as string | null) ?? null,
        avatar_storage_path: (p.avatar_storage_path as string | null) ?? null,
        avatar_updated_at: (p.avatar_updated_at as string | null) ?? null,
      })
    }
  }
  for (const j of joins ?? []) {
    const linkId = j.link_id as string
    const userId = j.user_id as string
    const p = profileMap.get(userId)
    const list = map.get(linkId) ?? []
    list.push({
      userId,
      fullName: p?.full_name ?? null,
      username: p?.username ?? null,
      avatarStoragePath: p?.avatar_storage_path ?? null,
      avatarUpdatedAt: p?.avatar_updated_at ?? null,
    })
    map.set(linkId, list)
  }
  return map
}

export async function deleteCommunityInviteLink(
  linkId: string,
  communityId: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('community_invite_links')
    .delete()
    .eq('id', linkId)
    .eq('community_id', communityId)
  if (error) throw error
}

export async function deleteEventInviteLink(linkId: string, eventId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('event_invite_links')
    .delete()
    .eq('id', linkId)
    .eq('event_id', eventId)
  if (error) throw error
}

export async function listEventInviteLinks(eventId: string): Promise<EventInviteLinkRow[]> {
  const { data, error } = await supabaseAdmin
    .from('event_invite_links')
    .select('id, event_id, token, enabled, created_by, created_at')
    .eq('event_id', eventId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as EventInviteLinkRow[]
}
