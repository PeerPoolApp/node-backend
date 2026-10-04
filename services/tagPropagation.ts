/**
 * Apply tag affinity when joined events end (idempotent via events.tags_propagated_at).
 */

import { supabaseAdmin } from './supabase.js'
import {
  COMMUNITY_TAG_BUMP,
  EVENT_TAG_BUMP,
  TAG_PROPAGATION_BATCH,
  UNUSED_TAG_DECAY,
} from '../lib/tagPropagationConstants.js'

function clampScore(n: number): number {
  if (n < 0) return 0
  if (n > 100) return 100
  return Math.round(n)
}

type EventRow = {
  id: string
  visibility: string
  organizer_community_id: string | null
}

/**
 * Process up to TAG_PROPAGATION_BATCH ended unmarked events.
 * Marks each event only after its participants are updated successfully.
 */
export async function runTagPropagationBatch(): Promise<{
  processed: number
  usersTouched: number
}> {
  const nowIso = new Date().toISOString()
  const { data: events, error } = await supabaseAdmin
    .from('events')
    .select('id, visibility, organizer_community_id')
    .is('tags_propagated_at', null)
    .is('canceled_at', null)
    .lte('ends_at', nowIso)
    .order('ends_at', { ascending: true })
    .limit(TAG_PROPAGATION_BATCH)
  if (error) throw error

  let processed = 0
  let usersTouched = 0
  for (const ev of (events ?? []) as EventRow[]) {
    const n = await applyPropagationForEvent(ev)
    usersTouched += n
    processed += 1
  }
  return { processed, usersTouched }
}

/**
 * Apply affinity for one event, then stamp tags_propagated_at.
 */
async function applyPropagationForEvent(ev: EventRow): Promise<number> {
  const { data: parts, error: partErr } = await supabaseAdmin
    .from('event_participants')
    .select('user_id')
    .eq('event_id', ev.id)
    .eq('status', 'joined')
  if (partErr) throw partErr
  const userIds = (parts ?? []).map((p) => p.user_id as string)
  if (!userIds.length) {
    await markPropagated(ev.id)
    return 0
  }

  const { data: eventTags, error: ehErr } = await supabaseAdmin
    .from('event_hashtags')
    .select('hashtag_id')
    .eq('event_id', ev.id)
  if (ehErr) throw ehErr
  const eventHashtagIds = (eventTags ?? []).map((r) => r.hashtag_id as string)

  let communityHashtagIds: string[] = []
  const includeCommunity =
    (ev.visibility === 'community' || ev.visibility === 'channel') &&
    Boolean(ev.organizer_community_id)
  if (includeCommunity && ev.organizer_community_id) {
    const { data: ch, error: chErr } = await supabaseAdmin
      .from('community_hashtags')
      .select('hashtag_id')
      .eq('community_id', ev.organizer_community_id)
    if (chErr) throw chErr
    communityHashtagIds = (ch ?? []).map((r) => r.hashtag_id as string)
  }

  const bumpMap = new Map<string, number>()
  for (const id of eventHashtagIds) {
    bumpMap.set(id, (bumpMap.get(id) ?? 0) + EVENT_TAG_BUMP)
  }
  for (const id of communityHashtagIds) {
    bumpMap.set(id, (bumpMap.get(id) ?? 0) + COMMUNITY_TAG_BUMP)
  }

  for (const userId of userIds) {
    await applyForUser(userId, bumpMap)
  }

  await markPropagated(ev.id)
  return userIds.length
}

async function markPropagated(eventId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('events')
    .update({ tags_propagated_at: new Date().toISOString() })
    .eq('id', eventId)
    .is('tags_propagated_at', null)
  if (error) throw error
}

/**
 * Decay unused tags, bump increased tags, delete zero rows.
 */
async function applyForUser(
  userId: string,
  bumpMap: Map<string, number>,
): Promise<void> {
  const { data: existing, error } = await supabaseAdmin
    .from('user_hashtags')
    .select('hashtag_id, score')
    .eq('user_id', userId)
  if (error) throw error

  const now = new Date().toISOString()
  const byId = new Map(
    (existing ?? []).map((r) => [r.hashtag_id as string, r.score as number]),
  )
  const bumped = new Set(bumpMap.keys())

  const upserts: Array<{
    user_id: string
    hashtag_id: string
    score: number
    updated_at: string
  }> = []
  const deleteIds: string[] = []

  for (const [hashtagId, score] of byId) {
    if (bumped.has(hashtagId)) continue
    const next = clampScore(score - UNUSED_TAG_DECAY)
    if (next <= 0) deleteIds.push(hashtagId)
    else {
      upserts.push({
        user_id: userId,
        hashtag_id: hashtagId,
        score: next,
        updated_at: now,
      })
    }
  }

  for (const [hashtagId, bump] of bumpMap) {
    const prev = byId.get(hashtagId) ?? 0
    upserts.push({
      user_id: userId,
      hashtag_id: hashtagId,
      score: clampScore(prev + bump),
      updated_at: now,
    })
  }

  if (deleteIds.length) {
    const { error: delErr } = await supabaseAdmin
      .from('user_hashtags')
      .delete()
      .eq('user_id', userId)
      .in('hashtag_id', deleteIds)
    if (delErr) throw delErr
  }

  if (upserts.length) {
    const { error: upErr } = await supabaseAdmin
      .from('user_hashtags')
      .upsert(upserts, { onConflict: 'user_id,hashtag_id' })
    if (upErr) throw upErr
  }
}

/**
 * Pick default group cover path for an event with no uploaded cover.
 * Majority group among ≤3 event tags; tie → earliest event_hashtags.created_at.
 * Soft-fails (returns null) when group tables are missing or the join errors.
 */
export async function resolveGroupCoverPathForEvent(
  eventId: string,
): Promise<{ path: string; updatedAt: string | null } | null> {
  try {
    const { data: rows, error } = await supabaseAdmin
      .from('event_hashtags')
      .select('hashtag_id, created_at')
      .eq('event_id', eventId)
      .order('created_at', { ascending: true })
    if (error) {
      console.error('[tagPropagation] resolveGroupCover event_hashtags', error.message, error.code)
      return null
    }
    if (!rows?.length) return null

    const hashtagIds = rows.map((r) => r.hashtag_id as string)
    const { data: members, error: memErr } = await supabaseAdmin
      .from('hashtag_group_members')
      .select(
        'hashtag_id, created_at, hashtag_groups ( id, cover_storage_path, cover_updated_at )',
      )
      .in('hashtag_id', hashtagIds)
    if (memErr) {
      console.error('[tagPropagation] resolveGroupCover members', memErr.message, memErr.code)
      return null
    }
    if (!members?.length) return null

    type GroupInfo = {
      id: string
      coverPath: string
      coverUpdatedAt: string | null
      count: number
      earliestEventTagAt: string
    }

    const byGroup = new Map<string, GroupInfo>()
    const eventTagAt = new Map(
      rows.map((r) => [r.hashtag_id as string, r.created_at as string]),
    )

    for (const m of members) {
      const g = m.hashtag_groups as
        | {
            id: string
            cover_storage_path: string | null
            cover_updated_at: string | null
          }
        | {
            id: string
            cover_storage_path: string | null
            cover_updated_at: string | null
          }[]
        | null
      const group = Array.isArray(g) ? g[0] : g
      if (!group?.cover_storage_path) continue
      const tagAt = eventTagAt.get(m.hashtag_id as string) ?? ''
      const prev = byGroup.get(group.id)
      if (!prev) {
        byGroup.set(group.id, {
          id: group.id,
          coverPath: group.cover_storage_path,
          coverUpdatedAt: group.cover_updated_at,
          count: 1,
          earliestEventTagAt: tagAt,
        })
      } else {
        prev.count += 1
        if (tagAt && tagAt < prev.earliestEventTagAt) prev.earliestEventTagAt = tagAt
      }
    }

    const ranked = [...byGroup.values()].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return a.earliestEventTagAt.localeCompare(b.earliestEventTagAt)
    })
    const best = ranked[0]
    if (!best) return null
    return { path: best.coverPath, updatedAt: best.coverUpdatedAt }
  } catch (e) {
    console.error('[tagPropagation] resolveGroupCover', e)
    return null
  }
}
