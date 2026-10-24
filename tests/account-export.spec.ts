/** Export must not silently truncate large histories or return a partial success. */
import { expect, it, vi } from 'vitest'
vi.mock('../services/supabase.js', () => ({ supabaseAdmin: {} }))
import {
  readAllExportRows,
  processingInformation,
  type PersonalDataExport,
} from '../services/accountExport.js'
import { personalDataPdf } from '../services/accountExportPdf.js'
it('reads every server-capped page, including beyond the old 500/5000 limits', async () => {
  const records = Array.from({ length: 5103 }, (_, id) => ({ id: String(id) }))
  const read = vi.fn(async (from: number, to: number) => ({
    data: records.slice(from, to + 1),
    error: null,
  }))
  const rows = await readAllExportRows(read)
  expect(rows).toHaveLength(5103)
  expect(read).toHaveBeenCalledTimes(12)
  expect(rows[5102]).toEqual({ id: '5102' })
})
it('continues when the database returns fewer rows than the requested page size', async () => {
  const rows = Array.from({ length: 12 }, (_, id) => ({ id }))
  const read = vi.fn(async (from: number) => ({ data: rows.slice(from, from + 5), error: null }))
  expect(await readAllExportRows(read, 500)).toHaveLength(12)
  expect(read.mock.calls.map((call) => call[0])).toEqual([0, 5, 10, 12])
})
it('fails if a later page fails rather than returning an incomplete copy', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ data: [{ id: 'a' }, { id: 'b' }], error: null })
    .mockResolvedValueOnce({
      data: null,
      error: new Error('database unavailable'),
    })
  await expect(readAllExportRows(read, 2)).rejects.toThrow('database unavailable')
})
it('does not invent the operator disclosures needed for an access response', () => {
  vi.stubEnv('PRIVACY_CONTROLLER_NAME', '')
  vi.stubEnv('PRIVACY_CONTACT_EMAIL', '')
  expect(processingInformation().operatorDisclosureComplete).toBe(false)
  vi.unstubAllEnvs()
})
it('generates a PDF with a portable JSON attachment and media attachment', async () => {
  const data = {
    schemaVersion: 2,
    exportedAt: '2026-10-24T12:00:00Z',
    email: 'sample@example.invalid',
    account: { id: 'sample' },
    profile: { full_name: 'Felix Wöß' },
    processingInformation: processingInformation(),
    categories: { messagesSent: [{ body: 'A long message '.repeat(100) }] },
  } as unknown as PersonalDataExport
  const pdf = await personalDataPdf(data, [
    { name: 'sample.txt', data: Buffer.from('Sample attachment') },
  ])
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  expect(pdf.toString('latin1')).toContain('peerpool-personal-data.json')
  expect(pdf.toString('latin1')).toContain('sample.txt')
})
