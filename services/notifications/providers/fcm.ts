/**
 * FCM delivery for Capacitor native (iOS/Android). Throws when credentials missing
 * so callers can surface configuration errors.
 */

import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getMessaging, type Messaging } from 'firebase-admin/messaging'
import { config } from '../../../config.js'
import { payloadToData, type NotificationPayload } from '../types.js'

type FcmCred = {
  project_id: string
  client_email: string
  private_key: string
}

let messaging: Messaging | null = null

function ensureFcm(): Messaging {
  if (messaging) return messaging
  if (!config.fcmServiceAccountJson) {
    throw new Error('FCM not configured (FCM_SERVICE_ACCOUNT_JSON unset)')
  }
  try {
    const cred = JSON.parse(config.fcmServiceAccountJson) as FcmCred
    if (!cred.project_id || !cred.client_email || !cred.private_key) {
      throw new Error('FCM_SERVICE_ACCOUNT_JSON missing project_id/client_email/private_key')
    }
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: cred.project_id,
          clientEmail: cred.client_email,
          privateKey: cred.private_key,
        }),
      })
    }
    messaging = getMessaging()
    return messaging
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`FCM init failed: ${msg}`)
  }
}

export function isFcmConfigured(): boolean {
  return Boolean(config.fcmServiceAccountJson)
}

export async function sendFcm(
  token: string,
  _platform: 'ios' | 'android',
  payload: NotificationPayload,
): Promise<void> {
  const msg = ensureFcm()
  const data = payloadToData(payload)
  // Tag by message id so Android does not collapse/replace with a previous body.
  const tag = payload.messageId || payload.conversationId || 'peerpool'
  await msg.send({
    token,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data,
    android: {
      priority: 'high',
      notification: {
        channelId: 'messages',
        tag,
        // Ensure tray text matches this message (not a collapsed prior one).
        body: payload.body,
        title: payload.title,
      },
    },
    apns: {
      headers: {
        'apns-collapse-id': tag,
      },
      payload: {
        aps: {
          alert: { title: payload.title, body: payload.body },
          sound: 'default',
        },
      },
    },
  })
}
