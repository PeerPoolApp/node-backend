/**
 * Hashtag catalog: find-or-create allowed slugs, suggestions by use_count.
 * Layer: service. See `.cursor/rules/events.mdc`.
 */

import { supabaseAdmin } from './supabase.js'
import { normalizeHashtagSlug } from '../lib/hashtags.js'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'
import { hashtagGroupMediaUrlsForPaths } from './hashtagGroupMedia.js'

function escapeIlikeExact(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export type HashtagRow = {
  id: string
  slug: string
  visibility: 'allowed' | 'hidden'
  use_count: number
}

/**
 * Top 10 allowed tags matching an optional prefix (without `#`), with group meta.
 */
export type HashtagSuggestItem = {
  slug: string
  groupSlug: string | null
  groupIconUrl: string | null
}

export async function suggestHashtags(rawQuery: string): Promise<string[]> {
  const items = await suggestHashtagItems(rawQuery)
  return items.map((i) => i.slug)
}

/**
 * Suggest with optional group icon for chip UI.
 */
export async function suggestHashtagItems(rawQuery: string): Promise<HashtagSuggestItem[]> {
  const q = rawQuery.trim().replace(/^#+/, '')
  if (q && (exceedsLimit(q, TEXT_LIMITS.hashtag) || /[^A-Za-z_]/.test(q))) {
    return []
  }

  let query = supabaseAdmin
    .from('hashtags')
    .select('id, slug')
    .eq('visibility', 'allowed')
    .order('use_count', { ascending: false })
    .order('slug', { ascending: true })
    .limit(10)

  if (q) {
    query = query.ilike('slug', `${escapeIlikeExact(q)}%`)
  }

  const { data, error } = await query
  if (error) throw error
  const rows = data ?? []
  if (!rows.length) return []

  const ids = rows.map((r) => r.id as string)
  const groupByTag = await groupMetaByHashtagIds(ids)

  return rows.map((r) => {
    const g = groupByTag.get(r.id as string)
    return {
      slug: r.slug as string,
      groupSlug: g?.groupSlug ?? null,
      groupIconUrl: g?.groupIconUrl ?? null,
    }
  })
}

type GroupMeta = { groupSlug: string; groupIconUrl: string | null }

/**
 * Soft-fail group membership lookup (missing migration → empty map).
 */
async function groupMetaByHashtagIds(hashtagIds: string[]): Promise<Map<string, GroupMeta>> {
  const out = new Map<string, GroupMeta>()
  if (!hashtagIds.length) return out
  try {
    const { data: members, error: memErr } = await supabaseAdmin
      .from('hashtag_group_members')
      .select('hashtag_id, hashtag_groups ( slug, icon_storage_path )')
      .in('hashtag_id', hashtagIds)
    if (memErr) {
      console.error('[hashtags] group members', memErr.message, memErr.code)
      return out
    }

    const groupByTag = new Map<string, { slug: string; iconPath: string | null }>()
    for (const m of members ?? []) {
      const g = m.hashtag_groups as
        | { slug: string; icon_storage_path: string | null }
        | { slug: string; icon_storage_path: string | null }[]
        | null
      const group = Array.isArray(g) ? g[0] : g
      if (!group) continue
      groupByTag.set(m.hashtag_id as string, {
        slug: group.slug,
        iconPath: group.icon_storage_path,
      })
    }

    const iconMap = await hashtagGroupMediaUrlsForPaths(
      [...groupByTag.values()].map((g) => g.iconPath),
    )

    for (const [id, g] of groupByTag) {
      out.set(id, {
        groupSlug: g.slug,
        groupIconUrl: g.iconPath ? iconMap.get(g.iconPath) ?? null : null,
      })
    }
  } catch (e) {
    console.error('[hashtags] groupMetaByHashtagIds', e)
  }
  return out
}

/**
 * Enrich known slugs with group meta (for HashtagInput hydrate / chip icons).
 */
export async function itemsForSlugs(rawSlugs: string[]): Promise<HashtagSuggestItem[]> {
  const unique: string[] = []
  for (const raw of rawSlugs) {
    const slug = normalizeHashtagSlug(raw)
    if (!slug) continue
    if (unique.some((s) => s.toLowerCase() === slug.toLowerCase())) continue
    unique.push(slug)
  }
  if (!unique.length) return []

  const rows: { id: string; slug: string }[] = []
  await Promise.all(
    unique.map(async (slug) => {
      const { data, error } = await supabaseAdmin
        .from('hashtags')
        .select('id, slug')
        .ilike('slug', escapeIlikeExact(slug))
        .maybeSingle()
      if (error) {
        console.error('[hashtags] itemsForSlugs', error.message, error.code)
        return
      }
      if (data) rows.push(data as { id: string; slug: string })
    }),
  )

  const byLower = new Map(rows.map((r) => [r.slug.toLowerCase(), r]))
  const groupByTag = await groupMetaByHashtagIds(rows.map((r) => r.id))

  return unique.map((slug) => {
    const row = byLower.get(slug.toLowerCase())
    if (!row) return { slug, groupSlug: null, groupIconUrl: null }
    const g = groupByTag.get(row.id)
    return {
      slug: row.slug,
      groupSlug: g?.groupSlug ?? null,
      groupIconUrl: g?.groupIconUrl ?? null,
    }
  })
}

/**
 * Resolve an allowed slug for exact `#search`. Hidden tags do not match.
 */
export async function findAllowedHashtagBySlug(raw: string): Promise<HashtagRow | null> {
  const slug = normalizeHashtagSlug(raw)
  if (!slug) return null
  const { data, error } = await supabaseAdmin
    .from('hashtags')
    .select('id, slug, visibility, use_count')
    .ilike('slug', escapeIlikeExact(slug))
    .maybeSingle()
  if (error) throw error
  if (!data || data.visibility === 'hidden') return null
  return data as HashtagRow
}

/**
 * Attach up to 3 distinct allowed slugs to an event (find-or-create).
 */
export async function attachEventHashtags(eventId: string, rawSlugs: string[]): Promise<void> {
  const unique: string[] = []
  for (const raw of rawSlugs) {
    const slug = normalizeHashtagSlug(raw)
    if (!slug) {
      throw Object.assign(new Error('Invalid hashtag'), { statusCode: 400 })
    }
    const key = slug.toLowerCase()
    if (unique.some((s) => s.toLowerCase() === key)) continue
    unique.push(slug)
  }
  if (unique.length > 3) {
    throw Object.assign(new Error('At most 3 hashtags'), { statusCode: 400 })
  }

  for (const slug of unique) {
    const { data: existing, error: findErr } = await supabaseAdmin
      .from('hashtags')
      .select('id, slug, visibility')
      .ilike('slug', escapeIlikeExact(slug))
      .maybeSingle()
    if (findErr) throw findErr

    let hashtagId: string
    if (existing) {
      if (existing.visibility === 'hidden') {
        throw Object.assign(new Error(`Hashtag #${existing.slug} is not allowed`), {
          statusCode: 400,
        })
      }
      hashtagId = existing.id
    } else {
      const { data: created, error: insErr } = await supabaseAdmin
        .from('hashtags')
        .insert({ slug, visibility: 'allowed' })
        .select('id')
        .single()
      if (insErr || !created) throw insErr ?? new Error('Could not create hashtag')
      hashtagId = created.id
    }

    const { error: linkErr } = await supabaseAdmin.from('event_hashtags').insert({
      event_id: eventId,
      hashtag_id: hashtagId,
    })
    if (linkErr) throw linkErr
  }
}

/**
 * Replace all event hashtag links (delete then attach). Empty list clears tags.
 */
export async function replaceEventHashtags(eventId: string, rawSlugs: string[]): Promise<void> {
  const { error } = await supabaseAdmin.from('event_hashtags').delete().eq('event_id', eventId)
  if (error) throw error
  if (rawSlugs.length) await attachEventHashtags(eventId, rawSlugs)
}

async function attachHashtagsToEntity(
  table: 'event_hashtags' | 'community_hashtags',
  entityColumn: 'event_id' | 'community_id',
  entityId: string,
  rawSlugs: string[],
  maxTags: number,
): Promise<void> {
  const unique: string[] = []
  for (const raw of rawSlugs) {
    const slug = normalizeHashtagSlug(raw)
    if (!slug) {
      throw Object.assign(new Error('Invalid hashtag'), { statusCode: 400 })
    }
    const key = slug.toLowerCase()
    if (unique.some((s) => s.toLowerCase() === key)) continue
    unique.push(slug)
  }
  if (unique.length > maxTags) {
    throw Object.assign(new Error(`At most ${maxTags} hashtags`), { statusCode: 400 })
  }

  for (const slug of unique) {
    const { data: existing, error: findErr } = await supabaseAdmin
      .from('hashtags')
      .select('id, slug, visibility')
      .ilike('slug', escapeIlikeExact(slug))
      .maybeSingle()
    if (findErr) throw findErr

    let hashtagId: string
    if (existing) {
      if (existing.visibility === 'hidden') {
        throw Object.assign(new Error(`Hashtag #${existing.slug} is not allowed`), {
          statusCode: 400,
        })
      }
      hashtagId = existing.id
    } else {
      const { data: created, error: insErr } = await supabaseAdmin
        .from('hashtags')
        .insert({ slug, visibility: 'allowed' })
        .select('id')
        .single()
      if (insErr || !created) throw insErr ?? new Error('Could not create hashtag')
      hashtagId = created.id
    }

    const { error: linkErr } = await supabaseAdmin.from(table).insert({
      [entityColumn]: entityId,
      hashtag_id: hashtagId,
    })
    if (linkErr) throw linkErr
  }
}

/**
 * Attach up to 5 distinct allowed slugs to a community (find-or-create).
 */
export async function attachCommunityHashtags(communityId: string, rawSlugs: string[]): Promise<void> {
  await attachHashtagsToEntity('community_hashtags', 'community_id', communityId, rawSlugs, 5)
}

/**
 * Replace all community hashtag links (delete then attach). Empty list clears tags.
 */
export async function replaceCommunityHashtags(communityId: string, rawSlugs: string[]): Promise<void> {
  const { error } = await supabaseAdmin
    .from('community_hashtags')
    .delete()
    .eq('community_id', communityId)
  if (error) throw error
  if (rawSlugs.length) await attachCommunityHashtags(communityId, rawSlugs)
}

/**
 * Slugs attached to each community id (order not significant).
 */
export async function slugsForCommunityIds(communityIds: string[]): Promise<Map<string, string[]>> {
  const items = await hashtagItemsForCommunityIds(communityIds)
  const map = new Map<string, string[]>()
  for (const [id, list] of items) {
    map.set(
      id,
      list.map((i) => i.slug),
    )
  }
  return map
}

/**
 * Hashtag chips (slug + group meta) per community id.
 */
export async function hashtagItemsForCommunityIds(
  communityIds: string[],
): Promise<Map<string, HashtagSuggestItem[]>> {
  const map = new Map<string, HashtagSuggestItem[]>()
  if (communityIds.length === 0) return map
  const { data: links, error } = await supabaseAdmin
    .from('community_hashtags')
    .select('community_id, hashtag_id, hashtags ( slug )')
    .in('community_id', communityIds)
  if (error) throw error

  const hashtagIds = [...new Set((links ?? []).map((l) => l.hashtag_id as string))]
  const groupByTag = await groupMetaByHashtagIds(hashtagIds)

  for (const row of links ?? []) {
    const tag = row.hashtags as { slug?: string } | { slug?: string }[] | null
    const slug = Array.isArray(tag) ? tag[0]?.slug : tag?.slug
    if (!slug) continue
    const g = groupByTag.get(row.hashtag_id as string)
    const list = map.get(row.community_id) ?? []
    list.push({
      slug,
      groupSlug: g?.groupSlug ?? null,
      groupIconUrl: g?.groupIconUrl ?? null,
    })
    map.set(row.community_id, list)
  }
  return map
}

/**
 * Slugs attached to each event id (order not significant).
 */
export async function slugsForEventIds(eventIds: string[]): Promise<Map<string, string[]>> {
  const items = await hashtagItemsForEventIds(eventIds)
  const map = new Map<string, string[]>()
  for (const [id, list] of items) {
    map.set(
      id,
      list.map((i) => i.slug),
    )
  }
  return map
}

/**
 * Hashtag chips (slug + group meta) per event id.
 */
export async function hashtagItemsForEventIds(
  eventIds: string[],
): Promise<Map<string, HashtagSuggestItem[]>> {
  const map = new Map<string, HashtagSuggestItem[]>()
  if (eventIds.length === 0) return map
  const { data: links, error } = await supabaseAdmin
    .from('event_hashtags')
    .select('event_id, hashtag_id, hashtags ( slug )')
    .in('event_id', eventIds)
  if (error) throw error

  const hashtagIds = [...new Set((links ?? []).map((l) => l.hashtag_id as string))]
  const groupByTag = await groupMetaByHashtagIds(hashtagIds)

  for (const row of links ?? []) {
    const tag = row.hashtags as { slug?: string } | { slug?: string }[] | null
    const slug = Array.isArray(tag) ? tag[0]?.slug : tag?.slug
    if (!slug) continue
    const g = groupByTag.get(row.hashtag_id as string)
    const list = map.get(row.event_id) ?? []
    list.push({
      slug,
      groupSlug: g?.groupSlug ?? null,
      groupIconUrl: g?.groupIconUrl ?? null,
    })
    map.set(row.event_id, list)
  }
  return map
}
