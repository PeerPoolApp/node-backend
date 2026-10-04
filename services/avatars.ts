/**
 * Profile avatar processing and Storage helpers.
 * Client sends pre-scaled image; server validates, encodes 256×256 WebP, uploads.
 */

import { supabaseAdmin } from './supabase.js'
import { processProfileAvatar } from './imageCompression.js'

export const PROFILE_AVATARS_BUCKET = 'profile-avatars'
export const AVATAR_SIZE = 256
export const MAX_AVATAR_INPUT_BYTES = 2 * 1024 * 1024

/**
 * Validate raw upload buffer before processing.
 */
export function validateAvatarUpload(buffer: Buffer): string | null {
  if (!buffer.length) return 'Empty file'
  if (buffer.length > MAX_AVATAR_INPUT_BYTES) {
    return `File exceeds max size (${MAX_AVATAR_INPUT_BYTES} bytes)`
  }
  return null
}

/**
 * Resize and encode avatar as WebP 256×256 cover crop.
 */
export async function processAvatar(buffer: Buffer): Promise<Buffer> {
  return processProfileAvatar(buffer)
}

export function avatarStoragePath(userId: string): string {
  return `${userId}/avatar.webp`
}

/**
 * Upload processed WebP to profile-avatars bucket (upsert).
 */
export async function uploadProfileAvatar(userId: string, webpBuffer: Buffer): Promise<string> {
  const path = avatarStoragePath(userId)
  const { error } = await supabaseAdmin.storage
    .from(PROFILE_AVATARS_BUCKET)
    .upload(path, webpBuffer, {
      contentType: 'image/webp',
      upsert: true,
    })
  if (error) throw error
  return path
}

/**
 * Signed download URL for a profile avatar (default 24h).
 */
export async function createAvatarDownloadUrl(
  storagePath: string,
  expiresIn = 86400,
): Promise<string | null> {
  if (!storagePath) return null
  const { data, error } = await supabaseAdmin.storage
    .from(PROFILE_AVATARS_BUCKET)
    .createSignedUrl(storagePath, expiresIn)
  if (error) throw error
  return data.signedUrl
}

/**
 * Batch signed URLs for profile avatar paths.
 */
export async function avatarUrlsForPaths(
  paths: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const unique = [...new Set(paths.filter((p): p is string => Boolean(p)))]
  await Promise.all(
    unique.map(async (path) => {
      try {
        const url = await createAvatarDownloadUrl(path)
        if (url) map.set(path, url)
      } catch {
        // skip broken paths
      }
    }),
  )
  return map
}
