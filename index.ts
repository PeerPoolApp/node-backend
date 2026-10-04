import 'dotenv/config'
import type { IncomingMessage, ServerResponse } from 'node:http'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import { config } from './config.js'
import { authRoutes } from './routes/auth.js'
import { healthRoutes } from './routes/health.js'
import { messageRoutes } from './routes/messages.js'
import { profileRoutes } from './routes/profile.js'
import { userRoutes } from './routes/users.js'
import { friendRoutes } from './routes/friends.js'
import { pushRoutes } from './routes/push.js'
import { eventRoutes } from './routes/events.js'
import { geoRoutes } from './routes/geo.js'
import { hashtagRoutes } from './routes/hashtags.js'
import { communityRoutes } from './routes/communities.js'
import { notificationRoutes } from './routes/notifications.js'
import { jobRoutes, startTagPropagationInterval } from './routes/jobs.js'
import { accountRoutes } from './routes/account.js'
import { reportRoutes } from './routes/reports.js'
import { adminRoutes } from './routes/admin.js'

const app = Fastify({ logger: true })

await app.register(helmet, {
  crossOriginResourcePolicy: { policy: 'cross-origin' },
})
await app.register(cors, {
  origin: config.corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-job-secret'],
})
await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 } })

await app.register(healthRoutes)
await app.register(authRoutes)
await app.register(profileRoutes)
await app.register(userRoutes)
await app.register(friendRoutes)
await app.register(pushRoutes)
await app.register(notificationRoutes)
await app.register(eventRoutes)
await app.register(hashtagRoutes)
await app.register(geoRoutes)
await app.register(communityRoutes)
await app.register(messageRoutes)
await app.register(jobRoutes)
await app.register(accountRoutes)
await app.register(reportRoutes)
await app.register(adminRoutes)

let stopTagInterval: () => void = () => {}
app.addHook('onClose', async () => {
  stopTagInterval()
})

await app.ready()
stopTagInterval = startTagPropagationInterval(app.log)

/** Vercel Node.js serverless entry — bridges req/res into Fastify. */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  app.server.emit('request', req, res)
}

// Local / Railway-style only — Vercel sets VERCEL and uses the handler export
if (!process.env.VERCEL) {
  await app.listen({ host: config.host, port: config.port })
}
