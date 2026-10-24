/** Private collection transport: conditional pages and per-row deltas, never shared HTTP caches. */
import { createHash } from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'

/** Signed URL rotation is not a content change; version fields identify image changes. */
export function rowRevision(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (key, item) =>
        /(?:avatar_?url|cover_?url|download_?url)$/i.test(key) ? undefined : item,
      ),
    )
    .digest('hex')
    .slice(0, 20)
}

/** Clients without revision headers still receive an ordinary full page. */
export function collectionResponse<T extends { id: string }>(
  request: FastifyRequest,
  reply: FastifyReply,
  key: string,
  rows: T[],
  nextCursor: string | null,
) {
  const revisions = Object.fromEntries(rows.map((row) => [row.id, rowRevision(row)]))
  const order = rows.map((row) => row.id)
  const etag = `"${rowRevision({ revisions, order, nextCursor })}"`
  reply.header('Cache-Control', 'private, no-store').header('ETag', etag)
  if (request.headers['if-none-match'] === etag) return reply.code(304).send()
  let known: Record<string, string> = {}
  try {
    const header = request.headers['x-peerpool-revisions']
    if (typeof header === 'string' && header.length <= 16000) known = JSON.parse(header) ?? {}
  } catch {
    /* invalid hints simply receive a full page */
  }
  return {
    [key]: rows.filter((row) => known[row.id] !== revisions[row.id]),
    order,
    revisions,
    nextCursor,
  }
}

/** Stable tuple cursor: rows sharing timestamps must never disappear between pages. */
export function encodePageCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id])).toString('base64url')
}
export function decodePageCursor(raw?: string | null): { date: string; id: string | null } | null {
  if (!raw) return null
  try {
    const [date, id] = JSON.parse(Buffer.from(raw, 'base64url').toString())
    if (
      typeof date === 'string' &&
      Number.isFinite(Date.parse(date)) &&
      /^\d{4}-\d{2}-\d{2}T[\d:.+Z-]+$/.test(date) &&
      typeof id === 'string' &&
      /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)
    )
      return { date, id }
  } catch {
    /* legacy timestamp cursor */
  }
  if (/^\d{4}-\d{2}-\d{2}T[\d:.+Z-]+$/.test(raw) && Number.isFinite(Date.parse(raw)))
    return { date: raw, id: null }
  throw new Error('Invalid cursor')
}
