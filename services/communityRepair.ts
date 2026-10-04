/**
 * Repair partial community creates and founder avatar helpers.
 * Layer: service. See community create flow in routes/communities.ts.
 */

import { supabaseAdmin } from './supabase.js'
import {
  processAvatar,
  uploadCommunityAvatar,
  validateAvatarUpload,
  COMMUNITY_SELECT,
  type CommunityRow,
} from './communities.js'
import { grantCommunityRoles, isCommunityAdmin, type CommunityRole } from './roles.js'
import { getMembership, memberCount } from './communities.js'
import {
  addUserToDefaultCommunityChannels,
  createDefaultCommunityChannels,
} from './communityChannels.js'

const FOUNDER_ROLES: CommunityRole[] = ['admin', 'manage_events', 'manage_community']

/** Remove a community row and cascaded links (orphan cleanup on failed create). */
export async function deleteCommunityCascade(communityId: string): Promise<void> {
  await supabaseAdmin.from('communities').delete().eq('id', communityId)
}

/** Ensure created_by is joined member with admin roles + default channels. */
export async function repairCommunityFounder(
  communityId: string,
  userId: string,
): Promise<void> {
  const { data: row } = await supabaseAdmin
    .from('communities')
    .select('created_by')
    .eq('id', communityId)
    .maybeSingle()
  if (!row || row.created_by !== userId) return

  await supabaseAdmin.from('community_members').upsert(
    { community_id: communityId, user_id: userId, status: 'joined' },
    { onConflict: 'community_id,user_id' },
  )
  await grantCommunityRoles(communityId, userId, FOUNDER_ROLES)

  const { count } = await supabaseAdmin
    .from('community_conversations')
    .select('conversation_id', { count: 'exact', head: true })
    .eq('community_id', communityId)
  if ((count ?? 0) === 0) {
    await createDefaultCommunityChannels(communityId, userId)
  } else {
    await addUserToDefaultCommunityChannels(communityId, userId)
  }
}

/** Verify founder membership, admin role, and member count after create steps. */
export async function verifyFounderSetup(
  communityId: string,
  userId: string,
): Promise<boolean> {
  const mem = await getMembership(communityId, userId)
  if (mem?.status !== 'joined') return false
  if (!(await isCommunityAdmin(communityId, userId))) return false
  if ((await memberCount(communityId)) < 1) return false
  return true
}

/** Process and store community avatar; returns updated community row. */
export async function saveCommunityAvatar(
  communityId: string,
  buffer: Buffer,
): Promise<CommunityRow> {
  const validErr = validateAvatarUpload(buffer)
  if (validErr) throw new Error(validErr)
  let webp: Buffer
  try {
    webp = await processAvatar(buffer)
  } catch {
    throw new Error('Invalid image file')
  }
  const storagePath = await uploadCommunityAvatar(communityId, webp)
  const now = new Date().toISOString()
  const { data: row, error } = await supabaseAdmin
    .from('communities')
    .update({ avatar_storage_path: storagePath, avatar_updated_at: now })
    .eq('id', communityId)
    .select(COMMUNITY_SELECT)
    .single()
  if (error || !row) throw new Error('Could not save avatar')
  return row as CommunityRow
}

/**
 * Check avatar upload permission; repairs founder if created_by with missing roles.
 * @returns null if allowed; error message if denied
 */
export async function assertCommunityAvatarUpload(
  communityId: string,
  userId: string,
  createdBy: string,
): Promise<string | null> {
  let mem = await getMembership(communityId, userId)
  if (!mem || mem.status !== 'joined') {
    if (createdBy === userId) {
      await repairCommunityFounder(communityId, userId)
      mem = await getMembership(communityId, userId)
    }
    if (!mem || mem.status !== 'joined') return 'Not a community member'
  }
  if (!(await isCommunityAdmin(communityId, userId))) {
    if (createdBy === userId) {
      await repairCommunityFounder(communityId, userId)
    }
    if (!(await isCommunityAdmin(communityId, userId))) return 'Admin only'
  }
  return null
}
