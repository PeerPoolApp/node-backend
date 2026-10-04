/**
 * Web Push delivery via VAPID (browser / PWA when app closed).
 */

import webpush from 'web-push'
import { config } from '../../../config.js'
import type { NotificationPayload } from '../types.js'

let configured = false

function ensureWebPush(): boolean {
  if (configured) return true
  if (!config.vapidPublicKey || !config.vapidPrivateKey) return false
  webpush.setVapidDetails(
    config.vapidSubject,
    config.vapidPublicKey,
    config.vapidPrivateKey,
  )
  configured = true
  return true
}

export function isWebPushConfigured(): boolean {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey)
}

export function getVapidPublicKey(): string | null {
  return config.vapidPublicKey
}

/**
 * Send to a stored web push subscription JSON string.
 */
export async function sendWebPush(
  subscriptionJson: string,
  payload: NotificationPayload,
): Promise<void> {
  if (!ensureWebPush()) return
  const subscription = JSON.parse(subscriptionJson) as webpush.PushSubscription
  await webpush.sendNotification(
    subscription,
    JSON.stringify(payload),
    { TTL: 60 * 60 * 24 },
  )
}
