/** Authorized representation validators include derived changes and send only changed entities. */
import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { installResourceResponses } from '../lib/resourceResponse.js'
it('supports private 304 and authoritative row deltas while leaving legacy responses intact', async () => {
  const app = Fastify(); installResourceResponses(app)
  let rows = [{ id: 'a', unreadCount: 1, avatarUrl: 'signed1' }, { id: 'b', unreadCount: 2, avatarUrl: '' }]
  app.get('/conversations', async () => ({ conversations: rows, nextCursor: null }))
  expect((await app.inject('/conversations')).json().conversations).toHaveLength(2)
  const first = await app.inject({ url: '/conversations', headers: { 'x-peerpool-resource':'1' } })
  rows[0]!.avatarUrl = 'signed2'
  const same = await app.inject({ url: '/conversations', headers: { 'x-peerpool-resource':'1', 'if-none-match': String(first.headers.etag) } })
  expect(same.statusCode).toBe(304)
  rows = [{ ...rows[0]!, unreadCount: 3 }]
  const changed = await app.inject({ url: '/conversations', headers: { 'x-peerpool-resource':'1', 'x-peerpool-known': JSON.stringify(first.json().revisions) } })
  expect(changed.json().rows).toHaveLength(1)
  expect(changed.json().order).toEqual(['a'])
  expect(changed.headers['cache-control']).toBe('private, no-store')
  await app.close()
})
it('does not transform forbidden or non-GET responses', async () => {
  const app = Fastify(); installResourceResponses(app)
  app.get('/communities/x', async (_, reply) => reply.code(403).send({ error: 'Forbidden' }))
  app.post('/conversations', async () => ({ id:'new' }))
  expect((await app.inject({ url:'/communities/x', headers: { 'x-peerpool-resource':'1', 'if-none-match':'anything' } })).statusCode).toBe(403)
  expect((await app.inject({ method:'POST', url:'/conversations', headers: { 'x-peerpool-resource':'1' } })).json()).toEqual({ id:'new' })
  await app.close()
})
