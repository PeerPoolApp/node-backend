/**
 * Dynamic community/event role helpers. Mutations via supabaseAdmin.
 * Layer: service. See `.cursor/rules/communities.mdc` Phase 2.
 */

import { supabaseAdmin, supabaseAuth } from './supabase.js'

export const COMMUNITY_ROLES = ['admin', 'manage_events', 'manage_community'] as const
export type CommunityRole = (typeof COMMUNITY_ROLES)[number]

export const EVENT_ROLES = ['organizer', 'manage_event'] as const
export type EventRole = (typeof EVENT_ROLES)[number]

export function isCommunityRole(role: string): role is CommunityRole {
  return (COMMUNITY_ROLES as readonly string[]).includes(role)
}

export function isEventRole(role: string): role is EventRole {
  return (EVENT_ROLES as readonly string[]).includes(role)
}

export async function getCommunityRoles(
  communityId: string,
  userId: string,
): Promise<CommunityRole[]> {
  const { data } = await supabaseAdmin
    .from('community_member_roles')
    .select('role')
    .eq('community_id', communityId)
    .eq('user_id', userId)
  return (data ?? []).map((r) => r.role as CommunityRole)
}

export async function getCommunityRolesMap(
  communityId: string,
  userIds: string[],
): Promise<Map<string, CommunityRole[]>> {
  const map = new Map<string, CommunityRole[]>()
  for (const id of userIds) map.set(id, [])
  if (userIds.length === 0) return map
  const { data } = await supabaseAdmin
    .from('community_member_roles')
    .select('user_id, role')
    .eq('community_id', communityId)
    .in('user_id', userIds)
  for (const row of data ?? []) {
    const list = map.get(row.user_id as string) ?? []
    list.push(row.role as CommunityRole)
    map.set(row.user_id as string, list)
  }
  return map
}

export async function hasCommunityRole(
  communityId: string,
  userId: string,
  role: CommunityRole,
): Promise<boolean> {
  const roles = await getCommunityRoles(communityId, userId)
  if (roles.includes('admin')) return true
  return roles.includes(role)
}

export async function isCommunityAdmin(communityId: string, userId: string): Promise<boolean> {
  const roles = await getCommunityRoles(communityId, userId)
  return roles.includes('admin')
}

export async function canManageCommunity(communityId: string, userId: string): Promise<boolean> {
  return hasCommunityRole(communityId, userId, 'manage_community')
}

export async function canManageCommunityEvents(
  communityId: string,
  userId: string,
): Promise<boolean> {
  return hasCommunityRole(communityId, userId, 'manage_events')
}

export async function grantCommunityRoles(
  communityId: string,
  userId: string,
  roles: CommunityRole[],
): Promise<void> {
  if (roles.length === 0) return
  const { error } = await supabaseAdmin.from('community_member_roles').upsert(
    roles.map((role) => ({ community_id: communityId, user_id: userId, role })),
    { onConflict: 'community_id,user_id,role', ignoreDuplicates: true },
  )
  if (error) throw error
}

export async function revokeCommunityRole(
  communityId: string,
  userId: string,
  role: CommunityRole,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('community_member_roles')
    .delete()
    .eq('community_id', communityId)
    .eq('user_id', userId)
    .eq('role', role)
  if (error) throw error
}

export async function getEventRoles(eventId: string, userId: string): Promise<EventRole[]> {
  const { data } = await supabaseAdmin
    .from('event_member_roles')
    .select('role')
    .eq('event_id', eventId)
    .eq('user_id', userId)
  return (data ?? []).map((r) => r.role as EventRole)
}

export async function isEventOrganizer(eventId: string, userId: string): Promise<boolean> {
  const roles = await getEventRoles(eventId, userId)
  return roles.includes('organizer')
}

export async function canManageEvent(
  eventId: string,
  userId: string,
  opts?: { organizerCommunityId?: string | null; organizerUserId?: string | null },
): Promise<boolean> {
  if (opts?.organizerCommunityId) {
    return canManageCommunityEvents(opts.organizerCommunityId, userId)
  }
  const roles = await getEventRoles(eventId, userId)
  if (roles.includes('organizer') || roles.includes('manage_event')) return true
  if (opts?.organizerUserId === userId) return true
  return false
}

export async function grantEventRoles(
  eventId: string,
  userId: string,
  roles: EventRole[],
): Promise<void> {
  if (roles.length === 0) return
  const { error } = await supabaseAdmin.from('event_member_roles').upsert(
    roles.map((role) => ({ event_id: eventId, user_id: userId, role })),
    { onConflict: 'event_id,user_id,role', ignoreDuplicates: true },
  )
  if (error) throw error
}

export async function revokeEventRole(
  eventId: string,
  userId: string,
  role: EventRole,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('event_member_roles')
    .delete()
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .eq('role', role)
  if (error) throw error
}

/** Verify the user's password (email + password via Supabase Auth). */
export async function verifyUserPassword(
  email: string,
  password: string,
): Promise<boolean> {
  if (!email || !password) return false
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password })
  return Boolean(data.user) && !error
}
