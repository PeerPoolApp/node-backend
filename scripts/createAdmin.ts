/**
 * One-shot CLI: create or promote the single PeerPool admin account.
 *
 * Dashboard Auth → Add user fails because handle_new_user requires
 * username / full_name / birthday in raw_user_meta_data. This uses
 * auth.admin.createUser with the same metadata as POST /auth/register,
 * then sets profiles.app_role (what requireAdmin checks).
 *
 * Usage (from node-backend, with .env loaded):
 *   set ADMIN_EMAIL=...
 *   set ADMIN_PASSWORD=...
 *   npx tsx scripts/createAdmin.ts
 *
 * Optional: ADMIN_USERNAME, ADMIN_FULL_NAME, ADMIN_BIRTHDAY.
 * Existing Auth users are reused; password is not changed.
 */
import 'dotenv/config'
import { TEXT_LIMITS, exceedsLimit } from '../lib/textLimits.js'
import { supabaseAdmin } from '../services/supabase.js'

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/
const TERMS_VERSION = '2'
const MIGRATION = 'database/migration/20260929143300_gdpr_reports_moderation.sql'

type AuthUserLite = { id: string; email: string | undefined }

/**
 * Print to stderr and exit 1.
 */
function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

/**
 * Validate birthday string as calendar date YYYY-MM-DD.
 */
function isValidBirthday(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isMissingAppRoleColumn(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('app_role') && (lower.includes('does not exist') || lower.includes('schema cache'))
}

/**
 * Find an Auth user by email via admin listUsers (paginated).
 */
async function findAuthUserByEmail(email: string): Promise<AuthUserLite | null> {
  const needle = email.toLowerCase()
  let page = 1
  for (;;) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const users = data.users ?? []
    const found = users.find((u) => u.email?.toLowerCase() === needle)
    if (found) return { id: found.id, email: found.email }
    if (users.length < 200) return null
    page += 1
    if (page > 50) return null
  }
}

async function main(): Promise<void> {
  const email = (process.env.ADMIN_EMAIL ?? '').trim()
  const password = process.env.ADMIN_PASSWORD ?? ''
  const usernameRaw = (process.env.ADMIN_USERNAME ?? 'peerpool_admin').trim()
  const fullName = (process.env.ADMIN_FULL_NAME ?? 'PeerPool Admin').trim()
  const birthday = (process.env.ADMIN_BIRTHDAY ?? '1990-01-01').trim()

  if (!email) fail('ADMIN_EMAIL is required')
  if (exceedsLimit(email, TEXT_LIMITS.email)) {
    fail(`ADMIN_EMAIL must be at most ${TEXT_LIMITS.email} characters`)
  }
  if (!password) fail('ADMIN_PASSWORD is required')
  if (password.length < 8) fail('ADMIN_PASSWORD must be at least 8 characters')
  if (exceedsLimit(password, TEXT_LIMITS.password)) {
    fail(`ADMIN_PASSWORD must be at most ${TEXT_LIMITS.password} characters`)
  }
  if (!USERNAME_RE.test(usernameRaw)) {
    fail('ADMIN_USERNAME must be 3–30 characters (letters, numbers, underscore)')
  }
  const username = usernameRaw.toLowerCase()
  if (!fullName) fail('ADMIN_FULL_NAME is required')
  if (exceedsLimit(fullName, TEXT_LIMITS.fullName)) {
    fail(`ADMIN_FULL_NAME must be at most ${TEXT_LIMITS.fullName} characters`)
  }
  if (!isValidBirthday(birthday)) fail('ADMIN_BIRTHDAY must be YYYY-MM-DD')

  const probe = await supabaseAdmin.from('profiles').select('id, app_role').limit(1)
  if (probe.error) {
    if (isMissingAppRoleColumn(probe.error.message)) {
      fail(`profiles.app_role is missing. Apply ${MIGRATION} first.`)
    }
    fail(`Could not read profiles: ${probe.error.message}`)
  }

  const adminRes = await supabaseAdmin
    .from('profiles')
    .select('id, username, app_role')
    .eq('app_role', 'admin')
    .maybeSingle()
  if (adminRes.error) {
    if (isMissingAppRoleColumn(adminRes.error.message)) {
      fail(`profiles.app_role is missing. Apply ${MIGRATION} first.`)
    }
    fail(`Could not load admin profile: ${adminRes.error.message}`)
  }

  const existingAdmin = adminRes.data
  if (existingAdmin) {
    const { data: adminAuth, error: adminAuthErr } = await supabaseAdmin.auth.admin.getUserById(
      existingAdmin.id,
    )
    if (adminAuthErr || !adminAuth.user) {
      fail(`Admin profile ${existingAdmin.id} has no Auth user: ${adminAuthErr?.message ?? 'not found'}`)
    }
    const adminEmail = adminAuth.user.email?.toLowerCase() ?? ''
    if (adminEmail === email.toLowerCase()) {
      console.log(`Admin already set: ${existingAdmin.id} ${adminAuth.user.email}`)
      console.log('Log in on admin-frontend (port 5176) or the admin APK. Do not use the main PeerPool app.')
      return
    }
    fail(
      `Another admin already exists (${existingAdmin.id}, ${adminAuth.user.email ?? 'no email'}). Demote that profile first.`,
    )
  }

  let userId: string
  const existingAuth = await findAuthUserByEmail(email)
  if (existingAuth) {
    userId = existingAuth.id
    console.log(`Auth user already exists (${userId}); password unchanged.`)
  } else {
    const taken = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('username', username)
      .maybeSingle()
    if (taken.error) fail(`Could not check username: ${taken.error.message}`)
    if (taken.data) fail(`Username ${username} is already taken`)

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        username,
        full_name: fullName,
        birthday,
        terms_version: TERMS_VERSION,
      },
    })
    if (createErr || !created.user) {
      fail(`createUser failed: ${createErr?.message ?? 'no user returned'}`)
    }
    userId = created.user.id
    console.log(`Created Auth user ${userId}`)
  }

  const profileRes = await supabaseAdmin.from('profiles').select('id').eq('id', userId).maybeSingle()
  if (profileRes.error) fail(`Could not load profile: ${profileRes.error.message}`)
  if (!profileRes.data) {
    const taken = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('username', username)
      .maybeSingle()
    if (taken.error) fail(`Could not check username: ${taken.error.message}`)
    if (taken.data) fail(`Username ${username} is already taken`)

    const { error: insertErr } = await supabaseAdmin.from('profiles').insert({
      id: userId,
      username,
      full_name: fullName,
      birthday,
      terms_accepted_at: new Date().toISOString(),
      terms_version: TERMS_VERSION,
      app_role: 'user',
    })
    if (insertErr) fail(`Could not insert profile: ${insertErr.message}`)
    console.log('Inserted missing profiles row')
  }

  const { error: roleErr } = await supabaseAdmin
    .from('profiles')
    .update({ app_role: 'admin' })
    .eq('id', userId)
  if (roleErr) fail(`Could not set app_role: ${roleErr.message}`)

  const { error: metaErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    app_metadata: { app_role: 'admin' },
  })
  if (metaErr) fail(`Could not set Auth app_metadata: ${metaErr.message}`)

  console.log(`Admin ready: ${userId} ${email}`)
  console.log('Log in on admin-frontend (port 5176) or the admin APK. Do not use the main PeerPool app.')
}

try {
  await main()
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
