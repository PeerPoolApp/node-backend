/**
 * Process env for the Fastify API (local, Vercel, Coolify/Docker).
 * Production SPA origin is always CORS-merged; bind HOST=0.0.0.0 in containers.
 * See context/implemented/coolify-hetzner-backend.md.
 */

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env: ${name}`)
  return value
}

/** Cap origins always allowed for embedded Capacitor WebView. */
const CAPACITOR_ORIGINS = [
  'https://localhost',
  'capacitor://localhost',
  'http://localhost',
]

/** Local Vite ports (5173 + fallbacks; 5176 is admin-frontend). */
const LOCAL_VITE_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
]

/** Same ports as loopback — Cursor / some browsers send Origin 127.0.0.1. */
const LOCAL_VITE_LOOPBACK = LOCAL_VITE_ORIGINS.map((o) =>
  o.replace('://localhost', '://127.0.0.1'),
)

/** Production SPA on Cloudflare. Always merged so a stale Coolify CORS_ORIGIN still works. */
const PRODUCTION_WEB_ORIGINS = ['https://app.peerpool.at']

/**
 * Parse CORS_ORIGIN (comma-separated) and always merge local Vite + Capacitor + production web.
 * A stale CORS_ORIGIN (e.g. 5173–5175 only) must not block admin on 5176 or the public SPA.
 */
function resolveCorsOrigin(): boolean | string | string[] {
  const raw = process.env.CORS_ORIGIN ?? LOCAL_VITE_ORIGINS.join(',')
  const configured = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const merged = [
    ...new Set([
      ...configured,
      ...LOCAL_VITE_ORIGINS,
      ...LOCAL_VITE_LOOPBACK,
      ...CAPACITOR_ORIGINS,
      ...PRODUCTION_WEB_ORIGINS,
    ]),
  ]
  return merged.length === 1 ? merged[0]! : merged
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
  corsOrigin: resolveCorsOrigin(),

  supabaseUrl: required('SUPABASE_URL'),
  supabasePublishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
  supabaseSecretKey: required('SUPABASE_SECRET_KEY'),

  /** Web Push VAPID — optional; web push disabled when unset */
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:support@peerpool.at',

  /**
   * Firebase service account JSON string (single line) for native FCM.
   * Get from Firebase Console → Project settings → Service accounts → Generate new private key.
   * Optional; native push send is no-op when unset.
   */
  fcmServiceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON ?? '',

  /** Shared secret for POST /jobs/tag-propagation (Bearer or x-job-secret). */
  tagPropagationSecret: process.env.TAG_PROPAGATION_SECRET ?? '',

  /**
   * Optional in-process interval (ms) to run tag propagation.
   * Off when unset or below 10000. Prefer external cron in multi-instance deploys.
   */
  tagPropagationIntervalMs: Number(process.env.TAG_PROPAGATION_INTERVAL_MS ?? 0) || 0,
} as const
