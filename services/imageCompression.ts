/**
 * Shared sharp image compression for avatars, chat media, and event covers.
 */

import sharp from 'sharp'

export const PROFILE_AVATAR_SIZE = 256
export const CHAT_IMAGE_MAX_EDGE = 1280
export const EVENT_COVER_WIDTH = 1280
export const EVENT_COVER_HEIGHT = 720
export const WEBP_QUALITY = 85

/**
 * Profile avatar: cover crop to 256×256 WebP.
 */
export async function processProfileAvatar(buffer: Buffer): Promise<Buffer> {
  const meta = await sharp(buffer).metadata()
  if (!meta.width || !meta.height || meta.width < 32 || meta.height < 32) {
    throw new Error('Image too small')
  }
  return sharp(buffer)
    .rotate()
    .resize(PROFILE_AVATAR_SIZE, PROFILE_AVATAR_SIZE, { fit: 'cover' })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer()
}

/**
 * Chat image: fit within max edge, keep aspect ratio, WebP.
 */
export async function processChatImage(buffer: Buffer): Promise<Buffer> {
  const meta = await sharp(buffer).metadata()
  if (!meta.width || !meta.height || meta.width < 16 || meta.height < 16) {
    throw new Error('Image too small')
  }
  return sharp(buffer)
    .rotate()
    .resize(CHAT_IMAGE_MAX_EDGE, CHAT_IMAGE_MAX_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer()
}

/**
 * Event cover: cover crop to 1280×720 WebP.
 */
export async function processEventCover(buffer: Buffer): Promise<Buffer> {
  const meta = await sharp(buffer).metadata()
  if (!meta.width || !meta.height || meta.width < 32 || meta.height < 32) {
    throw new Error('Image too small')
  }
  return sharp(buffer)
    .rotate()
    .resize(EVENT_COVER_WIDTH, EVENT_COVER_HEIGHT, { fit: 'cover' })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer()
}
