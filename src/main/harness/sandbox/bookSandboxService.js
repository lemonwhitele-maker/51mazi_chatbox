import fs from 'node:fs'
import crypto from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { HarnessError } from '../harnessErrors.js'
import { isLibraryMetadataName } from '../../services/libraryApiConfigStore.js'

const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const INTERNAL_ROOTS = new Set(['.51mazi'])

function comparable(value) {
  const path = resolve(value)
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function isPathInside(rootPath, targetPath, { allowRoot = true } = {}) {
  const root = comparable(rootPath)
  const target = comparable(targetPath)
  if (target === root) return allowRoot
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function fail(code, message) {
  throw new HarnessError(code, message, { retryable: false })
}

function identityFor(path, stat = fs.statSync(path)) {
  return [
    comparable(fs.realpathSync(path)),
    String(stat.dev),
    String(stat.ino),
    String(stat.birthtimeMs)
  ].join('|')
}

function validateSegment(segment, label) {
  if (!segment || segment === '.' || segment === '..')
    fail('PATH_OUTSIDE_BOOK', `${label} 包含无效路径段`)
  if (segment.endsWith('.') || segment.endsWith(' '))
    fail('PATH_OUTSIDE_BOOK', `${label} 不能包含尾随点或空格`)
  if (RESERVED_WINDOWS_NAMES.test(segment))
    fail('PATH_OUTSIDE_BOOK', `${label} 包含 Windows 保留名称`)
  if (segment.includes('\u0000') || segment.includes(':'))
    fail('PATH_OUTSIDE_BOOK', `${label} 包含无效字符`)
}

export function validateRelativeBookPath(value, label = '资源') {
  const raw = String(value ?? '')
  if (!raw || raw !== raw.trim()) fail('PATH_OUTSIDE_BOOK', `${label} 路径无效`)
  if (raw.includes('\\') || raw.includes('\u0000') || raw.startsWith('/') || isAbsolute(raw)) {
    fail('PATH_OUTSIDE_BOOK', `${label} 必须是使用 / 分隔的书内相对路径`)
  }
  if (/^(?:[a-z]:|\\\\|\/\/|\\\?\\|\\\.\\)/i.test(raw))
    fail('PATH_OUTSIDE_BOOK', `${label} 不能使用磁盘、UNC 或设备路径`)
  const segments = raw.split('/')
  for (const segment of segments) validateSegment(segment, label)
  return segments.join('/')
}

function assertPlainAncestor(path, { fileAllowed = false } = {}) {
  const stat = fs.lstatSync(path)
  if (stat.isSymbolicLink()) fail('PATH_OUTSIDE_BOOK', '路径包含符号链接或 junction')
  if (!fileAllowed && !stat.isDirectory()) fail('PATH_OUTSIDE_BOOK', '路径祖先不是目录')
  if (fileAllowed && !stat.isFile()) fail('PATH_OUTSIDE_BOOK', '目标不是普通文件')
  if (fileAllowed && Number(stat.nlink) > 1)
    fail('PATH_OUTSIDE_BOOK', '出于单书隔离要求，拒绝硬链接文件')
  return stat
}

export class BookSandboxService {
  constructor({ booksDirProvider, policyVersion = 1 } = {}) {
    this.booksDirProvider = booksDirProvider
    this.policyVersion = policyVersion
  }

  getLibraryRoot() {
    const configured =
      typeof this.booksDirProvider === 'function' ? this.booksDirProvider() : this.booksDirProvider
    if (!configured) fail('BOOK_SCOPE_MISMATCH', '请先设置书籍目录')
    const candidate = resolve(String(configured))
    if (!fs.existsSync(candidate)) fail('BOOK_SCOPE_MISMATCH', '书籍目录不存在')
    assertPlainAncestor(candidate)
    return fs.realpathSync(candidate)
  }

  bindBook(selectedBook, context = {}) {
    const bookName = validateRelativeBookPath(selectedBook, '书籍名称')
    if (bookName.includes('/') || isLibraryMetadataName(bookName))
      fail('BOOK_SCOPE_MISMATCH', '书籍名称无效')
    const libraryRootRealPath = this.getLibraryRoot()
    const requested = resolve(libraryRootRealPath, bookName)
    if (
      !isPathInside(libraryRootRealPath, requested, { allowRoot: false }) ||
      !fs.existsSync(requested)
    ) {
      fail('BOOK_SCOPE_MISMATCH', '书籍不在当前 BookList 中')
    }
    const direct = assertPlainAncestor(requested)
    const bookRootRealPath = fs.realpathSync(requested)
    if (!isPathInside(libraryRootRealPath, bookRootRealPath, { allowRoot: false }))
      fail('BOOK_SCOPE_MISMATCH', '书籍真实路径越出 BookList')
    const libraryStat = fs.statSync(libraryRootRealPath)
    return Object.freeze({
      scopeId: crypto.randomUUID(),
      libraryRootRealPath,
      libraryIdentity: identityFor(libraryRootRealPath, libraryStat),
      bookRootRealPath,
      bookIdentity: identityFor(bookRootRealPath, direct),
      bookKey: bookName,
      policyVersion: this.policyVersion,
      conversationId: context.conversationId || null,
      turnId: context.turnId || null,
      senderId: context.senderId ?? null,
      frameId: context.frameId ?? null
    })
  }

  assertScope(scope) {
    if (!scope || scope.policyVersion !== this.policyVersion)
      fail('BOOK_SCOPE_MISMATCH', '书籍 scope 已失效')
    const root = this.getLibraryRoot()
    if (
      comparable(root) !== comparable(scope.libraryRootRealPath) ||
      identityFor(root) !== scope.libraryIdentity
    ) {
      fail('BOOK_SCOPE_MISMATCH', 'BookList 已变化，请重新绑定书籍')
    }
    const requested = resolve(root, scope.bookKey)
    if (!fs.existsSync(requested)) fail('BOOK_SCOPE_MISMATCH', '绑定书籍已不存在')
    const direct = assertPlainAncestor(requested)
    const real = fs.realpathSync(requested)
    if (
      comparable(real) !== comparable(scope.bookRootRealPath) ||
      identityFor(real, direct) !== scope.bookIdentity
    ) {
      fail('BOOK_SCOPE_MISMATCH', '绑定书籍的目录身份已变化')
    }
    return scope
  }

  resolvePath(
    scope,
    relativePath,
    { mustExist = true, kind = 'file', internal = false, allowMissingAncestors = false } = {}
  ) {
    this.assertScope(scope)
    const normalized = validateRelativeBookPath(relativePath)
    const segments = normalized.split('/')
    if (!internal && INTERNAL_ROOTS.has(segments[0]))
      fail('PATH_OUTSIDE_BOOK', '模型资源不能访问内部目录')
    const target = resolve(scope.bookRootRealPath, ...segments)
    if (!isPathInside(scope.bookRootRealPath, target, { allowRoot: false }))
      fail('PATH_OUTSIDE_BOOK', '路径越出当前书籍')

    let cursor = scope.bookRootRealPath
    for (let index = 0; index < segments.length; index += 1) {
      cursor = resolve(cursor, segments[index])
      if (!fs.existsSync(cursor)) {
        if (mustExist || (!allowMissingAncestors && index < segments.length - 1))
          fail('DOCUMENT_NOT_FOUND', '目标或父目录不存在')
        if (allowMissingAncestors) continue
        break
      }
      const isFinal = index === segments.length - 1
      const stat = assertPlainAncestor(cursor, { fileAllowed: isFinal && kind === 'file' })
      if (isFinal && kind === 'directory' && !stat.isDirectory())
        fail('PATH_OUTSIDE_BOOK', '目标不是目录')
      const real = fs.realpathSync(cursor)
      if (!isPathInside(scope.bookRootRealPath, real, { allowRoot: false }))
        fail('PATH_OUTSIDE_BOOK', '路径经链接越出当前书籍')
    }
    return target
  }

  resolveReadable(scope, relativePath, options = {}) {
    return this.resolvePath(scope, relativePath, { ...options, mustExist: true })
  }

  prepareCandidateTarget(scope, relativePath, options = {}) {
    return this.resolvePath(scope, relativePath, { ...options, mustExist: false })
  }

  resolveInternal(scope, relativePath, options = {}) {
    return this.resolvePath(scope, relativePath, { ...options, internal: true })
  }

  prepareInternalPath(scope, relativePath, options = {}) {
    return this.resolvePath(scope, relativePath, {
      ...options,
      mustExist: false,
      internal: true,
      allowMissingAncestors: true
    })
  }

  assertTrustedAbsolute(scope, targetPath, { mustExist = true, kind = 'file' } = {}) {
    this.assertScope(scope)
    const absolute = resolve(String(targetPath || ''))
    if (!isPathInside(scope.bookRootRealPath, absolute, { allowRoot: false }))
      fail('PATH_OUTSIDE_BOOK', '受信后端路径越出当前书籍')
    const rel = relative(scope.bookRootRealPath, absolute).split(sep).join('/')
    return this.resolvePath(scope, rel, { mustExist, kind, internal: true })
  }

  parentOf(scope, targetPath) {
    return this.assertTrustedAbsolute(scope, dirname(targetPath), {
      mustExist: true,
      kind: 'directory'
    })
  }
}

export default BookSandboxService
