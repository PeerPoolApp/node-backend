/**
 * Notification title/body builders for domain events.
 */

import type { NotificationPayload } from './types.js'

function previewBody(body: string | null, hasAttachment: boolean): string {
  if (body?.trim()) {
    const t = body.trim()
    return t.length > 80 ? `${t.slice(0, 80)}…` : t
  }
  if (hasAttachment) return 'Sent an image'
  return 'New message'
}

export function messageNotification(input: {
  senderName: string
  senderId: string
  body: string | null
  conversationId: string
  messageId: string
  createdAt: string
  hasAttachment?: boolean
  communityId?: string
}): NotificationPayload {
  const payload: NotificationPayload = {
    kind: 'message',
    title: input.senderName,
    body: previewBody(input.body, input.hasAttachment ?? false),
    conversationId: input.conversationId,
    messageId: input.messageId,
    senderId: input.senderId,
    createdAt: input.createdAt,
  }
  if (input.communityId) payload.communityId = input.communityId
  return payload
}

export function friendRequestNotification(input: {
  requesterName: string
  requestId: string
}): NotificationPayload {
  return {
    kind: 'friend_request',
    title: 'Friend request',
    body: `${input.requesterName} wants to be friends`,
    requestId: input.requestId,
  }
}

export function eventInviteNotification(input: {
  organizerName: string
  eventTitle: string
  eventId: string
}): NotificationPayload {
  return {
    kind: 'event_invite',
    title: 'Event invite',
    body: `${input.organizerName} invited you to ${input.eventTitle}`,
    eventId: input.eventId,
  }
}

export function eventNoticeNotification(input: {
  organizerName: string
  eventTitle: string
  eventId: string
}): NotificationPayload {
  return {
    kind: 'event_notice',
    title: input.eventTitle,
    body: `${input.organizerName} sent a reminder about this event`,
    eventId: input.eventId,
  }
}

export function communityInviteNotification(input: {
  inviterName: string
  communityName: string
  communityId: string
}): NotificationPayload {
  return {
    kind: 'community_invite',
    title: 'Community invite',
    body: `${input.inviterName} invited you to ${input.communityName}`,
    communityId: input.communityId,
  }
}
