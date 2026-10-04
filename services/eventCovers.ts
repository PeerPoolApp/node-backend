/**
 * Event cover processing and Storage helpers.
 * Client sends a 16:9 pre-crop; server encodes 1280×720 WebP.
 */

import { supabaseAdmin } from './supabase.js'
import { processEventCover } from './imageCompression.js'

export const EVENT_COVERS_BUCKET = 'event-covers'
export const MAX_EVENT_COVER_INPUT_BYTES = 2 * 1024 * 1024

/**
 * Validate raw cover upload buffer before processing.
 */
export function validateEventCoverUpload(buffer: Buffer): string | null {
  if (!buffer.length) return 'Empty file'
  if (buffer.length > MAX_EVENT_COVER_INPUT_BYTES) {
    return `File exceeds max size (${MAX_EVENT_COVER_INPUT_BYTES} bytes)`
  }
  return null
}

export function eventCoverStoragePath(eventId: string): string {
  return `${eventId}/cover.webp`
}

/**
 * Upload processed WebP to event-covers bucket (upsert).
 */
export async function uploadEventCover(eventId: string, webpBuffer: Buffer): Promise<string> {
  const path = eventCoverStoragePath(eventId)
  const { error } = await supabaseAdmin.storage.from(EVENT_COVERS_BUCKET).upload(path, webpBuffer, {
    contentType: 'image/webp',
    upsert: true,
  })
  if (error) throw error
  return path
}

/**
 * Signed download URL for an event cover (default 24h).
 */
export async function createEventCoverDownloadUrl(
  storagePath: string,
  expiresIn = 86400,
): Promise<string | null> {
  if (!storagePath) return null
  const { data, error } = await supabaseAdmin.storage
    .from(EVENT_COVERS_BUCKET)
    .createSignedUrl(storagePath, expiresIn)
  if (error) throw error
  return data.signedUrl
}

/**
 * Batch signed URLs for event cover paths.
 */
export async function eventCoverUrlsForPaths(
  paths: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const unique = [...new Set(paths.filter((p): p is string => Boolean(p)))]
  await Promise.all(
    unique.map(async (path) => {
      try {
        const url = await createEventCoverDownloadUrl(path)
        if (url) map.set(path, url)
      } catch {
        // skip broken paths
      }
    }),
  )
  return map
}

export { processEventCover }
