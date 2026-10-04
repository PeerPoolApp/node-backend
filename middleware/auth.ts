/**
 * Fastify auth middleware: validate Bearer JWT and attach user to request.
 *
 * Layer: middleware. Uses `supabaseAuth.auth.getUser` (publishable key).
 * On success sets `request.userId` and `request.userEmail` for route handlers.
 * `requireAdmin` is requireAuth plus profiles.app_role = admin.
 */

import type {FastifyReply, FastifyRequest} from 'fastify'
import {supabaseAuth} from '../services/supabase.js'
import {isAdminUser} from '../services/moderation.js'

declare module 'fastify' {
    interface FastifyRequest {
        /** Set by `requireAuth` after successful JWT validation. */
        userId: string
        /** Set by `requireAuth`; may be null when email not in token. */
        userEmail: string | null
    }
}

/**
 * Fastify preHandler: require a valid Bearer access token.
 *
 * @auth Bearer required
 * @param request - Incoming request; `Authorization: Bearer <token>` expected
 * @param reply - Used to send 401 and halt the chain on failure
 * @returns void; sends 401 reply when auth fails
 * @pre Route registered with `{ preHandler: requireAuth }`
 * @post On success: `request.userId` and `request.userEmail` set; handler runs next
 */
export async function requireAuth(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) {
        return reply.code(401).send({error: 'Missing or invalid Authorization header'})
    }

    const token = header.slice('Bearer '.length).trim()
    if (!token) {
        return reply.code(401).send({error: 'Missing access token'})
    }

    const {data, error} = await supabaseAuth.auth.getUser(token)
    if (error || !data.user) {
        return reply.code(401).send({error: 'Invalid or expired token'})
    }

    request.userId = data.user.id
    request.userEmail = data.user.email ?? null
}

/**
 * Fastify preHandler: requireAuth then profiles.app_role = admin.
 */
export async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    await requireAuth(request, reply)
    if (reply.sent) return
    const ok = await isAdminUser(request.userId)
    if (!ok) {
        return reply.code(403).send({error: 'Admin only'})
    }
}
