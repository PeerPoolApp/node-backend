// @vitest-environment node
/** Fastify boundary regression: a saved send cannot return while its dispatch is detached. */
import { beforeEach, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  member: vi.fn().mockResolvedValue(true),
  rpc: vi.fn(),
  from: vi.fn(),
  allowed: vi.fn().mockReturnValue(true),
}))
vi.mock('../config.ts', () => ({
  config: {
    supabaseUrl: 'https://test.supabase.co',
    supabasePublishableKey: 'test',
    supabaseSecretKey: 'test',
  },
}))
vi.mock('../services/supabase.ts', () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
  supabaseAuth: {},
}))
vi.mock('../middleware/auth.ts', () => ({
  requireAuth: async (request: { userId: string }) => {
    request.userId = 'sender'
  },
}))
vi.mock('../services/notifications/dispatcher.ts', () => ({ notifyUsers: mocks.notify }))
vi.mock('../services/communityChannels.ts', () => ({
  assertCanWriteCommunityChannel: async () => true,
  resolveCommunityIdForConversation: async () => null,
}))
vi.mock('../services/events.ts', () => ({
  eventChatWriteBlocked: async () => false,
  syncStaleEventChatArchives: vi.fn(),
}))
vi.mock('../services/messaging.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertMember: mocks.member,
}))
vi.mock('../services/moderation.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  messageAllowedForViewer: mocks.allowed,
  messageHideSets: async () => ({ personal: new Set(), global: new Set() }),
}))
import { messageRoutes } from '../routes/messages'
const saved = {
  id: 'm1',
  conversation_id: 'chat',
  sender_id: 'sender',
  body: 'first message',
  created_at: '2026-10-23T10:00:00Z',
  client_id: 'client',
  message_attachments: [],
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.rpc.mockResolvedValue({ data: [{ message: saved, inserted: true }], error: null })
  mocks.member.mockResolvedValue(true)
  mocks.allowed.mockReturnValue(true)
  mocks.from.mockImplementation((table: string) => {
    let operation = 'read',
      clientLookup = false
    const query: any = {}
    for (const method of ['select', 'eq', 'neq', 'insert', 'update', 'delete', 'in', 'limit'])
      query[method] = vi.fn((...args: any[]) => {
        if (method === 'insert' || method === 'update') operation = method
        if (method === 'eq' && args[0] === 'client_id') clientLookup = true
        return query
      })
    const result = () => ({
      error: null,
      data:
        table === 'messages'
          ? clientLookup
            ? null
            : saved
          : table === 'profiles'
            ? { full_name: 'Sender' }
            : [{ user_id: 'recipient' }],
    })
    query.single = async () => result()
    query.maybeSingle = async () => result()
    query.then = (resolve: Function) => Promise.resolve(result()).then(resolve as any)
    return query
  })
})
it('waits for dispatch of M1 without requiring an M2 request', async () => {
  const app = Fastify()
  await app.register(messageRoutes)
  let release!: () => void
  mocks.notify.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  let completed = false
  const request = app
    .inject({
      method: 'POST',
      url: '/conversations/chat/messages',
      payload: { body: 'first message', clientId: 'client' },
    })
    .then((res) => {
      completed = true
      return res
    })
  await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledOnce())
  expect(completed).toBe(false)
  expect(mocks.notify.mock.calls[0]![1]).toMatchObject({ messageId: 'm1', body: 'first message' })
  release()
  expect((await request).statusCode).toBe(201)
  await app.close()
})
it('canonical hydration enforces conversation membership and moderation', async () => {
  const app = Fastify()
  await app.register(messageRoutes)
  mocks.member.mockResolvedValue(false)
  expect((await app.inject('/conversations/chat/messages/m1')).statusCode).toBe(403)
  mocks.member.mockResolvedValue(true)
  mocks.allowed.mockReturnValue(false)
  expect((await app.inject('/conversations/chat/messages/m1')).statusCode).toBe(404)
  await app.close()
})
it('read API requires a concrete message and propagates invalid cursor errors', async () => {
  const app = Fastify()
  await app.register(messageRoutes)
  expect(
    (await app.inject({ method: 'POST', url: '/conversations/chat/read', payload: {} })).statusCode,
  ).toBe(400)
  mocks.rpc.mockResolvedValue({ error: { code: '22023' }, data: null })
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/conversations/chat/read',
        payload: { messageId: 'wrong-chat' },
      })
    ).statusCode,
  ).toBe(400)
  await app.close()
})
