/**
 * Persist non-message notifications into user_notifications for the in-app inbox.
 */

import { supabaseAdmin } from '../supabase.js'
import type { NotificationKind, NotificationPayload } from './types.js'

export async function insertUserNotifications(
  userIds: string[],
  payload: NotificationPayload,
  opts?: { log?: { warn: (e: unknown) => void } },
): Promise<void> {
  const kind = payload.kind as NotificationKind
  if (kind === 'message') return
  if (
    kind !== 'friend_request' &&
    kind !== 'event_invite' &&
    kind !== 'event_notice' &&
    kind !== 'community_invite'
  ) {
    return
  }
  if (userIds.length === 0) return

  const data: Record<string, string> = {}
  if (payload.conversationId) data.conversationId = payload.conversationId
  if (payload.messageId) data.messageId = payload.messageId
  if (payload.requestId) data.requestId = payload.requestId
  if (payload.eventId) data.eventId = payload.eventId
  if (payload.communityId) data.communityId = payload.communityId
  if (payload.inviteToken) data.inviteToken = payload.inviteToken

  const rows = userIds.map((userId) => ({
    user_id: userId,
    kind,
    title: payload.title.slice(0, 200) || 'Notification',
    body: payload.body.slice(0, 500),
    data,
  }))

  const { error } = await supabaseAdmin.from('user_notifications').insert(rows)
  if (error) {
    opts?.log?.warn(error)
  }
}
