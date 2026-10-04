/**
 * Hashtag-group media: signed URLs for default covers and chip icons.
 * Bucket holds one cover + one icon per group (referenced by path on hashtag_groups).
 */

import { supabaseAdmin } from './supabase.js'

export const HASHTAG_GROUP_MEDIA_BUCKET = 'hashtag-group-media'

/** One shared cover object per group (referenced from hashtag_groups.cover_storage_path). */
export function hashtagGroupCoverStoragePath(groupSlug: string): string {
  return `${groupSlug}/cover.webp`
}

/**
 * Upload processed 1280×720 WebP to hashtag-group-media (upsert).
 *
 * @returns Storage path to store on hashtag_groups.cover_storage_path
 */
export async function uploadHashtagGroupCover(
  groupSlug: string,
  webpBuffer: Buffer,
): Promise<string> {
  const path = hashtagGroupCoverStoragePath(groupSlug)
  const { error } = await supabaseAdmin.storage
    .from(HASHTAG_GROUP_MEDIA_BUCKET)
    .upload(path, webpBuffer, {
      contentType: 'image/webp',
      upsert: true,
    })
  if (error) throw error
  return path
}

/**
 * Signed download URL for a path in hashtag-group-media (default 24h).
 */
export async function createHashtagGroupMediaUrl(
  storagePath: string | null | undefined,
  expiresIn = 86400,
): Promise<string | null> {
  if (!storagePath) return null
  const { data, error } = await supabaseAdmin.storage
    .from(HASHTAG_GROUP_MEDIA_BUCKET)
    .createSignedUrl(storagePath, expiresIn)
  if (error) throw error
  return data.signedUrl
}

/**
 * Batch signed URLs for group media paths.
 */
export async function hashtagGroupMediaUrlsForPaths(
  paths: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter((p): p is string => Boolean(p)))]
  const map = new Map<string, string>()
  await Promise.all(
    unique.map(async (path) => {
      const url = await createHashtagGroupMediaUrl(path)
      if (url) map.set(path, url)
    }),
  )
  return map
}
