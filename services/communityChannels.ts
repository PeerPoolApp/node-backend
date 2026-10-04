/**
 * Community chats: default Announcement, membership sync, write ACL.
 * Layer: service. Mutations via supabaseAdmin. See `.cursor/rules/communities.mdc`.
 */

import { supabaseAdmin } from './supabase.js'
import { avatarUrlsForPaths } from './avatars.js'
import { getCommunityRoles, getCommunityRolesMap, type CommunityRole } from './roles.js'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'
import { sendCreatorWelcomeMessage } from './conversations.js'

export type ChannelKind = 'general' | 'announcement' | 'custom'
export type ChannelWriteMode = 'all_members' | 'manage_community' | 'explicit'

export type CommunityConversationRow = {
  community_id: string
  conversation_id: string
  name: string
  kind: ChannelKind
  write_mode: ChannelWriteMode
  position: number
  created_at: string
}

/** Announcement only on create. Legacy communities may still have General. Customs insert under Announcement. */
const DEFAULT_CHANNELS: Array<{
  name: string
  kind: ChannelKind
  write_mode: ChannelWriteMode
  position: number
}> = [
  { name: 'Announcement', kind: 'announcement', write_mode: 'manage_community', position: 0 },
]

/** Create Announcement and add founder as conversation member. */
export async function createDefaultCommunityChannels(
  communityId: string,
  founderUserId: string,
): Promise<void> {
  for (const ch of DEFAULT_CHANNELS) {
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .insert({ type: 'community' })
      .select('id')
      .single()
    if (convErr || !conv) throw convErr ?? new Error('Could not create chat')

    const { error: linkErr } = await supabaseAdmin.from('community_conversations').insert({
      community_id: communityId,
      conversation_id: conv.id,
      name: ch.name,
      kind: ch.kind,
      write_mode: ch.write_mode,
      position: ch.position,
    })
    if (linkErr) throw linkErr

    const { error: memErr } = await supabaseAdmin.from('conversation_members').insert({
      conversation_id: conv.id,
      user_id: founderUserId,
      role: 'member',
    })
    if (memErr) throw memErr

    await sendCreatorWelcomeMessage(conv.id, founderUserId, ch.name)
  }
}

/** Add user to Announcement (and legacy General when present). */
export async function addUserToDefaultCommunityChannels(
  communityId: string,
  userId: string,
): Promise<void> {
  const { data: channels, error } = await supabaseAdmin
    .from('community_conversations')
    .select('conversation_id')
    .eq('community_id', communityId)
    .in('kind', ['general', 'announcement'])
  if (error) throw error
  if (!channels?.length) return

  const rows = channels.map((c) => ({
    conversation_id: c.conversation_id as string,
    user_id: userId,
    role: 'member' as const,
  }))
  const { error: memErr } = await supabaseAdmin
    .from('conversation_members')
    .upsert(rows, { onConflict: 'conversation_id,user_id', ignoreDuplicates: true })
  if (memErr) throw memErr
}

/** Remove user from every conversation linked to this community (defaults + custom + leaves orphans intact). */
export async function removeUserFromCommunityChannels(
  communityId: string,
  userId: string,
): Promise<void> {
  const { data: channels, error } = await supabaseAdmin
    .from('community_conversations')
    .select('conversation_id')
    .eq('community_id', communityId)
  if (error) throw error
  const ids = (channels ?? []).map((c) => c.conversation_id as string)
  if (!ids.length) return
  const { error: delErr } = await supabaseAdmin
    .from('conversation_members')
    .delete()
    .eq('user_id', userId)
    .in('conversation_id', ids)
  if (delErr) throw delErr
}

export async function getCommunityChannelByConversation(
  conversationId: string,
): Promise<CommunityConversationRow | null> {
  const { data, error } = await supabaseAdmin
    .from('community_conversations')
    .select('community_id, conversation_id, name, kind, write_mode, position, created_at')
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) throw error
  return data as CommunityConversationRow | null
}

/** Resolve communityId for a conversation (channel link or community-organized event). */
export async function resolveCommunityIdForConversation(
  conversationId: string,
): Promise<string | null> {
  const channel = await getCommunityChannelByConversation(conversationId)
  if (channel) return channel.community_id

  const { data: ev } = await supabaseAdmin
    .from('events')
    .select('organizer_community_id')
    .eq('conversation_id', conversationId)
    .maybeSingle()
  return (ev?.organizer_community_id as string | null | undefined) ?? null
}

/**
 * Whether the user may send/edit messages in this community channel.
 * Returns null if not a community channel (caller uses normal membership).
 * Returns false if community channel but write denied.
 */
export async function assertCanWriteCommunityChannel(
  conversationId: string,
  userId: string,
): Promise<boolean | null> {
  const channel = await getCommunityChannelByConversation(conversationId)
  if (!channel) return null

  if (channel.write_mode === 'all_members') return true
  if (channel.write_mode === 'explicit') return true
  if (channel.write_mode === 'manage_community') {
    const roles = await getCommunityRoles(channel.community_id, userId)
    if (channel.kind === 'announcement') {
      return (
        roles.includes('admin') ||
        roles.includes('manage_community') ||
        roles.includes('manage_events')
      )
    }
    return roles.includes('admin') || roles.includes('manage_community')
  }
  return false
}

/**
 * Create a custom channel (admin / manage_community).
 * Inserts immediately under Announcement (position 1); optional role/member ACL.
 */
export async function createCustomCommunityChannel(input: {
  communityId: string
  name: string
  creatorUserId: string
  roleAccess?: CommunityRole[]
  memberIds?: string[]
}): Promise<CommunityConversationRow> {
  const name = input.name.trim()
  if (!name) throw new Error('Name is required')
  if (exceedsLimit(name, TEXT_LIMITS.communityChannelName)) {
    throw new Error(`Name must be at most ${TEXT_LIMITS.communityChannelName} characters`)
  }

  const { data: conv, error: convErr } = await supabaseAdmin
    .from('conversations')
    .insert({ type: 'community' })
    .select('id')
    .single()
  if (convErr || !conv) throw convErr ?? new Error('Could not create chat')

  // Shift everything under Announcement (pos >= 1) down by one slot.
  const { data: toShift, error: shiftErr } = await supabaseAdmin
    .from('community_conversations')
    .select('conversation_id, position')
    .eq('community_id', input.communityId)
    .gte('position', 1)
    .order('position', { ascending: false })
  if (shiftErr) throw shiftErr
  for (const row of toShift ?? []) {
    const { error } = await supabaseAdmin
      .from('community_conversations')
      .update({ position: (row.position as number) + 1 })
      .eq('community_id', input.communityId)
      .eq('conversation_id', row.conversation_id as string)
    if (error) throw error
  }

  const { data: link, error: linkErr } = await supabaseAdmin
    .from('community_conversations')
    .insert({
      community_id: input.communityId,
      conversation_id: conv.id,
      name,
      kind: 'custom',
      write_mode: 'explicit',
      position: 1,
    })
    .select('community_id, conversation_id, name, kind, write_mode, position, created_at')
    .single()
  if (linkErr || !link) throw linkErr ?? new Error('Could not link channel')

  const { error: memErr } = await supabaseAdmin.from('conversation_members').insert({
    conversation_id: conv.id,
    user_id: input.creatorUserId,
    role: 'admin',
  })
  if (memErr) throw memErr

  await sendCreatorWelcomeMessage(conv.id, input.creatorUserId, name)

  const roles = input.roleAccess ?? []
  if (roles.length) {
    await setChannelRoleAccess(input.communityId, conv.id, roles)
  }

  const memberIds = [...new Set((input.memberIds ?? []).filter((id) => id && id !== input.creatorUserId))]
  for (const userId of memberIds) {
    try {
      await addChannelMember(input.communityId, conv.id, userId)
    } catch {
      /* skip non-joined / invalid */
    }
  }

  return link as CommunityConversationRow
}

/**
 * Persist shared channel order for all members.
 * `conversationIds` is the manager's visible order; any channels they cannot see
 * are appended in prior position order. Announcement is movable.
 */
export async function reorderCommunityChannels(
  communityId: string,
  conversationIds: string[],
): Promise<void> {
  const { data: rows, error } = await supabaseAdmin
    .from('community_conversations')
    .select('conversation_id, kind, position')
    .eq('community_id', communityId)
  if (error) throw error
  const existing = rows ?? []
  if (!existing.length) return

  const existingById = new Map(
    existing.map((r) => [r.conversation_id as string, r]),
  )
  for (const id of conversationIds) {
    if (!existingById.has(id)) throw new Error('Unknown channel in order')
  }
  if (new Set(conversationIds).size !== conversationIds.length) {
    throw new Error('Duplicate channel in order')
  }

  const seen = new Set<string>()
  const final: string[] = []
  for (const id of conversationIds) {
    if (seen.has(id)) continue
    final.push(id)
    seen.add(id)
  }
  const rest = existing
    .filter((r) => !seen.has(r.conversation_id as string))
    .sort((a, b) => (a.position as number) - (b.position as number))
  for (const r of rest) final.push(r.conversation_id as string)

  for (let i = 0; i < final.length; i++) {
    const { error: upErr } = await supabaseAdmin
      .from('community_conversations')
      .update({ position: -(i + 1) })
      .eq('community_id', communityId)
      .eq('conversation_id', final[i]!)
    if (upErr) throw upErr
  }
  for (let i = 0; i < final.length; i++) {
    const { error: upErr } = await supabaseAdmin
      .from('community_conversations')
      .update({ position: i })
      .eq('community_id', communityId)
      .eq('conversation_id', final[i]!)
    if (upErr) throw upErr
  }
}

export type ChannelSettingsDto = {
  conversationId: string
  communityId: string
  name: string
  kind: ChannelKind
  writeMode: ChannelWriteMode
  roleAccess: CommunityRole[]
  memberCount: number
}

export type ChannelMemberDto = {
  userId: string
  fullName: string | null
  username: string | null
  avatarUrl: string | null
  avatarUpdatedAt: string | null
}

const ASSIGNABLE_CHANNEL_ROLES = new Set<CommunityRole>([
  'admin',
  'manage_events',
  'manage_community',
])

async function assertCustomChannel(
  communityId: string,
  conversationId: string,
): Promise<CommunityConversationRow> {
  const channel = await getCommunityChannelByConversation(conversationId)
  if (!channel || channel.community_id !== communityId) {
    throw new Error('Channel not found')
  }
  if (channel.kind !== 'custom') {
    throw new Error('Only custom channels can be edited')
  }
  return channel
}

/** Load channel meta for settings UI (managers only). */
export async function getChannelSettings(
  communityId: string,
  conversationId: string,
): Promise<ChannelSettingsDto | null> {
  const channel = await getCommunityChannelByConversation(conversationId)
  if (!channel || channel.community_id !== communityId) return null

  const { data: accessRows } = await supabaseAdmin
    .from('community_conversation_role_access')
    .select('role')
    .eq('community_id', communityId)
    .eq('conversation_id', conversationId)

  const { count } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)

  return {
    conversationId,
    communityId,
    name: channel.name,
    kind: channel.kind,
    writeMode: channel.write_mode,
    roleAccess: (accessRows ?? []).map((r) => r.role as CommunityRole),
    memberCount: count ?? 0,
  }
}

export async function patchCustomChannelName(
  communityId: string,
  conversationId: string,
  name: string,
): Promise<string> {
  await assertCustomChannel(communityId, conversationId)
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Name is required')
  if (exceedsLimit(trimmed, TEXT_LIMITS.communityChannelName)) {
    throw new Error(`Name must be at most ${TEXT_LIMITS.communityChannelName} characters`)
  }
  const { error } = await supabaseAdmin
    .from('community_conversations')
    .update({ name: trimmed })
    .eq('community_id', communityId)
    .eq('conversation_id', conversationId)
  if (error) throw error
  return trimmed
}

/**
 * Unlink a custom channel (orphan conversation + messages).
 * Announcement and General cannot be deleted.
 */
export async function deleteCustomCommunityChannel(
  communityId: string,
  conversationId: string,
): Promise<void> {
  const channel = await getCommunityChannelByConversation(conversationId)
  if (!channel || channel.community_id !== communityId) {
    const err = new Error('Channel not found') as Error & { statusCode?: number }
    err.statusCode = 404
    throw err
  }
  if (channel.kind !== 'custom') {
    const err = new Error('Announcement and General chats cannot be deleted') as Error & {
      statusCode?: number
    }
    err.statusCode = 403
    throw err
  }

  const { count } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('organizer_conversation_id', conversationId)
  if ((count ?? 0) > 0) {
    const err = new Error('This channel still has events') as Error & { statusCode?: number }
    err.statusCode = 400
    throw err
  }

  const { error: accessErr } = await supabaseAdmin
    .from('community_conversation_role_access')
    .delete()
    .eq('community_id', communityId)
    .eq('conversation_id', conversationId)
  if (accessErr) throw accessErr

  const { error: linkErr } = await supabaseAdmin
    .from('community_conversations')
    .delete()
    .eq('community_id', communityId)
    .eq('conversation_id', conversationId)
  if (linkErr) throw linkErr

  const { error: memErr } = await supabaseAdmin
    .from('conversation_members')
    .delete()
    .eq('conversation_id', conversationId)
  if (memErr) throw memErr
}

/** Paginated channel members for settings UI. */
export async function listChannelMembers(
  communityId: string,
  conversationId: string,
  limit: number,
  cursor?: string,
): Promise<{ members: ChannelMemberDto[]; nextCursor: string | null }> {
  const channel = await getCommunityChannelByConversation(conversationId)
  if (!channel || channel.community_id !== communityId) {
    throw new Error('Channel not found')
  }

  let query = supabaseAdmin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .order('user_id', { ascending: true })
    .limit(limit + 1)
  if (cursor) query = query.gt('user_id', cursor)

  const { data: rows, error } = await query
  if (error) throw error
  const page = rows ?? []
  const extra = page.length > limit
  const slice = extra ? page.slice(0, limit) : page
  const ids = slice.map((r) => r.user_id as string)
  if (!ids.length) return { members: [], nextCursor: null }

  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, username, avatar_storage_path, avatar_updated_at')
    .in('id', ids)

  const urls = await avatarUrlsForPaths(
    (profiles ?? []).map((p) => (p.avatar_storage_path as string | null) ?? null),
  )
  const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]))

  const members: ChannelMemberDto[] = ids.map((uid) => {
    const p = byId.get(uid)
    const path = (p?.avatar_storage_path as string | null) ?? null
    return {
      userId: uid,
      fullName: (p?.full_name as string | null) ?? null,
      username: (p?.username as string | null) ?? null,
      avatarUrl: path ? urls.get(path) ?? null : null,
      avatarUpdatedAt: (p?.avatar_updated_at as string | null) ?? null,
    }
  })

  return {
    members,
    nextCursor: extra ? (ids[ids.length - 1] ?? null) : null,
  }
}

export async function addChannelMember(
  communityId: string,
  conversationId: string,
  userId: string,
): Promise<void> {
  await assertCustomChannel(communityId, conversationId)

  const { data: mem } = await supabaseAdmin
    .from('community_members')
    .select('status')
    .eq('community_id', communityId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!mem || mem.status !== 'joined') {
    throw new Error('User must be a joined community member')
  }

  const { error } = await supabaseAdmin.from('conversation_members').upsert(
    { conversation_id: conversationId, user_id: userId, role: 'member' },
    { onConflict: 'conversation_id,user_id', ignoreDuplicates: true },
  )
  if (error) throw error
}

export async function removeChannelMember(
  communityId: string,
  conversationId: string,
  userId: string,
): Promise<void> {
  await assertCustomChannel(communityId, conversationId)

  const { count } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
  if ((count ?? 0) <= 1) {
    throw new Error('Cannot remove the last channel member')
  }

  const { error } = await supabaseAdmin
    .from('conversation_members')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
  if (error) throw error
}

/** Add all joined community members who hold any granted role. */
export async function syncRoleAccessMembers(
  communityId: string,
  conversationId: string,
): Promise<void> {
  const { data: accessRows } = await supabaseAdmin
    .from('community_conversation_role_access')
    .select('role')
    .eq('community_id', communityId)
    .eq('conversation_id', conversationId)
  const roles = (accessRows ?? []).map((r) => r.role as CommunityRole)
  if (!roles.length) return

  const { data: memberRows } = await supabaseAdmin
    .from('community_members')
    .select('user_id')
    .eq('community_id', communityId)
    .eq('status', 'joined')
  const userIds = (memberRows ?? []).map((r) => r.user_id as string)
  if (!userIds.length) return

  const rolesMap = await getCommunityRolesMap(communityId, userIds)
  const eligible = userIds.filter((uid) => {
    const userRoles = rolesMap.get(uid) ?? []
    return roles.some((r) => userRoles.includes(r))
  })
  if (!eligible.length) return

  const rows = eligible.map((uid) => ({
    conversation_id: conversationId,
    user_id: uid,
    role: 'member' as const,
  }))
  const { error } = await supabaseAdmin
    .from('conversation_members')
    .upsert(rows, { onConflict: 'conversation_id,user_id', ignoreDuplicates: true })
  if (error) throw error
}

/** Replace role_access rows and bulk-add matching community role holders. */
export async function setChannelRoleAccess(
  communityId: string,
  conversationId: string,
  roles: CommunityRole[],
): Promise<CommunityRole[]> {
  await assertCustomChannel(communityId, conversationId)

  const unique = [...new Set(roles.filter((r) => ASSIGNABLE_CHANNEL_ROLES.has(r)))]

  const { error: delErr } = await supabaseAdmin
    .from('community_conversation_role_access')
    .delete()
    .eq('community_id', communityId)
    .eq('conversation_id', conversationId)
  if (delErr) throw delErr

  if (unique.length) {
    const { error: insErr } = await supabaseAdmin.from('community_conversation_role_access').insert(
      unique.map((role) => ({
        community_id: communityId,
        conversation_id: conversationId,
        role,
      })),
    )
    if (insErr) throw insErr
    await syncRoleAccessMembers(communityId, conversationId)
  }

  return unique
}

/**
 * After community role grant/revoke, sync custom channels that list affected roles.
 */
export async function resyncChannelsAfterRoleChange(
  communityId: string,
  userId: string,
): Promise<void> {
  const userRoles = await getCommunityRoles(communityId, userId)

  const { data: channels } = await supabaseAdmin
    .from('community_conversations')
    .select('conversation_id')
    .eq('community_id', communityId)
    .eq('kind', 'custom')
  if (!channels?.length) return

  for (const ch of channels) {
    const convId = ch.conversation_id as string
    const { data: accessRows } = await supabaseAdmin
      .from('community_conversation_role_access')
      .select('role')
      .eq('community_id', communityId)
      .eq('conversation_id', convId)
    const accessRoles = (accessRows ?? []).map((r) => r.role as CommunityRole)
    if (!accessRoles.length) continue

    const stillEligible = accessRoles.some((r) => userRoles.includes(r))
    if (stillEligible) {
      await supabaseAdmin.from('conversation_members').upsert(
        { conversation_id: convId, user_id: userId, role: 'member' },
        { onConflict: 'conversation_id,user_id', ignoreDuplicates: true },
      )
    } else {
      await supabaseAdmin
        .from('conversation_members')
        .delete()
        .eq('conversation_id', convId)
        .eq('user_id', userId)
    }
  }
}
