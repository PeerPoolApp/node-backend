/**
 * Report / hide / ban helpers. Mutations via supabaseAdmin (service_role).
 * Layer: service. See GDPR reports plan — 1x personal hide, 2x global hide.
 */

import { randomUUID } from 'node:crypto'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'
import { supabaseAdmin } from './supabase.js'

export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'sexual',
  'illegal',
  'impersonation',
  'other',
] as const

export type ReportReason = (typeof REPORT_REASONS)[number]
export type TargetKind = 'user' | 'event' | 'community' | 'message'
export type ReportStatus = 'unresolved' | 'approved' | 'blocked'

export function isReportReason(value: string): value is ReportReason {
  return (REPORT_REASONS as readonly string[]).includes(value)
}

export function isTargetKind(value: string): value is TargetKind {
  return value === 'user' || value === 'event' || value === 'community' || value === 'message'
}

function tableForKind(kind: TargetKind): 'profiles' | 'events' | 'communities' | 'messages' {
  if (kind === 'user') return 'profiles'
  if (kind === 'event') return 'events'
  if (kind === 'community') return 'communities'
  return 'messages'
}

export function isMissingRelationOrColumn(error: { message?: string; code?: string } | null): boolean {
  const msg = (error?.message ?? '').toLowerCase()
  const code = error?.code ?? ''
  return (
    code === '42P01' ||
    code === '42703' ||
    code === 'PGRST205' ||
    code === 'PGRST204' ||
    msg.includes('does not exist') ||
    msg.includes('schema cache')
  )
}

export async function loadAppRole(userId: string): Promise<'user' | 'admin' | null> {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('app_role')
    .eq('id', userId)
    .maybeSingle()
  if (error) {
    if (isMissingRelationOrColumn(error)) return 'user'
    throw error
  }
  const role = data?.app_role
  if (role === 'admin' || role === 'user') return role
  return 'user'
}

export async function isAdminUser(userId: string): Promise<boolean> {
  return (await loadAppRole(userId)) === 'admin'
}

/** Global moderation hides. Empty when the column is not migrated yet. */
export async function globallyHiddenIds(kind: TargetKind): Promise<Set<string>> {
  const table = tableForKind(kind)
  const { data, error } = await supabaseAdmin
    .from(table)
    .select('id')
    .not('moderation_hidden_at', 'is', null)
  if (error) {
    if (isMissingRelationOrColumn(error)) return new Set()
    throw error
  }
  return new Set((data ?? []).map((r) => r.id as string))
}
export async function hiddenIdsFor(
  userId: string,
  kind: TargetKind,
): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from('content_hides')
    .select('target_id')
    .eq('user_id', userId)
    .eq('target_kind', kind)
  if (error) {
    if (isMissingRelationOrColumn(error)) return new Set()
    throw error
  }
  return new Set((data ?? []).map((r) => r.target_id as string))
}

async function communityManageIds(userId: string): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from('community_member_roles')
    .select('community_id')
    .eq('user_id', userId)
    .in('role', ['admin', 'manage_community', 'manage_events'])
  return new Set((data ?? []).map((r) => r.community_id as string))
}

/**
 * Whether the viewer may still see a globally hidden event
 * (organizer or community manager).
 */
export async function canSeeHiddenEvent(
  row: {
    organizer_user_id?: string | null
    organizer_community_id?: string | null
  },
  userId: string,
): Promise<boolean> {
  if (row.organizer_user_id === userId) return true
  if (row.organizer_community_id) {
    const managed = await communityManageIds(userId)
    if (managed.has(row.organizer_community_id)) return true
  }
  return false
}

export async function canSeeHiddenCommunity(
  row: { created_by?: string; id?: string },
  userId: string,
): Promise<boolean> {
  if (row.created_by === userId) return true
  if (row.id) {
    const managed = await communityManageIds(userId)
    if (managed.has(row.id)) return true
  }
  return false
}

export async function eventAllowedForViewer(
  row: {
    id: string
    moderation_hidden_at?: string | null
    organizer_user_id?: string | null
    organizer_community_id?: string | null
  },
  userId: string,
  personalHides?: Set<string>,
  globalHidden?: Set<string>,
): Promise<boolean> {
  const hides = personalHides ?? (await hiddenIdsFor(userId, 'event'))
  const global = globalHidden ?? (await globallyHiddenIds('event'))
  if (hides.has(row.id)) return false
  const globally = Boolean(row.moderation_hidden_at) || global.has(row.id)
  if (!globally) return true
  return canSeeHiddenEvent(row, userId)
}

export async function communityAllowedForViewer(
  row: {
    id: string
    created_by?: string
    moderation_hidden_at?: string | null
  },
  userId: string,
  personalHides?: Set<string>,
  globalHidden?: Set<string>,
): Promise<boolean> {
  const hides = personalHides ?? (await hiddenIdsFor(userId, 'community'))
  const global = globalHidden ?? (await globallyHiddenIds('community'))
  if (hides.has(row.id)) return false
  const globally = Boolean(row.moderation_hidden_at) || global.has(row.id)
  if (!globally) return true
  return canSeeHiddenCommunity(row, userId)
}

export async function userAllowedForViewer(
  targetId: string,
  userId: string,
  row?: { deleted_at?: string | null; moderation_hidden_at?: string | null; app_role?: string | null },
  personalHides?: Set<string>,
  globalHidden?: Set<string>,
): Promise<boolean> {
  if (targetId === userId) return true
  if (row?.app_role === 'admin') return false
  if (row?.app_role !== 'user' && (await isAdminUser(targetId))) return false
  if (row?.deleted_at) return false
  const hides = personalHides ?? (await hiddenIdsFor(userId, 'user'))
  if (hides.has(targetId)) return false
  const global = globalHidden ?? (await globallyHiddenIds('user'))
  if (row?.moderation_hidden_at || global.has(targetId)) return false
  return true
}

/**
 * Personal hide always drops the message. Global hide is visible only to the sender.
 */
export function messageAllowedForViewer(
  msg: { id: string; sender_id: string; moderation_hidden_at?: string | null },
  userId: string,
  personalHides?: Set<string>,
  globalHidden?: Set<string>,
): boolean {
  if (personalHides?.has(msg.id)) return false
  const globally = Boolean(msg.moderation_hidden_at) || Boolean(globalHidden?.has(msg.id))
  if (!globally) return true
  return msg.sender_id === userId
}

export async function messageHideSets(userId: string): Promise<{
  personal: Set<string>
  global: Set<string>
}> {
  const [personal, global] = await Promise.all([
    hiddenIdsFor(userId, 'message'),
    globallyHiddenIds('message'),
  ])
  return { personal, global }
}

async function distinctReporterCount(kind: TargetKind, targetId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('reports')
    .select('reporter_id')
    .eq('target_kind', kind)
    .eq('target_id', targetId)
  if (error) throw error
  return new Set((data ?? []).map((r) => r.reporter_id as string)).size
}

async function setModerationHidden(kind: TargetKind, targetId: string, hidden: boolean) {
  const table = tableForKind(kind)
  const { error } = await supabaseAdmin
    .from(table)
    .update({ moderation_hidden_at: hidden ? new Date().toISOString() : null })
    .eq('id', targetId)
  if (error) throw error
}

async function remainingBlockedCount(kind: TargetKind, targetId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('reports')
    .select('id', { count: 'exact', head: true })
    .eq('target_kind', kind)
    .eq('target_id', targetId)
    .eq('status', 'blocked')
  if (error) throw error
  return count ?? 0
}

export type CreateReportInput = {
  reporterId: string
  targetKind: TargetKind
  targetId: string
  reason: ReportReason
  details?: string | null
}

export type CreateReportResult =
  | { ok: true; reportId: string; globallyHidden: boolean }
  | { ok: false; status: number; error: string }

/**
 * Insert report + personal hide. Second distinct reporter stamps global hide.
 */
export async function createReport(input: CreateReportInput): Promise<CreateReportResult> {
  if (input.targetId === input.reporterId && input.targetKind === 'user') {
    return { ok: false, status: 400, error: 'Cannot report yourself' }
  }
  const details = input.details?.trim() || null
  if (details && exceedsLimit(details, TEXT_LIMITS.reportDetails)) {
    return {
      ok: false,
      status: 400,
      error: `Details must be at most ${TEXT_LIMITS.reportDetails} characters`,
    }
  }

  if (input.targetKind === 'event') {
    const { data: ev } = await supabaseAdmin
      .from('events')
      .select('id, organizer_user_id')
      .eq('id', input.targetId)
      .maybeSingle()
    if (!ev) return { ok: false, status: 404, error: 'Event not found' }
    if (ev.organizer_user_id === input.reporterId) {
      return { ok: false, status: 400, error: 'Cannot report your own event' }
    }
  }
  if (input.targetKind === 'community') {
    const { data: c } = await supabaseAdmin
      .from('communities')
      .select('id, created_by')
      .eq('id', input.targetId)
      .maybeSingle()
    if (!c) return { ok: false, status: 404, error: 'Community not found' }
    if (c.created_by === input.reporterId) {
      return { ok: false, status: 400, error: 'Cannot report your own community' }
    }
  }
  if (input.targetKind === 'user') {
    const { data: p } = await supabaseAdmin
      .from('profiles')
      .select('id, deleted_at')
      .eq('id', input.targetId)
      .maybeSingle()
    if (!p || p.deleted_at) return { ok: false, status: 404, error: 'User not found' }
  }
  if (input.targetKind === 'message') {
    const { data: msg } = await supabaseAdmin
      .from('messages')
      .select('id, sender_id, conversation_id, deleted_at')
      .eq('id', input.targetId)
      .maybeSingle()
    if (!msg || msg.deleted_at) return { ok: false, status: 404, error: 'Message not found' }
    if (msg.sender_id === input.reporterId) {
      return { ok: false, status: 400, error: 'Cannot report your own message' }
    }
    const { data: mem } = await supabaseAdmin
      .from('conversation_members')
      .select('user_id')
      .eq('conversation_id', msg.conversation_id)
      .eq('user_id', input.reporterId)
      .maybeSingle()
    if (!mem) return { ok: false, status: 404, error: 'Message not found' }
  }

  const { data: inserted, error } = await supabaseAdmin
    .from('reports')
    .insert({
      id: randomUUID(),
      reporter_id: input.reporterId,
      target_kind: input.targetKind,
      target_id: input.targetId,
      reason: input.reason,
      details,
      status: 'unresolved',
    })
    .select('id')
    .maybeSingle()

  if (error) {
    if (error.code === '23505') {
      return { ok: false, status: 409, error: 'Already reported' }
    }
    throw error
  }

  await supabaseAdmin.from('content_hides').upsert(
    {
      user_id: input.reporterId,
      target_kind: input.targetKind,
      target_id: input.targetId,
    },
    { onConflict: 'user_id,target_kind,target_id' },
  )

  const reporters = await distinctReporterCount(input.targetKind, input.targetId)
  let globallyHidden = false
  if (reporters >= 2) {
    await setModerationHidden(input.targetKind, input.targetId, true)
    globallyHidden = true
  }

  return { ok: true, reportId: inserted?.id as string, globallyHidden }
}

export async function resolveReport(opts: {
  reportId: string
  status: 'approved' | 'blocked'
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { data: report, error } = await supabaseAdmin
    .from('reports')
    .select('id, target_kind, target_id')
    .eq('id', opts.reportId)
    .maybeSingle()
  if (error) throw error
  if (!report) return { ok: false, status: 404, error: 'Report not found' }

  const kind = report.target_kind as TargetKind
  const targetId = report.target_id as string

  const { error: updErr } = await supabaseAdmin
    .from('reports')
    .update({
      status: opts.status,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', opts.reportId)
  if (updErr) throw updErr

  if (opts.status === 'blocked') {
    await setModerationHidden(kind, targetId, true)
  } else {
    const blockedLeft = await remainingBlockedCount(kind, targetId)
    if (blockedLeft === 0) {
      await setModerationHidden(kind, targetId, false)
    }
  }
  return { ok: true }
}

export async function setTargetHidden(kind: TargetKind, targetId: string, hidden: boolean) {
  await setModerationHidden(kind, targetId, hidden)
}

export async function banUser(opts: {
  userId: string
  reason: ReportReason
  details?: string | null
}): Promise<void> {
  const details = opts.details?.trim() || null
  if (details && exceedsLimit(details, TEXT_LIMITS.reportDetails)) {
    throw Object.assign(new Error(`Details must be at most ${TEXT_LIMITS.reportDetails} characters`), {
      statusCode: 400,
    })
  }
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({
      banned_at: new Date().toISOString(),
      ban_reason: opts.reason,
      ban_details: details,
    })
    .eq('id', opts.userId)
  if (error) throw error
}

export async function unbanUser(userId: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({
      banned_at: null,
      ban_reason: null,
      ban_details: null,
    })
    .eq('id', userId)
  if (error) throw error
  await supabaseAdmin
    .from('pardon_requests')
    .update({ status: 'resolved', resolved_at: now })
    .eq('user_id', userId)
    .eq('status', 'pending')
}

export async function createPardonRequest(
  userId: string,
  body: string,
): Promise<CreateReportResult> {
  const trimmed = body.trim()
  if (!trimmed) return { ok: false, status: 400, error: 'Message required' }
  if (exceedsLimit(trimmed, TEXT_LIMITS.pardonBody)) {
    return {
      ok: false,
      status: 400,
      error: `Message must be at most ${TEXT_LIMITS.pardonBody} characters`,
    }
  }
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('banned_at')
    .eq('id', userId)
    .maybeSingle()
  if (!profile?.banned_at) {
    return { ok: false, status: 400, error: 'You are not banned' }
  }
  const { data, error } = await supabaseAdmin
    .from('pardon_requests')
    .insert({ user_id: userId, body: trimmed, status: 'pending' })
    .select('id')
    .maybeSingle()
  if (error) {
    if (error.code === '23505') {
      return { ok: false, status: 409, error: 'A pardon request is already pending' }
    }
    throw error
  }
  return { ok: true, reportId: data?.id as string, globallyHidden: false }
}
