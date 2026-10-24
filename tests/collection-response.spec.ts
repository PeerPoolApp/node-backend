/** HTTP delta and cursor protocol, independent of a database. */
import { expect, it } from 'vitest'
import Fastify from 'fastify'
import {
  collectionResponse,
  encodePageCursor,
  decodePageCursor,
  rowRevision,
} from '../lib/collectionResponse.js'
it('returns only changed rows, authoritative order, and a private 304 for an unchanged page', async () => {
  const app = Fastify()
  let rows = [
    { id: 'a', name: 'Alex', avatarUrl: 'signed-1', avatarUpdatedAt: 'v1' },
    { id: 'b', name: 'Bea', avatarUrl: null, avatarUpdatedAt: null },
  ]
  app.get('/people', async (req, reply) => collectionResponse(req, reply, 'users', rows, null))
  const initial = await app.inject('/people')
  const data = initial.json()
  expect(initial.headers['cache-control']).toBe('private, no-store')
  rows = [{ ...rows[0]!, avatarUrl: 'signed-2' }, rows[1]!]
  expect(
    (
      await app.inject({
        url: '/people',
        headers: { 'if-none-match': String(initial.headers.etag) },
      })
    ).statusCode,
  ).toBe(304)
  rows = [{ ...rows[1]!, name: 'Changed' }]
  const changed = await app.inject({
    url: '/people',
    headers: { 'x-peerpool-revisions': JSON.stringify(data.revisions) },
  })
  expect(changed.json().users.map((r: { name: string }) => r.name)).toEqual(['Changed'])
  expect(changed.json().order).toEqual(['b'])
  await app.close()
})
it('tuple cursors round-trip tied timestamps and reject filter injection', () => {
  const row = {
    created_at: '2026-10-24T10:00:00.000Z',
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  }
  expect(decodePageCursor(encodePageCursor(row))).toEqual({
    date: row.created_at,
    id: row.id,
  })
  expect(decodePageCursor(row.created_at)).toEqual({
    date: row.created_at,
    id: null,
  })
  expect(() => decodePageCursor('bad),id.gt.0')).toThrow('Invalid cursor')
  expect(rowRevision({ ...row, avatarUpdatedAt: 'new' })).not.toBe(rowRevision(row))
})
