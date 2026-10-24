/**
 * GDPR account export + delete. Auth required. Mutations via supabaseAdmin.
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { supabaseAdmin } from '../services/supabase.js'
import { collectPersonalData, loadExportMedia } from '../services/accountExport.js'
import { personalDataPdf } from '../services/accountExportPdf.js'
import { eraseAccount } from '../services/accountErase.js'
import { createPardonRequest } from '../services/moderation.js'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'

export async function accountRoutes(app: FastifyInstance) {
  /** Authenticated access copy. Fail the whole export rather than label a partial copy complete. */
  app.get<{ Querystring: { format?: string } }>(
    '/account/export',
    { preHandler: requireAuth },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
      if (request.query.format && !['pdf', 'json'].includes(request.query.format))
        return reply.code(400).send({ error: 'Choose PDF or JSON' })
      try {
        const data = await collectPersonalData(request.userId, request.userEmail)
        if (request.query.format === 'pdf') {
          const media = await loadExportMedia(data)
          const pdf = await personalDataPdf(data, media)
          return reply
            .type('application/pdf')
            .header('Content-Disposition', 'attachment; filename="peerpool-personal-data.pdf"')
            .send(pdf)
        }
        return reply
          .type('application/json; charset=utf-8')
          .header('Content-Disposition', 'attachment; filename="peerpool-personal-data.json"')
          .send(data)
      } catch (error) {
        request.log.error({ err: error }, 'Personal data export failed')
        return reply.code(500).send({
          error:
            'Your export could not be completed. Please try again; no partial export was created.',
        })
      }
    },
  )

  /**
   * POST `/account/delete` — `{ confirm: "delete" }` in-place erase.
   */
  app.post<{ Body: { confirm?: string } }>(
    '/account/delete',
    { preHandler: requireAuth },
    async (request, reply) => {
      const confirm = (request.body?.confirm ?? '').trim()
      if (confirm !== 'delete') {
        return reply.code(400).send({ error: 'Type delete to confirm' })
      }
      try {
        const result = await eraseAccount(request.userId)
        if (!result.ok) return reply.code(result.status).send({ error: result.error })
        return { ok: true }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not delete account' })
      }
    },
  )

  /**
   * POST `/account/pardon` — banned users request a pardon.
   */
  app.post<{ Body: { body?: string } }>(
    '/account/pardon',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = request.body?.body ?? ''
      if (exceedsLimit(body, TEXT_LIMITS.pardonBody)) {
        return reply.code(400).send({
          error: `Message must be at most ${TEXT_LIMITS.pardonBody} characters`,
        })
      }
      try {
        const result = await createPardonRequest(request.userId, body)
        if (!result.ok) return reply.code(result.status).send({ error: result.error })
        return { ok: true, id: result.reportId }
      } catch (e) {
        request.log.error(e)
        return reply.code(500).send({ error: 'Could not submit pardon request' })
      }
    },
  )
}
