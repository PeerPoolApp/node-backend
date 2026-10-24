/** Readable paginated access copy with embedded original media and portable JSON. */
import PDFDocument from 'pdfkit'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { PersonalDataExport } from './accountExport.js'

/** Both tsx source and compiled dist locate the vendored OFL font without depending on cwd. */
function fontPath() {
  const source = fileURLToPath(new URL('../assets/fonts/NotoSans.ttf', import.meta.url))
  return existsSync(source)
    ? source
    : fileURLToPath(new URL('../../assets/fonts/NotoSans.ttf', import.meta.url))
}
export async function personalDataPdf(
  data: PersonalDataExport,
  files: Array<{ name: string; data: Buffer }> = [],
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    bufferPages: true,
    info: {
      Title: 'PeerPool - Personal data copy',
      Author: 'PeerPool',
      Subject: 'Personal data access copy',
    },
  })
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  doc.font(fontPath())
  const label = (key: string) =>
    key
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .replace(/^./, (s) => s.toUpperCase())
  function heading(title: string) {
    if (doc.y > 700) doc.addPage()
    doc.moveDown(0.8).fontSize(15).fillColor('#285F9D').text(title).moveDown(0.4)
  }
  function value(key: string, item: unknown) {
    const content =
      item == null ? 'Not recorded' : typeof item === 'object' ? JSON.stringify(item) : String(item)
    doc.fontSize(9).fillColor('#7B899B').text(label(key), { paragraphGap: 3 })
    doc.fontSize(10).fillColor('#27384E').text(content, { lineGap: 3, paragraphGap: 9 })
  }
  doc.fontSize(10).fillColor('#4C91DF').text('PEERPOOL / YOUR DATA')
  doc.moveDown(0.7).fontSize(28).fillColor('#1F2E43').text('Your personal data')
  doc
    .moveDown(0.5)
    .fontSize(10)
    .fillColor('#76869B')
    .text(`Generated ${data.exportedAt}\nPrivate - store this document securely.`)
  heading('About this copy')
  doc
    .fontSize(10)
    .fillColor('#42536B')
    .text(
      'This document contains the application records listed in the contents below. The same records are attached as JSON for reuse. Original media files are attached to this PDF. Open the attachments panel in a PDF reader to save them.',
      { lineGap: 4 },
    )
  heading('Contents')
  for (const [key, rows] of Object.entries(data.categories))
    doc
      .fontSize(9)
      .fillColor('#53657D')
      .text(`${label(key)} - ${rows.length} record${rows.length === 1 ? '' : 's'}`)
  heading('Processing and your rights')
  for (const [key, item] of Object.entries(data.processingInformation)) value(key, item)
  heading('Account')
  value('email', data.email)
  for (const [key, item] of Object.entries(data.account)) value(key, item)
  heading('Profile')
  for (const [key, item] of Object.entries(data.profile)) value(key, item)
  for (const [key, rows] of Object.entries(data.categories)) {
    heading(`${label(key)} (${rows.length})`)
    if (!rows.length) doc.fontSize(10).fillColor('#7B899B').text('No records in this category.')
    for (const [index, row] of rows.entries()) {
      if (doc.y > 690) doc.addPage()
      doc
        .moveDown(0.4)
        .fontSize(11)
        .fillColor('#285F9D')
        .text(`Record ${index + 1}`)
        .moveDown(0.3)
      for (const [field, item] of Object.entries(row)) value(field, item)
    }
  }
  doc.file(Buffer.from(JSON.stringify(data, null, 2)), {
    name: 'peerpool-personal-data.json',
    description: 'Structured personal data from this export',
  })
  for (const file of files)
    doc.file(file.data, {
      name: file.name,
      description: 'Your original stored media',
    })
  const pages = doc.bufferedPageRange()
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i)
    doc
      .fontSize(8)
      .fillColor('#9AA6B5')
      .text(`PeerPool | Personal data copy | ${i + 1} / ${pages.count}`, 48, 800, {
        lineBreak: false,
      })
  }
  doc.end()
  return result
}
