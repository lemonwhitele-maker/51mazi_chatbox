import fs from 'node:fs'
import crypto from 'node:crypto'
import { join } from 'node:path'

export const QUICK_NOTES_RELATIVE_PATH = join('.51mazi', 'notes', 'quick-notes.md')
const MAX_QUICK_NOTES_LENGTH = 500_000

function bookPathOf(snapshotService, bookName) {
  return snapshotService.resolveBookPath(String(bookName || '').trim())
}

export function readHarnessQuickNotes(snapshotService, bookName) {
  const bookPath = bookPathOf(snapshotService, bookName)
  const notesPath = join(bookPath, QUICK_NOTES_RELATIVE_PATH)
  const buffer = fs.existsSync(notesPath) ? fs.readFileSync(notesPath) : Buffer.from('', 'utf8')
  return {
    content: buffer.toString('utf8'),
    contentHash: `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`,
    relativePath: QUICK_NOTES_RELATIVE_PATH
  }
}

export function writeHarnessQuickNotes(snapshotService, bookName, content) {
  const bookPath = bookPathOf(snapshotService, bookName)
  const normalizedContent = String(content || '')
  if (normalizedContent.length > MAX_QUICK_NOTES_LENGTH) throw new Error('速记内容过长，请控制在 50 万字符以内')
  const notesPath = join(bookPath, QUICK_NOTES_RELATIVE_PATH)
  fs.mkdirSync(join(bookPath, '.51mazi', 'notes'), { recursive: true })
  fs.writeFileSync(notesPath, normalizedContent, 'utf8')
  const buffer = Buffer.from(normalizedContent, 'utf8')
  return {
    relativePath: QUICK_NOTES_RELATIVE_PATH,
    contentHash: `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`
  }
}
