/** Privacy regression: every exported category is scoped to the authenticated subject. */
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn() }))
vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: { from: mocks.from, auth: { admin: { getUserById: mocks.getUser } } },
}))
import { collectPersonalData } from '../services/accountExport.js'
const queries: Array<{ table: string; filters: Array<unknown[]>; selection: string }> = []
beforeEach(() => {
  queries.length = 0
  mocks.from.mockReset()
  mocks.getUser.mockResolvedValue({
    data: { user: { id: 'self', email: 'self@example.invalid' } },
    error: null,
  })
  mocks.from.mockImplementation((table: string) => {
    const record = { table, filters: [] as unknown[][], selection: '' }
    queries.push(record)
    const query: any = {}
    query.select = (fields: string) => {
      record.selection = fields
      return query
    }
    query.eq = (...args: unknown[]) => {
      record.filters.push(['eq', ...args])
      return query
    }
    query.or = (filter: string) => {
      record.filters.push(['or', filter])
      return query
    }
    query.order = () => query
    query.range = async () => ({ data: [], error: null })
    query.single = async () => ({
      data: { id: 'self', full_name: 'Self', avatar_storage_path: null },
      error: null,
    })
    return query
  })
})
it('exports only own records and never live push/invite credentials', async () => {
  const data = await collectPersonalData('self', 'self@example.invalid')
  expect(mocks.getUser).toHaveBeenCalledWith('self')
  expect(data.account.id).toBe('self')
  for (const query of queries)
    expect(
      query.filters.some(
        (filter) =>
          filter.includes('self') ||
          filter.some((value) => typeof value === 'string' && value.includes('.eq.self')),
      ),
    ).toBe(true)
  expect(queries.find((q) => q.table === 'message_attachments')!.filters).toContainEqual([
    'eq',
    'messages.sender_id',
    'self',
  ])
  for (const table of [
    'push_devices',
    'friend_invite_links',
    'event_invite_links',
    'community_invite_links',
  ])
    expect(queries.find((q) => q.table === table)!.selection).not.toMatch(/token|\*/)
})
