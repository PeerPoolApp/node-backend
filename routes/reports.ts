/**
 * User-facing reports. Auth required. Not for the admin app.
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import {
  createReport,
  isReportReason,
  isTargetKind,
} from '../services/moderation.js'

export async function reportRoutes(app: FastifyInstance) {
  /**
   * POST `/reports` — create a report + 1x hide; 2 reporters → global hide.
   */
  app.post<{
    Body: { targetKind?: string; targetId?: string; reason?: string; details?: string }
  }>('/reports', { preHandler: requireAuth }, async (request, reply) => {
    const targetKind = request.body?.targetKind?.trim() ?? ''
    const targetId = request.body?.targetId?.trim() ?? ''
    const reason = request.body?.reason?.trim() ?? ''
    const details = request.body?.details ?? null
    if (!isTargetKind(targetKind) || !targetId || !isReportReason(reason)) {
      return reply.code(400).send({ error: 'Invalid report' })
    }
    try {
      const result = await createReport({
        reporterId: request.userId,
        targetKind,
        targetId,
        reason,
        details,
      })
      if (!result.ok) return reply.code(result.status).send({ error: result.error })
      return { ok: true, id: result.reportId, globallyHidden: result.globallyHidden }
    } catch (e) {
      request.log.error(e)
      return reply.code(500).send({ error: 'Could not submit report' })
    }
  })
}
