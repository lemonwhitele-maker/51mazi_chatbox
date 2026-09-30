import { HarnessError } from '../harnessErrors.js'

const TYPES = { characters: 'character', settings: 'setting', outlines: 'outline' }

function invalid(message) {
  throw new HarnessError('PATH_OUTSIDE_BOOK', message)
}

// Normalize only application-owned names. Document and volume names retain
// their spelling; existing names are resolved against the bound book on disk.
export function normalizeVirtualPath(value) {
  const raw = String(value ?? '')
  if (!raw || raw.length > 1024 || raw !== raw.trim() || raw.includes('\\') ||
      [...raw].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    invalid('虚拟资源路径无效')
  if (/^(?:[a-z]:|\/|https?:)/i.test(raw)) invalid('只能使用当前书籍的虚拟资源路径')
  const segments = (raw.endsWith('/') ? raw.slice(0, -1) : raw).split('/')
  if (segments.some((part) => !part || part === '.' || part === '..' || part.includes(':')))
    invalid('虚拟资源路径包含无效路径段')
  const root = segments[0].toLowerCase()
  if (['knowledge', '正文'].includes(root) || raw === '.51mazi/notes/quick-notes.md')
    throw new HarnessError('VIRTUAL_PATH_REQUIRED', '请使用 book/ 开头的虚拟路径，而非磁盘相对路径', {
      retryable: true, retryStrategy: 'repair_arguments',
      nextAction: '先 read book/，复制结果中的 path；当前文档可使用工作区 toolPath'
    })
  if (!['book', 'help', 'view'].includes(root)) invalid('虚拟资源不属于当前书籍')
  segments[0] = root
  if (segments[1]) segments[1] = segments[1].toLowerCase()
  if (root === 'book' && segments[1] === 'knowledge' && segments[2])
    segments[2] = segments[2].toLowerCase()
  if (root === 'book' && segments[1] === 'notes' && segments[2])
    segments[2] = segments[2].toLowerCase()
  const path = segments.join('/')
  const directory = /^(?:book(?:\/knowledge(?:\/(?:characters|settings|outlines))?|\/chapters(?:\/[^/]+)?|\/notes|\/conversations)?|help|view(?:\/(?:backlinks|outline-context))?)$/.test(path)
  return path + (directory ? '/' : '')
}

// One mapping supplies both reads and proposal targets.
export function describeDocumentPath(value) {
  const path = normalizeVirtualPath(value)
  const knowledge = /^book\/knowledge\/(characters|settings|outlines)\/([^/]+)\.md$/i.exec(path)
  if (knowledge) return {
    path, kind: 'file', relativePath: path.slice('book/'.length),
    collection: knowledge[1], type: TYPES[knowledge[1]], documentId: knowledge[2]
  }
  const chapter = /^book\/chapters\/([^/]+)\/([^/]+\.txt)$/i.exec(path)
  if (chapter) return {
    path, kind: 'file', relativePath: `正文/${chapter[1]}/${chapter[2]}`,
    collection: 'chapters', type: 'chapter', documentId: `${chapter[1]}/${chapter[2]}`,
    volumeName: chapter[1], chapterName: chapter[2].replace(/\.txt$/i, '')
  }
  if (path === 'book/notes/quick-notes.md') return {
    path, kind: 'file', relativePath: '.51mazi/notes/quick-notes.md',
    collection: 'notes', type: 'note', documentId: 'quick-notes', internal: true
  }
  return null
}
