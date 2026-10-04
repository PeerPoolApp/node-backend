/**
 * Auth HTTP routes: register, login, refresh, logout, and current profile.
 *
 * Layer: route. Register/login/refresh are public; logout and `/auth/me` use `requireAuth`.
 * Uses `supabaseAuth` for password auth and `supabaseAdmin` for profile/username checks.
 */

import type {FastifyInstance} from 'fastify'
import {requireAuth} from '../middleware/auth.js'
import {supabaseAdmin, supabaseAuth} from '../services/supabase.js'
import {createAvatarDownloadUrl} from '../services/avatars.js'
import {visibleTagsForUser} from '../services/userHashtags.js'
import {TEXT_LIMITS, exceedsLimit} from '../lib/textLimits.js'
import {verifyUserPassword} from '../services/roles.js'

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/
const TERMS_VERSION = '2'

type RegisterBody = {
    email?: string
    password?: string
    passwordConfirm?: string
    fullName?: string
    username?: string
    birthday?: string
    termsAccepted?: boolean
}

type LoginBody = {
    email?: string
    password?: string
}

type RefreshBody = {
    refreshToken?: string
}

type ChangePasswordBody = {
    oldPassword?: string
    newPassword?: string
}

/**
 * Validate birthday string as calendar date YYYY-MM-DD.
 *
 * @auth Internal (pure)
 * @param value - Date string
 * @returns `true` when format and UTC date are valid
 * @pre None
 * @post No I/O
 */
function isValidBirthday(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const date = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Register auth routes on the Fastify app.
 *
 * @auth Public registrar
 * @param app - Fastify instance
 * @pre Supabase clients configured
 * @post Routes: POST `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`; GET `/auth/me`
 */
export async function authRoutes(app: FastifyInstance) {
    /**
     * POST `/auth/register` — create account and optionally return session.
     *
     * @auth Public
     * @body RegisterBody — email, password, profile fields, termsAccepted
     * @returns 201 + tokens when session immediate; 201 + needsEmailConfirmation when verify required
     * @errors 400 validation; 409 username taken; 500 username check failed
     * @pre Username unique; Supabase trigger creates `profiles` row
     * @post User in Supabase Auth; profile via trigger when confirmed
     */
    app.post<{ Body: RegisterBody }>('/auth/register', async (request, reply) => {
        const {
            email,
            password,
            passwordConfirm,
            fullName,
            username,
            birthday,
            termsAccepted,
        } = request.body ?? {}

        if (!email?.trim() || !password) {
            return reply.code(400).send({error: 'Email and password are required'})
        }
        if (exceedsLimit(email.trim(), TEXT_LIMITS.email)) {
            return reply.code(400).send({error: `Email must be at most ${TEXT_LIMITS.email} characters`})
        }
        if (password !== passwordConfirm) {
            return reply.code(400).send({error: 'Passwords do not match'})
        }
        if (password.length < 8) {
            return reply.code(400).send({error: 'Password must be at least 8 characters'})
        }
        if (exceedsLimit(password, TEXT_LIMITS.password)) {
            return reply.code(400).send({error: `Password must be at most ${TEXT_LIMITS.password} characters`})
        }
        if (!fullName?.trim()) {
            return reply.code(400).send({error: 'Full name is required'})
        }
        if (exceedsLimit(fullName.trim(), TEXT_LIMITS.fullName)) {
            return reply.code(400).send({error: `Full name must be at most ${TEXT_LIMITS.fullName} characters`})
        }
        if (!username || !USERNAME_RE.test(username)) {
            return reply.code(400).send({
                error: 'Username must be 3–30 characters (letters, numbers, underscore)',
            })
        }

        const normalizedUsername = username.toLowerCase()

        if (!birthday || !isValidBirthday(birthday)) {
            return reply.code(400).send({error: 'Birthday must be YYYY-MM-DD'})
        }
        if (termsAccepted !== true) {
            return reply.code(400).send({error: 'Terms of use must be accepted'})
        }

        const {data: existing, error: usernameError} = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('username', normalizedUsername)
            .maybeSingle()

        if (usernameError) {
            request.log.error(usernameError)
            return reply.code(500).send({error: 'Could not check username'})
        }
        if (existing) {
            return reply.code(409).send({error: 'Username is already taken'})
        }

        const {data, error} = await supabaseAuth.auth.signUp({
            email: email.trim(),
            password,
            options: {
                data: {
                    username: normalizedUsername,
                    full_name: fullName.trim(),
                    birthday,
                    terms_version: TERMS_VERSION,
                },
            },
        })

        if (error) {
            return reply.code(400).send({error: error.message})
        }

        if (!data.session) {
            return reply.code(201).send({
                needsEmailConfirmation: true,
                user: data.user,
            })
        }

        return reply.code(201).send({
            needsEmailConfirmation: false,
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
            expiresIn: data.session.expires_in,
            user: data.user,
        })
    })

    /**
     * POST `/auth/login` — email/password sign-in.
     *
     * @auth Public
     * @body LoginBody — email, password
     * @returns 200 + accessToken, refreshToken, expiresIn, user
     * @errors 400 missing fields; 401 invalid credentials
     * @pre User exists and password correct
     * @post Session tokens returned to client
     */
    app.post<{ Body: LoginBody }>('/auth/login', async (request, reply) => {
        const {email, password} = request.body ?? {}

        if (!email?.trim() || !password) {
            return reply.code(400).send({error: 'Email and password are required'})
        }
        if (exceedsLimit(email.trim(), TEXT_LIMITS.email) || exceedsLimit(password, TEXT_LIMITS.password)) {
            return reply.code(401).send({error: 'Invalid login credentials'})
        }

        const {data, error} = await supabaseAuth.auth.signInWithPassword({
            email: email.trim(),
            password,
        })

        if (error) {
            return reply.code(401).send({error: error.message})
        }

        if (!data.session) {
            return reply.code(401).send({error: 'Login failed'})
        }

        const deletedProbe = await supabaseAdmin
            .from('profiles')
            .select('deleted_at')
            .eq('id', data.user.id)
            .maybeSingle()
        if (!deletedProbe.error && deletedProbe.data?.deleted_at) {
            try {
                await supabaseAdmin.auth.admin.signOut(data.session.access_token)
            } catch {
                /* ignore */
            }
            return reply.code(401).send({error: 'Invalid login credentials'})
        }

        return {
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
            expiresIn: data.session.expires_in,
            user: data.user,
        }
    })

    /**
     * POST `/auth/refresh` — exchange refresh token for a new session.
     *
     * @auth Public (refresh token in body)
     * @body `{ refreshToken }`
     * @returns 200 + accessToken, refreshToken, expiresIn, user
     * @errors 400 missing token; 401 invalid/expired refresh
     */
    app.post<{ Body: RefreshBody }>('/auth/refresh', async (request, reply) => {
        const refreshToken = request.body?.refreshToken?.trim()
        if (!refreshToken) {
            return reply.code(400).send({error: 'refreshToken required'})
        }

        const {data, error} = await supabaseAuth.auth.refreshSession({
            refresh_token: refreshToken,
        })

        if (error || !data.session) {
            return reply.code(401).send({error: error?.message ?? 'Could not refresh session'})
        }

        return {
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
            expiresIn: data.session.expires_in,
            user: data.user,
        }
    })

    /**
     * POST `/auth/logout` — invalidate token server-side (best effort).
     *
     * @auth Bearer required (`preHandler: requireAuth`)
     * @returns 204 No Content
     * @errors 401 invalid/missing token
     * @pre Valid Bearer token
     * @post Client should discard tokens regardless of admin signOut outcome
     */
    app.post('/auth/logout', {preHandler: requireAuth}, async (request, reply) => {
        const header = request.headers.authorization
        const token = header?.startsWith('Bearer ')
            ? header.slice('Bearer '.length).trim()
            : ''

        if (token) {
            try {
                await supabaseAdmin.auth.admin.signOut(token)
            } catch {
                // Client should discard tokens regardless
            }
        }

        return reply.code(204).send()
    })

    /**
     * GET `/auth/me` — current user email and profile row.
     *
     * @auth Bearer required (`preHandler: requireAuth`)
     * @returns 200 `{ email, profile }`
     * @errors 401 token invalid; 404 profile missing; 500 DB error
     * @pre `request.userId` set by middleware
     * @post Read-only profile fetch
     */
    app.get('/auth/me', {preHandler: requireAuth}, async (request, reply) => {
        const fullSelect =
            'id, username, full_name, birthday, terms_accepted_at, terms_version, created_at, updated_at, avatar_storage_path, avatar_updated_at, app_role, deleted_at, banned_at, ban_reason, ban_details, moderation_hidden_at'
        const coreSelect =
            'id, username, full_name, birthday, terms_accepted_at, terms_version, created_at, updated_at, avatar_storage_path, avatar_updated_at'

        type MeProfile = {
            id: string
            username: string
            full_name: string
            birthday: string | null
            terms_accepted_at: string
            terms_version: string
            created_at: string
            updated_at: string
            avatar_storage_path: string | null
            avatar_updated_at: string | null
            app_role?: string | null
            deleted_at?: string | null
            banned_at?: string | null
            ban_reason?: string | null
            ban_details?: string | null
            moderation_hidden_at?: string | null
        }

        let profile: MeProfile | null = null
        let error: { message?: string; code?: string } | null = null

        const fullRes = await supabaseAdmin
            .from('profiles')
            .select(fullSelect)
            .eq('id', request.userId)
            .maybeSingle()
        profile = (fullRes.data as MeProfile | null) ?? null
        error = fullRes.error

        if (error) {
            const msg = (error.message ?? '').toLowerCase()
            if (
                error.code === '42703' ||
                msg.includes('app_role') ||
                msg.includes('deleted_at') ||
                msg.includes('banned_at')
            ) {
                const retry = await supabaseAdmin
                    .from('profiles')
                    .select(coreSelect)
                    .eq('id', request.userId)
                    .maybeSingle()
                profile = (retry.data as MeProfile | null) ?? null
                error = retry.error
            }
        }

        if (error) {
            request.log.error(error)
            return reply.code(500).send({error: 'Could not load profile'})
        }
        if (!profile) {
            return reply.code(404).send({error: 'Profile not found'})
        }
        if (profile.deleted_at) {
            return reply.code(403).send({error: 'Account deleted'})
        }

        const avatarUrl = profile.avatar_storage_path
            ? await createAvatarDownloadUrl(profile.avatar_storage_path)
            : null

        const tags = await visibleTagsForUser(request.userId)

        return {
            email: request.userEmail,
            profile,
            avatarUrl,
            avatarUpdatedAt: profile.avatar_updated_at ?? null,
            tags,
            appRole: profile.app_role ?? 'user',
            bannedAt: profile.banned_at ?? null,
            banReason: profile.ban_reason ?? null,
            banDetails: profile.ban_details ?? null,
        }
    })

    /**
     * POST `/auth/change-password` — verify old password then set a new one.
     */
    app.post<{Body: ChangePasswordBody}>(
        '/auth/change-password',
        {preHandler: requireAuth},
        async (request, reply) => {
            const {oldPassword, newPassword} = request.body ?? {}
            if (!oldPassword || !newPassword) {
                return reply.code(400).send({error: 'Old and new password are required'})
            }
            if (newPassword.length < 8) {
                return reply.code(400).send({error: 'Password must be at least 8 characters'})
            }
            if (exceedsLimit(newPassword, TEXT_LIMITS.password)) {
                return reply
                    .code(400)
                    .send({error: `Password must be at most ${TEXT_LIMITS.password} characters`})
            }
            const email = request.userEmail
            if (!email) {
                return reply.code(400).send({error: 'Account email is required'})
            }
            if (!(await verifyUserPassword(email, oldPassword))) {
                return reply.code(403).send({error: 'Current password is incorrect'})
            }
            const {error} = await supabaseAdmin.auth.admin.updateUserById(request.userId, {
                password: newPassword,
            })
            if (error) {
                request.log.error(error)
                return reply.code(500).send({error: 'Could not change password'})
            }
            return reply.code(204).send()
        },
    )
}
