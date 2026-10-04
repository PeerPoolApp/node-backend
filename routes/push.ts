/**
 * Push device registration and VAPID public key.
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { supabaseAdmin } from '../services/supabase.js'
import { getVapidPublicKey, isWebPushConfigured } from '../services/notifications/providers/webPush.js'
import { isFcmConfigured } from '../services/notifications/providers/fcm.js'
import { notifyUsers } from '../services/notifications/dispatcher.js'
import type { NotificationPayload } from '../services/notifications/types.js'

type RegisterBody = {
  platform?: 'ios' | 'android' | 'web'
  token?: string
}

export async function pushRoutes(app: FastifyInstance) {
  app.get('/push/vapid-public-key', async (_request, reply) => {
    if (!isWebPushConfigured()) {
      return reply.code(503).send({ error: 'Web push not configured' })
    }
    const publicKey = getVapidPublicKey()
    if (!publicKey) {
      return reply.code(503).send({ error: 'Web push not configured' })
    }
    return { publicKey }
  })

  app.post<{ Body: RegisterBody }>(
    '/push/register',
    { preHandler: requireAuth },
    async (request, reply) => {
      const platform = request.body?.platform
      const token = request.body?.token?.trim()
      if (!platform || !['ios', 'android', 'web'].includes(platform)) {
        return reply.code(400).send({ error: 'Invalid platform' })
      }
      if (!token) {
        return reply.code(400).send({ error: 'token is required' })
      }

      const { error } = await supabaseAdmin.from('push_devices').upsert(
        {
          user_id: request.userId,
          platform,
          token,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,platform,token' },
      )

      if (error) {
        request.log.error(error)
        return reply.code(500).send({
          error: 'Could not register device',
          details: error.message,
          code: error.code,
        })
      }

      return reply.code(204).send()
    },
  )

  app.delete<{ Body: RegisterBody }>(
    '/push/register',
    { preHandler: requireAuth },
    async (request, reply) => {
      const platform = request.body?.platform
      const token = request.body?.token?.trim()
      if (!platform || !token) {
        return reply.code(400).send({ error: 'platform and token required' })
      }

      const { error } = await supabaseAdmin
        .from('push_devices')
        .delete()
        .eq('user_id', request.userId)
        .eq('platform', platform)
        .eq('token', token)

      if (error) {
        request.log.error(error)
        return reply.code(500).send({
          error: 'Could not unregister device',
          details: error.message,
          code: error.code,
        })
      }

      return reply.code(204).send()
    },
  )

  /**
   * POST `/push/test` — send a test notification to the logged-in user.
   * Used by TestApiView; requires a registered push device for delivery.
   */
  app.post('/push/test', { preHandler: requireAuth }, async (request, reply) => {
    const payload: NotificationPayload = {
      kind: 'message',
      title: 'Test notification',
      body: 'Push works',
    }

    const { data: devices, error } = await supabaseAdmin
      .from('push_devices')
      .select('id, platform')
      .eq('user_id', request.userId)

    if (error) {
      request.log.error(error)
      return reply.code(500).send({
        error: 'Could not check devices',
        details: error.message,
        code: error.code,
        hint:
          error.message?.includes('push_devices') || error.code === '42P01' || error.code === 'PGRST205'
            ? 'Run database/migration/20260728143000_push_devices_realtime.sql on Supabase'
            : undefined,
      })
    }

    const deviceCount = devices?.length ?? 0
    const fcmConfigured = isFcmConfigured()
    const webPushConfigured = isWebPushConfigured()
    const hasAndroid = (devices ?? []).some((d) => d.platform === 'android' || d.platform === 'ios')
    const hasWeb = (devices ?? []).some((d) => d.platform === 'web')

    if (deviceCount === 0) {
      return {
        ok: false,
        deviceCount: 0,
        fcmConfigured,
        webPushConfigured,
        message: 'No registered devices — allow notifications (Chat or Test Api) first',
      }
    }

    if (hasAndroid && !fcmConfigured) {
      return reply.code(503).send({
        error: 'FCM_SERVICE_ACCOUNT_JSON not set on server — cannot push to Android/iOS',
        deviceCount,
        fcmConfigured,
        webPushConfigured,
      })
    }

    if (hasWeb && !webPushConfigured && !hasAndroid) {
      return reply.code(503).send({
        error: 'Web push (VAPID) not configured and no native devices',
        deviceCount,
        fcmConfigured,
        webPushConfigured,
      })
    }

    await notifyUsers([request.userId], payload, { log: request.log })

    return {
      ok: true,
      deviceCount,
      fcmConfigured,
      webPushConfigured,
      message: 'Test notification sent to registered devices',
    }
  })
}
