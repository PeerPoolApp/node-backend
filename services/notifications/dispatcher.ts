/**
 * Fan-out push notifications to registered devices per user.
 */

import { supabaseAdmin } from '../supabase.js'
import type { NotificationPayload } from './types.js'
import { sendWebPush } from './providers/webPush.js'
import { sendFcm } from './providers/fcm.js'
import { insertUserNotifications } from './inbox.js'

type Logger = { warn: (e: unknown) => void; error?: (e: unknown) => void }

/**
 * Notify one or more users on all registered devices (web + native).
 * Non-message kinds also write `user_notifications` inbox rows.
 * Never throws — logs failures per device.
 */
export async function notifyUsers(
  userIds: string[],
  payload: NotificationPayload,
  opts?: { excludeUserId?: string; log?: Logger },
): Promise<void> {
  const targets = userIds.filter((id) => id !== opts?.excludeUserId)
  if (targets.length === 0) return

  if (payload.kind !== 'message') {
    await insertUserNotifications(targets, payload, opts?.log ? { log: opts.log } : undefined)
  }

  const { data: devices, error } = await supabaseAdmin
    .from('push_devices')
    .select('id, user_id, platform, token')
    .in('user_id', targets)

  if (error) {
    opts?.log?.error?.(error) ?? opts?.log?.warn(error)
    return
  }

  await Promise.all(
    (devices ?? []).map(async (device: { id: string; platform: string; token: string }) => {
      try {
        if (device.platform === 'web') {
          await sendWebPush(device.token, payload)
        } else if (device.platform === 'ios' || device.platform === 'android') {
          await sendFcm(device.token, device.platform, payload)
        }
      } catch (e) {
        opts?.log?.warn(e)
        const status = (e as { statusCode?: number })?.statusCode
        if (status === 404 || status === 410) {
          await supabaseAdmin.from('push_devices').delete().eq('id', device.id)
        }
      }
    }),
  )
}
