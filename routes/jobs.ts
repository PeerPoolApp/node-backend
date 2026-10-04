/**
 * Internal jobs (secret-gated). Tag affinity propagation after events end.
 */

import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { runTagPropagationBatch } from '../services/tagPropagation.js'

function assertJobSecret(header: string | string[] | undefined): boolean {
  const expected = config.tagPropagationSecret
  if (!expected) return false
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return false
  if (raw === expected) return true
  if (raw.startsWith('Bearer ') && raw.slice(7) === expected) return true
  return false
}

export async function jobRoutes(app: FastifyInstance) {
  /**
   * POST /jobs/tag-propagation
   * Auth: Authorization: Bearer <TAG_PROPAGATION_SECRET> or x-job-secret header.
   */
  app.post('/jobs/tag-propagation', async (request, reply) => {
    if (!config.tagPropagationSecret) {
      return reply.code(503).send({ error: 'Tag propagation job not configured' })
    }
    const auth = request.headers.authorization
    const alt = request.headers['x-job-secret']
    if (!assertJobSecret(auth) && !assertJobSecret(alt)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    try {
      const result = await runTagPropagationBatch()
      return { ok: true, ...result }
    } catch (e) {
      request.log.error(e)
      return reply.code(500).send({ error: 'Tag propagation failed' })
    }
  })
}

/**
 * Optional in-process interval when TAG_PROPAGATION_INTERVAL_MS is set.
 */
export function startTagPropagationInterval(log: {
  info: (o: unknown, msg?: string) => void
  error: (o: unknown, msg?: string) => void
}): () => void {
  const ms = config.tagPropagationIntervalMs
  if (!ms || ms < 10_000) return () => {}
  if (!config.tagPropagationSecret) {
    log.info({}, 'TAG_PROPAGATION_INTERVAL_MS set but TAG_PROPAGATION_SECRET missing; interval off')
    return () => {}
  }
  log.info({ ms }, 'Starting tag propagation interval')
  const id = setInterval(() => {
    void runTagPropagationBatch()
      .then((r) => {
        if (r.processed > 0) log.info(r, 'Tag propagation batch')
      })
      .catch((e) => log.error(e, 'Tag propagation interval failed'))
  }, ms)
  return () => {
    clearInterval(id)
  }
}
