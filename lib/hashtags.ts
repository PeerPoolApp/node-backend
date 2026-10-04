/**
 * Event/community hashtag slug rules. Keep identical to vue-frontend/src/lib/hashtags.ts.
 */

import { TEXT_LIMITS } from './textLimits.js'

export const HASHTAG_SLUG_RE = new RegExp(`^[A-Za-z_]{1,${TEXT_LIMITS.hashtag}}$`)

/**
 * Strip optional leading `#` and validate ASCII letters/underscore.
 * @returns Canonical slug without `#`, or null if invalid.
 */
export function normalizeHashtagSlug(raw: string): string | null {
  const slug = raw.trim().replace(/^#+/, '')
  if (!HASHTAG_SLUG_RE.test(slug)) return null
  return slug
}
