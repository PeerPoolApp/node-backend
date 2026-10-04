/**
 * Profile routes: avatar upload, signed URL lookup, and profile field updates.
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { exceedsLimit, TEXT_LIMITS } from '../lib/textLimits.js'
import { supabaseAdmin } from '../services/supabase.js'
import {
  createAvatarDownloadUrl,
  processAvatar,
  uploadProfileAvatar,
  validateAvatarUpload,
} from '../services/avatars.js'

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/

type PatchProfileBody = {
  fullName?: string
  username?: string
  birthday?: string
}

function isValidBirthday(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export async function profileRoutes(app: FastifyInstance) {
  app.patch<{ Body: PatchProfileBody }>('/profile', { preHandler: requireAuth }, async (request, reply) => {
    const body = request.body ?? {}
    const updates: Record<string, string> = {}

    if (body.fullName !== undefined) {
      const fullName = body.fullName.trim()
      if (!fullName) {
        return reply.code(400).send({ error: 'Full name is required' })
      }
      if (exceedsLimit(fullName, TEXT_LIMITS.fullName)) {
        return reply.code(400).send({ error: `Full name must be at most ${TEXT_LIMITS.fullName} characters` })
      }
      updates.full_name = fullName
    }

    if (body.username !== undefined) {
      const username = body.username.trim()
      if (!USERNAME_RE.test(username)) {
        return reply.code(400).send({
          error: 'Username must be 3–30 characters (letters, numbers, underscore)',
        })
      }
      const normalizedUsername = username.toLowerCase()
      const { data: existing, error: usernameError } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('username', normalizedUsername)
        .maybeSingle()
      if (usernameError) {
        request.log.error(usernameError)
        return reply.code(500).send({ error: 'Could not check username' })
      }
      if (existing && existing.id !== request.userId) {
        return reply.code(409).send({ error: 'Username is already taken' })
      }
      updates.username = normalizedUsername
    }

    if (body.birthday !== undefined) {
      if (!isValidBirthday(body.birthday)) {
        return reply.code(400).send({ error: 'Birthday must be YYYY-MM-DD' })
      }
      updates.birthday = body.birthday
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: 'No profile fields to update' })
    }

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', request.userId)
      .select(
        'id, username, full_name, birthday, terms_accepted_at, terms_version, created_at, updated_at, avatar_storage_path, avatar_updated_at',
      )
      .single()

    if (error) {
      request.log.error(error)
      return reply.code(500).send({ error: 'Could not update profile' })
    }

    let avatarUrl: string | null = null
    if (data.avatar_storage_path) {
      avatarUrl = await createAvatarDownloadUrl(data.avatar_storage_path)
    }

    return {
      profile: data,
      avatarUrl,
      avatarUpdatedAt: data.avatar_updated_at ?? null,
    }
  })

  app.post('/profile/avatar', { preHandler: requireAuth }, async (request, reply) => {
    const file = await request.file()
    if (!file) {
      return reply.code(400).send({ error: 'avatar file required' })
    }

    const chunks: Buffer[] = []
    for await (const chunk of file.file) {
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)

    const validationError = validateAvatarUpload(buffer)
    if (validationError) {
      return reply.code(400).send({ error: validationError })
    }

    let webp: Buffer
    try {
      webp = await processAvatar(buffer)
    } catch (e) {
      request.log.warn(e)
      return reply.code(400).send({ error: 'Invalid image file' })
    }

    let storagePath: string
    try {
      storagePath = await uploadProfileAvatar(request.userId, webp)
    } catch (e) {
      request.log.error(e)
      return reply.code(500).send({ error: 'Could not upload avatar' })
    }

    const now = new Date().toISOString()
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({ avatar_storage_path: storagePath, avatar_updated_at: now })
      .eq('id', request.userId)

    if (updateError) {
      request.log.error(updateError)
      return reply.code(500).send({ error: 'Could not save avatar path' })
    }

    const avatarUrl = await createAvatarDownloadUrl(storagePath)
    return { avatarStoragePath: storagePath, avatarUrl, avatarUpdatedAt: now }
  })

  app.get<{ Params: { userId: string } }>(
    '/profile/avatar/:userId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { data: profile, error } = await supabaseAdmin
        .from('profiles')
        .select('avatar_storage_path, avatar_updated_at')
        .eq('id', request.params.userId)
        .maybeSingle()

      if (error) {
        request.log.error(error)
        return reply.code(500).send({ error: 'Could not load profile' })
      }
      if (!profile?.avatar_storage_path) {
        return { avatarUrl: null, avatarUpdatedAt: null }
      }

      const avatarUrl = await createAvatarDownloadUrl(profile.avatar_storage_path)
      return {
        avatarUrl,
        avatarStoragePath: profile.avatar_storage_path,
        avatarUpdatedAt: profile.avatar_updated_at ?? null,
      }
    },
  )
}
