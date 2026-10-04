/**
 * Health check routes (unauthenticated liveness probe).
 *
 * Layer: route. Registered in `index.ts` before auth/messaging routes.
 */

import type { FastifyInstance } from 'fastify'

/**
 * Register health check routes on the Fastify app.
 *
 * @auth Public registrar
 * @param app - Fastify instance
 * @pre None
 * @post `GET /health` available
 */
export async function healthRoutes(app: FastifyInstance) {
  /**
   * Liveness probe.
   *
   * @auth Public
   * @returns `{ ok: true }`
   * @pre None
   * @post No side effects
   */
  app.get('/health', async () => {
    return { ok: true }
  })
}
