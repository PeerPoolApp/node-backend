/**
 * User hashtag affinity DTOs for profiles, friends, and public user pages.
 */

import { supabaseAdmin } from './supabase.js'
import {
  PROFILE_TAG_DISPLAY_CAP,
  PROFILE_TAG_THRESHOLD,
} from '../lib/tagPropagationConstants.js'
import { hashtagGroupMediaUrlsForPaths } from './hashtagGroupMedia.js'

export type UserTagDto = {
  slug: string
  score: number
  groupSlug: string | null
  groupIconUrl: string | null
}

type AffinityRow = {
  user_id: string
  score: number
  hashtags: { id: string; slug: string } | { id: string; slug: string }[] | null
}

/**
 * Visible tags for one user (score ≥ threshold), with optional group icon URL.
 */
export async function visibleTagsForUser(userId: string): Promise<UserTagDto[]> {
  const map = await visibleTagsForUsers([userId])
  return map.get(userId) ?? []
}

/**
 * Batch visible tags for many users (friend lists / recommendations).
 */
export async function visibleTagsForUsers(
  userIds: string[],
): Promise<Map<string, UserTagDto[]>> {
  const result = new Map<string, UserTagDto[]>()
  const unique = [...new Set(userIds.filter(Boolean))]
  for (const id of unique) result.set(id, [])
  if (!unique.length) return result

  const { data, error } = await supabaseAdmin
    .from('user_hashtags')
    .select('user_id, score, hashtags ( id, slug )')
    .in('user_id', unique)
    .gte('score', PROFILE_TAG_THRESHOLD)
    .order('score', { ascending: false })
  if (error) throw error

  const rows = (data ?? []) as AffinityRow[]
  const hashtagIds = new Set<string>()
  for (const row of rows) {
    const tag = Array.isArray(row.hashtags) ? row.hashtags[0] : row.hashtags
    if (tag?.id) hashtagIds.add(tag.id)
  }

  const groupByHashtag = new Map<
    string,
    { groupSlug: string; iconPath: string | null }
  >()
  if (hashtagIds.size) {
    const { data: members, error: memErr } = await supabaseAdmin
      .from('hashtag_group_members')
      .select('hashtag_id, hashtag_groups ( slug, icon_storage_path )')
      .in('hashtag_id', [...hashtagIds])
    if (memErr) throw memErr
    for (const m of members ?? []) {
      const g = m.hashtag_groups as
        | { slug: string; icon_storage_path: string | null }
        | { slug: string; icon_storage_path: string | null }[]
        | null
      const group = Array.isArray(g) ? g[0] : g
      if (!group) continue
      groupByHashtag.set(m.hashtag_id as string, {
        groupSlug: group.slug,
        iconPath: group.icon_storage_path,
      })
    }
  }

  const iconMap = await hashtagGroupMediaUrlsForPaths(
    [...groupByHashtag.values()].map((g) => g.iconPath),
  )

  for (const row of rows) {
    const tag = Array.isArray(row.hashtags) ? row.hashtags[0] : row.hashtags
    if (!tag?.slug) continue
    const list = result.get(row.user_id) ?? []
    if (list.length >= PROFILE_TAG_DISPLAY_CAP) continue
    const g = groupByHashtag.get(tag.id)
    list.push({
      slug: tag.slug,
      score: row.score,
      groupSlug: g?.groupSlug ?? null,
      groupIconUrl: g?.iconPath ? iconMap.get(g.iconPath) ?? null : null,
    })
    result.set(row.user_id, list)
  }

  return result
}
