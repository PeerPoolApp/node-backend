/**
 * Seed default group event covers: 16:9 center-crop the photos in
 * tag_groups/images, upload once to hashtag-group-media, point hashtag_groups
 * at those paths. Idempotent (storage upsert + path update).
 *
 * Usage: npx tsx scripts/seedHashtagGroupCovers.ts
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { processEventCover } from '../services/imageCompression.js'
import {
  createHashtagGroupMediaUrl,
  uploadHashtagGroupCover,
} from '../services/hashtagGroupMedia.js'
import { supabaseAdmin } from '../services/supabase.js'

/** Source JPEG → seeded hashtag_groups.slug */
const ASSETS: { file: string; slug: string }[] = [
  { file: 'gym.jpg', slug: 'Sport' },
  { file: 'hobby.jpg', slug: 'Hobby' },
  { file: 'learn.jpg', slug: 'Lernen' },
  { file: 'party.jpg', slug: 'Party' },
  { file: 'food.jpg', slug: 'Essen' },
]

const imagesDir = resolve(import.meta.dirname, '../../tag_groups/images')

for (const { file, slug } of ASSETS) {
  const raw = readFileSync(resolve(imagesDir, file))
  const webp = await processEventCover(raw)
  console.log(slug, file, 'raw', raw.length, 'webp', webp.length)
  if (webp.length > 512000) {
    throw new Error(`${slug} WebP ${webp.length} exceeds bucket limit 512000`)
  }
  const path = await uploadHashtagGroupCover(slug, webp)
  const { error } = await supabaseAdmin
    .from('hashtag_groups')
    .update({ cover_storage_path: path, cover_updated_at: new Date().toISOString() })
    .ilike('slug', slug)
  if (error) throw error
  const url = await createHashtagGroupMediaUrl(path)
  console.log(slug, 'path', path, url ? 'signed ok' : 'signed missing')
}

const { data, error } = await supabaseAdmin
  .from('hashtag_groups')
  .select('slug, cover_storage_path, cover_updated_at')
  .order('slug')
if (error) throw error
for (const row of data ?? []) {
  console.log(
    'group',
    row.slug,
    row.cover_storage_path ? 'has cover' : 'NO COVER',
    row.cover_updated_at ?? '',
  )
}
