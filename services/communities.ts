/**
 * Community helpers: avatar upload, membership checks, signed URLs.
 * Layer: service. Mutations via supabaseAdmin. See `.cursor/rules/communities.mdc`.
 * Roles live in `community_member_roles` (see `services/roles.ts`).
 */

import { supabaseAdmin } from './supabase.js'
import { processProfileAvatar } from './imageCompression.js'

export const COMMUNITY_AVATARS_BUCKET = 'community-avatars'
export const MAX_AVATAR_INPUT_BYTES = 2 * 1024 * 1024

export type CommunityRow = {
  id: string
  name: string
  identifier: string
  description: string | null
  join_mode: 'public' | 'invite_visible' | 'invite_hidden'
  created_by: string
  avatar_storage_path: string | null
  avatar_updated_at: string | null
  moderation_hidden_at?: string | null
  created_at: string
  updated_at: string
}

export type MemberRow = {
  community_id: string
  user_id: string
  status: string
  joined_at: string
}

export const COMMUNITY_SELECT_CORE =
  'id, name, identifier, description, join_mode, created_by, avatar_storage_path, avatar_updated_at, created_at, updated_at'

export const COMMUNITY_SELECT = COMMUNITY_SELECT_CORE

export function validateAvatarUpload(buffer: Buffer): string | null {
  if (!buffer.length) return 'Empty file'
  if (buffer.length > MAX_AVATAR_INPUT_BYTES) {
    return `File exceeds max size (${MAX_AVATAR_INPUT_BYTES} bytes)`
  }
  return null
}

export async function processAvatar(buffer: Buffer): Promise<Buffer> {
  return processProfileAvatar(buffer)
}

export function communityAvatarPath(communityId: string): string {
  return `${communityId}/avatar.webp`
}

export async function uploadCommunityAvatar(communityId: string, webp: Buffer): Promise<string> {
  const path = communityAvatarPath(communityId)
  const { error } = await supabaseAdmin.storage
    .from(COMMUNITY_AVATARS_BUCKET)
    .upload(path, webp, { contentType: 'image/webp', upsert: true })
  if (error) throw error
  return path
}

export async function createCommunityAvatarUrl(
  storagePath: string,
  expiresIn = 86400,
): Promise<string | null> {
  if (!storagePath) return null
  const { data, error } = await supabaseAdmin.storage
    .from(COMMUNITY_AVATARS_BUCKET)
    .createSignedUrl(storagePath, expiresIn)
  if (error) throw error
  return data.signedUrl
}

export async function communityAvatarUrlsForPaths(
  paths: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const unique = [...new Set(paths.filter((p): p is string => Boolean(p)))]
  await Promise.all(
    unique.map(async (path) => {
      try {
        const url = await createCommunityAvatarUrl(path)
        if (url) map.set(path, url)
      } catch { /* skip */ }
    }),
  )
  return map
}

export async function getMembership(
  communityId: string,
  userId: string,
): Promise<MemberRow | null> {
  const { data } = await supabaseAdmin
    .from('community_members')
    .select('community_id, user_id, status, joined_at')
    .eq('community_id', communityId)
    .eq('user_id', userId)
    .maybeSingle()
  return data as MemberRow | null
}

export async function memberCount(communityId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('community_members')
    .select('user_id', { count: 'exact', head: true })
    .eq('community_id', communityId)
    .eq('status', 'joined')
  if (error) throw error
  return count ?? 0
}
