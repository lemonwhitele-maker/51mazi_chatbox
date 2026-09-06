import fs from 'node:fs'
import crypto from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import { isLibraryMetadataName } from './libraryApiConfigStore.js'

const CHAPTER_ROOT = '正文'
const QUICK_NOTES_FILE = join('.51mazi', 'notes', 'quick-notes.md')

function sha256(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`
}

function isInside(rootPath, targetPath) {
  const root = resolve(rootPath)
  const target = resolve(targetPath)
  const comparableRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const comparableTarget = process.platform === 'win32' ? target.toLowerCase() : target
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : `${comparableRoot}${sep}`
  return comparableTarget === comparableRoot || comparableTarget.startsWith(prefix)
}

function toPosixPath(value) {
  return String(value || '')
    .split('\\')
    .join('/')
}

export function safeSegment(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/]/.test(normalized)) {
    throw new Error(`${label} 无效`)
  }
  return normalized
}

function normalizeLineEndings(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

function lineEndingOf(value) {
  const text = String(value ?? '')
  const crlf = (text.match(/\r\n/g) || []).length
  const withoutCrlf = text.replace(/\r\n/g, '')
  const lf = (withoutCrlf.match(/\n/g) || []).length
  const cr = (withoutCrlf.match(/\r/g) || []).length
  if (crlf && (lf || cr)) return 'mixed'
  if (crlf) return 'CRLF'
  if (lf) return 'LF'
  if (cr) return 'CR'
  return 'none'
}

function decodeUtf8(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    return decoder.decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    throw new Error('正式文件不是有效的 UTF-8 文本')
  }
}

function readTextFile(filePath, sourceType, targetId, authorityStatus, metadata = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`${sourceType} 正式文件不存在`)
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`${sourceType} 正式路径不是文件`)
  const raw = fs.readFileSync(filePath)
  const rawText = decodeUtf8(raw)
  const content = normalizeLineEndings(rawText)
  return {
    sourceType,
    targetId: String(targetId),
    content,
    rawHash: sha256(raw),
    contentHash: sha256(raw),
    savedAt: stat.mtime.toISOString(),
    authorityStatus,
    metadata: {
      ...metadata,
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
      lineEnding: lineEndingOf(rawText),
      hasBom: raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
    }
  }
}

function walkFiles(rootPath, predicate, out = []) {
  if (!fs.existsSync(rootPath)) return out
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const filePath = join(rootPath, entry.name)
    if (entry.isDirectory()) walkFiles(filePath, predicate, out)
    else if (entry.isFile() && predicate(filePath, entry.name)) out.push(filePath)
  }
  return out
}

export function encodeReferencePart(value) {
  return encodeURIComponent(String(value || ''))
}

export function decodeReferencePart(value) {
  try {
    return decodeURIComponent(String(value || ''))
  } catch {
    throw new Error('来源引用编码无效')
  }
}

export function makeSourceReference({ sourceType, targetId, location = '', contentHash = '' }) {
  const prefix = `${sourceType}:${encodeReferencePart(targetId)}`
  const suffix = location ? `#${location}` : ''
  const hash = contentHash ? `@${contentHash}` : ''
  return `${prefix}${suffix}${hash}`
}

export function parseSourceReference(reference) {
  const raw = String(reference || '').trim()
  const match =
    /^(chapter|character|setting|outline|note):([^#@]+)(?:#([^@]*))?(?:@(sha256:[a-f0-9]+))?$/i.exec(
      raw
    )
  if (!match) throw new Error('来源引用格式无效')
  return {
    sourceType: match[1].toLowerCase(),
    targetId: decodeReferencePart(match[2]),
    location: match[3] || '',
    contentHash: match[4] || ''
  }
}

export class BookSavedSnapshotService {
  constructor({ booksDirProvider } = {}) {
    this.booksDirProvider = booksDirProvider
  }

  getBooksDir() {
    const configured =
      typeof this.booksDirProvider === 'function' ? this.booksDirProvider() : this.booksDirProvider
    if (!configured) throw new Error('请先在 51码字中设置书籍目录')
    const root = resolve(String(configured))
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('书籍目录无效')
    return fs.realpathSync(root)
  }

  resolveBookPath(bookName) {
    const name = safeSegment(bookName, '书籍名称')
    if (isLibraryMetadataName(name)) throw new Error('该名称保留给书库配置，不能作为书籍使用')
    const root = this.getBooksDir()
    const bookPath = resolve(root, name)
    const directStat = fs.existsSync(bookPath) ? fs.lstatSync(bookPath) : null
    if (
      !isInside(root, bookPath) ||
      !directStat ||
      directStat.isSymbolicLink() ||
      !directStat.isDirectory()
    ) {
      throw new Error('书籍目录不存在')
    }
    const realBookPath = fs.realpathSync(bookPath)
    if (!isInside(root, realBookPath) || realBookPath === root)
      throw new Error('书籍路径超出已配置的书架目录')
    return realBookPath
  }

  resolveInside(rootPath, relativePath, label) {
    const normalized = String(relativePath || '').replaceAll('\\', '/')
    if (
      !normalized ||
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      throw new Error(`${label} 路径无效`)
    }
    const target = resolve(rootPath, normalized)
    if (!isInside(rootPath, target)) throw new Error(`${label} 路径越出书籍范围`)
    const realTarget = fs.existsSync(target) ? fs.realpathSync(target) : target
    if (!isInside(rootPath, realTarget)) throw new Error(`${label} 路径越出书籍范围`)
    return realTarget
  }

  readChapterSnapshot(bookName, chapterIdOrPath) {
    const bookPath = this.resolveBookPath(bookName)
    const chapterRoot = join(bookPath, CHAPTER_ROOT)
    const chapterId = toPosixPath(String(chapterIdOrPath || '').trim())
    const filePath = this.resolveInside(chapterRoot, chapterId, '章节')
    if (!filePath.toLowerCase().endsWith('.txt')) throw new Error('章节文件类型无效')
    return readTextFile(filePath, 'chapter', chapterId, 'authoritative_saved', {
      relativePath: chapterId,
      volumeName: chapterId.split('/').slice(-2, -1)[0] || '',
      chapterName:
        chapterId
          .split('/')
          .pop()
          ?.replace(/\.txt$/i, '') || '',
      filePath
    })
  }

  listChapterDescriptors(bookName) {
    const bookPath = this.resolveBookPath(bookName)
    const chapterRoot = join(bookPath, CHAPTER_ROOT)
    return walkFiles(chapterRoot, (filePath, name) => /\.txt$/i.test(name)).map((filePath) => {
      const relativePath = toPosixPath(relative(chapterRoot, filePath))
      const snapshot = readTextFile(filePath, 'chapter', relativePath, 'authoritative_saved', {
        relativePath,
        filePath
      })
      return {
        sourceType: 'chapter',
        targetId: relativePath,
        reference: makeSourceReference({
          sourceType: 'chapter',
          targetId: relativePath,
          contentHash: snapshot.rawHash
        }),
        title:
          relativePath
            .split('/')
            .pop()
            ?.replace(/\.txt$/i, '') || relativePath,
        volumeName: relativePath.split('/').slice(-2, -1)[0] || '',
        chapterName:
          relativePath
            .split('/')
            .pop()
            ?.replace(/\.txt$/i, '') || '',
        contentHash: snapshot.rawHash,
        savedAt: snapshot.savedAt,
        size: snapshot.metadata.fileSize,
        lineEnding: snapshot.metadata.lineEnding,
        lineCount: snapshot.content ? snapshot.content.split('\n').length : 0
      }
    })
  }

  readQuickNotesSnapshot(bookName) {
    const bookPath = this.resolveBookPath(bookName)
    const filePath = join(bookPath, QUICK_NOTES_FILE)
    return readTextFile(filePath, 'note', 'quick-notes', 'private_note', {
      relativePath: QUICK_NOTES_FILE,
      filePath
    })
  }

}

export default BookSavedSnapshotService
