/**
 * Shared notification payload contract (backend + clients).
 * All FCM data values must be strings — use payloadToData() when sending.
 */

export type NotificationKind =
  | 'message'
  | 'friend_request'
  | 'event_invite'
  | 'event_notice'
  | 'community_invite'

export type NotificationPayload = {
  kind: NotificationKind
  title: string
  body: string
  conversationId?: string
  messageId?: string
  /** Message sender — required for push→Pinia live chat. */
  senderId?: string
  /** Message created_at ISO — for push→Pinia live chat. */
  createdAt?: string
  requestId?: string
  eventId?: string
  communityId?: string
  inviteToken?: string
}

export type PushPlatform = 'ios' | 'android' | 'web'

/** Flat string map for FCM data payloads. */
export function payloadToData(payload: NotificationPayload): Record<string, string> {
  const data: Record<string, string> = {
    kind: payload.kind,
    title: payload.title,
    body: payload.body,
  }
  if (payload.conversationId) data.conversationId = payload.conversationId
  if (payload.messageId) data.messageId = payload.messageId
  if (payload.senderId) data.senderId = payload.senderId
  if (payload.createdAt) data.createdAt = payload.createdAt
  if (payload.requestId) data.requestId = payload.requestId
  if (payload.eventId) data.eventId = payload.eventId
  if (payload.communityId) data.communityId = payload.communityId
  if (payload.inviteToken) data.inviteToken = payload.inviteToken
  return data
}

/** Parse notification data from push event (FCM / Web Push). */
export function dataToPayload(data: Record<string, unknown>): NotificationPayload | null {
  const kind = data.kind
  if (kind !== 'message' && kind !== 'friend_request' && kind !== 'event_invite' && kind !== 'event_notice' && kind !== 'community_invite') return null
  const title = typeof data.title === 'string' ? data.title : ''
  const body = typeof data.body === 'string' ? data.body : ''
  const payload: NotificationPayload = { kind, title, body }
  if (typeof data.conversationId === 'string') payload.conversationId = data.conversationId
  if (typeof data.messageId === 'string') payload.messageId = data.messageId
  if (typeof data.senderId === 'string') payload.senderId = data.senderId
  if (typeof data.createdAt === 'string') payload.createdAt = data.createdAt
  if (typeof data.requestId === 'string') payload.requestId = data.requestId
  if (typeof data.eventId === 'string') payload.eventId = data.eventId
  if (typeof data.communityId === 'string') payload.communityId = data.communityId
  if (typeof data.inviteToken === 'string') payload.inviteToken = data.inviteToken
  return payload
}
