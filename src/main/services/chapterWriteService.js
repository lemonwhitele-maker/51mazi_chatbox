import fs from 'node:fs'
import { logSaveDiagnostic, saveErrorDetails } from './saveDiagnostics.js'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { safeSegment } from './bookSavedSnapshotService.js'

const RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'])

export class ChapterWriteError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ChapterWriteError'
    this.code = code
    this.retryable = details.retryable === true
    Object.assign(this, details)
  }
}

export function serializeChapterText(value) {
  return String(value ?? '')
}

function chapterBytesAndText(value) {
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(serializeChapterText(value), 'utf8')
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new ChapterWriteError('CHAPTER_ENCODING_INVALID', '正文必须是有效的 UTF-8 纯文本')
  }
  return { bytes, text }
}

export function chapterTargetId(volumeName, chapterName) {
  const volume = safeSegment(volumeName, '卷名')
  const rawChapter = String(chapterName ?? '')
  safeSegment(rawChapter, '章节名')

  // 旧版本曾创建过“第N章 .txt”这类扩展名前带空格的文件。
  // 完成同样的路径安全校验后保留列表返回的原始名称，使旧文件仍可读写；
  // 新建和重命名入口会自行 trim，因而不会继续产生非规范文件名。
  return `${volume}/${rawChapter}.txt`
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function closeQuietly(handle) {
  if (!handle) return
  try {
    await handle.close()
  } catch {
    // The original write/rename error is more useful to the caller.
  }
}

async function unlinkQuietly(fileSystem, filePath) {
  try {
    await fileSystem.unlink(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export async function writeFileAtomically(
  filePath,
  content,
  {
    fileSystem = fs.promises,
    renameAttempts = 4,
    retryDelayMs = 12,
    tempId = randomUUID
  } = {}
) {
  const targetPath = String(filePath || '')
  if (!targetPath) throw new ChapterWriteError('CHAPTER_PATH_INVALID', '章节路径无效')
  const buffer = Buffer.isBuffer(content)
    ? content
    : Buffer.from(serializeChapterText(content), 'utf8')
  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${tempId()}.tmp`)
  let handle = null

  try {
    handle = await fileSystem.open(tempPath, 'wx', 0o600)
    await handle.writeFile(buffer)
    await handle.sync()
    await handle.close()
    handle = null

    const attempts = Math.max(1, Number(renameAttempts) || 1)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await fileSystem.rename(tempPath, targetPath)
        return { bytesWritten: buffer.byteLength, tempPath }
      } catch (error) {
        const canRetry = RETRYABLE_RENAME_CODES.has(error?.code) && attempt + 1 < attempts
        if (!canRetry) throw error
        await wait(retryDelayMs * (attempt + 1))
      }
    }
    throw new ChapterWriteError('CHAPTER_ATOMIC_REPLACE_FAILED', '章节原子替换失败')
  } catch (error) {
    await closeQuietly(handle)
    try {
      await unlinkQuietly(fileSystem, tempPath)
    } catch {
      // Cleanup failure must not hide the actual save failure.
    }
    throw error
  }
}

export class ChapterWriteService {
  constructor({ snapshotService, onCommitted = null, atomicWriter = writeFileAtomically } = {}) {
    if (!snapshotService) throw new TypeError('snapshotService is required')
    this.snapshotService = snapshotService
    this.onCommitted = typeof onCommitted === 'function' ? onCommitted : null
    this.atomicWriter = atomicWriter
    this.sandboxService = null
    this.writeQueues = new Map()
  }

  async enqueue(targetId, work) {
    const previous = this.writeQueues.get(targetId) || Promise.resolve()
    const current = previous.catch(() => {}).then(work)
    this.writeQueues.set(targetId, current)
    try {
      return await current
    } finally {
      if (this.writeQueues.get(targetId) === current) this.writeQueues.delete(targetId)
    }
  }

  async writeChapterWithExpectedHash({
    bookName,
    volumeName,
    chapterName,
    expectedHash = '',
    content
  } = {}) {
    const targetId = chapterTargetId(volumeName, chapterName)
    const bookKey = safeSegment(bookName, '书籍名称')

    return this.enqueue(`${bookKey}:${targetId}`, async () => {
      const scope = this.sandboxService?.bindBook(bookKey, { senderId: 'chapter-write', frameId: 'internal' })
      if (scope) this.sandboxService.resolveReadable(scope, `正文/${targetId}`)
      const before = this.snapshotService.readChapterSnapshot(bookKey, targetId)
      const previousHash = before.rawHash
      const normalizedExpectedHash = String(expectedHash || '').trim()

      logSaveDiagnostic('chapter.version-check', { bookName: bookKey, targetId, expectedHash: normalizedExpectedHash, currentHash: previousHash })
      if (normalizedExpectedHash && normalizedExpectedHash !== previousHash) {
        throw new ChapterWriteError(
          'CHAPTER_VERSION_CONFLICT',
          '正文已发生变化，请重新读取后再保存',
          { retryable: false, expectedHash: normalizedExpectedHash, currentHash: previousHash }
        )
      }

      const next = chapterBytesAndText(content)
      const nextContent = next.text
      const previousBytes = await fs.promises.readFile(before.metadata.filePath)

      let stage = 'atomic-write'
      try {
        if (scope) this.sandboxService.assertTrustedAbsolute(scope, before.metadata.filePath)
        const writeResult = await this.atomicWriter(before.metadata.filePath, next.bytes)
        stage = 'read-after-write'
        const after = this.snapshotService.readChapterSnapshot(bookKey, targetId)

        stage = 'post-write-stats-and-metadata'
        if (this.onCommitted) {
          try {
            await this.onCommitted({
              bookName: bookKey,
              volumeName: safeSegment(volumeName, '卷名'),
              chapterName: safeSegment(chapterName, '章节名'),
              previousContent: before.content,
              content: nextContent,
              previousHash,
              contentHash: after.rawHash
            })
          } catch (error) {
            logSaveDiagnostic('chapter.post-write-failed', { bookName: bookKey, targetId, error: saveErrorDetails(error) })
            stage = 'rollback'
            await this.atomicWriter(before.metadata.filePath, previousBytes)
            throw new ChapterWriteError(
              'CHAPTER_POST_WRITE_FAILED',
              '章节保存后的统计或元数据更新失败，正文已恢复',
              { cause: error }
            )
          }
        }

        logSaveDiagnostic('chapter.committed', { bookName: bookKey, targetId, previousHash, contentHash: after.rawHash })
        return {
          previousHash,
          contentHash: after.rawHash,
          savedAt: after.savedAt,
          bytesWritten: writeResult?.bytesWritten ?? Buffer.byteLength(nextContent, 'utf8')
        }
      } catch (error) {
        logSaveDiagnostic('chapter.failed', { bookName: bookKey, targetId, stage, error: saveErrorDetails(error) })
        if (error instanceof ChapterWriteError) throw error
        throw new ChapterWriteError('CHAPTER_WRITE_FAILED', '章节保存失败，原正文保持不变', {
          cause: error,
          retryable: true
        })
      }
    })
  }

  async createChapter({ bookName, volumeName, chapterName, content } = {}) {
    const targetId = chapterTargetId(volumeName, chapterName)
    const bookKey = safeSegment(bookName, '书籍名称')
    return this.enqueue(`${bookKey}:${targetId}`, async () => {
      const bookPath = this.snapshotService.resolveBookPath(bookKey)
      const filePath = this.snapshotService.resolveInside(bookPath, join('正文', targetId), '正文')
      const scope = this.sandboxService?.bindBook(bookKey, { senderId: 'chapter-create', frameId: 'internal' })
      if (scope) this.sandboxService.prepareCandidateTarget(scope, `正文/${targetId}`)
      if (fs.existsSync(filePath)) {
        throw new ChapterWriteError('CHAPTER_ALREADY_EXISTS', '章节已存在', { retryable: false })
      }
      const next = chapterBytesAndText(content)
      const nextContent = next.text
      await fs.promises.mkdir(dirname(filePath), { recursive: true })
      try {
        if (scope) this.sandboxService.prepareCandidateTarget(scope, `正文/${targetId}`)
        const writeResult = await this.atomicWriter(filePath, next.bytes)
        const after = this.snapshotService.readChapterSnapshot(bookKey, targetId)
        if (this.onCommitted) {
          try {
            await this.onCommitted({
              bookName: bookKey,
              volumeName: safeSegment(volumeName, '卷名'),
              chapterName: safeSegment(chapterName, '章节名'),
              previousContent: '',
              content: nextContent,
              previousHash: null,
              contentHash: after.rawHash
            })
          } catch (error) {
            await fs.promises.unlink(filePath).catch(() => {})
            throw new ChapterWriteError(
              'CHAPTER_POST_WRITE_FAILED',
              '章节创建后的统计或元数据更新失败，新文件已移除',
              { cause: error }
            )
          }
        }
        return {
          created: true,
          contentHash: after.rawHash,
          savedAt: after.savedAt,
          bytesWritten: writeResult?.bytesWritten ?? Buffer.byteLength(nextContent, 'utf8')
        }
      } catch (error) {
        if (error instanceof ChapterWriteError) throw error
        throw new ChapterWriteError('CHAPTER_CREATE_FAILED', '章节创建失败，未留下不完整文件', {
          cause: error,
          retryable: true
        })
      }
    })
  }

  async deleteChapterWithExpectedHash({
    bookName,
    volumeName,
    chapterName,
    expectedHash = ''
  } = {}) {
    const targetId = chapterTargetId(volumeName, chapterName)
    const bookKey = safeSegment(bookName, '书籍名称')
    return this.enqueue(`${bookKey}:${targetId}`, async () => {
      const scope = this.sandboxService?.bindBook(bookKey, {
        senderId: 'chapter-delete',
        frameId: 'internal'
      })
      if (scope) this.sandboxService.resolveReadable(scope, `正文/${targetId}`)
      const before = this.snapshotService.readChapterSnapshot(bookKey, targetId)
      const previousBytes = await fs.promises.readFile(before.metadata.filePath)
      const normalizedExpectedHash = String(expectedHash || '').trim()
      if (normalizedExpectedHash && normalizedExpectedHash !== before.rawHash) {
        throw new ChapterWriteError('CHAPTER_VERSION_CONFLICT', '正文已发生变化，无法安全删除', {
          retryable: false,
          expectedHash: normalizedExpectedHash,
          currentHash: before.rawHash
        })
      }
      try {
        if (scope) this.sandboxService.assertTrustedAbsolute(scope, before.metadata.filePath)
        await fs.promises.unlink(before.metadata.filePath)
        if (this.onCommitted) {
          try {
            await this.onCommitted({
              bookName: bookKey,
              volumeName: safeSegment(volumeName, '卷名'),
              chapterName: safeSegment(chapterName, '章节名'),
              previousContent: before.content,
              content: '',
              previousHash: before.rawHash,
              contentHash: null
            })
          } catch (error) {
            await this.atomicWriter(before.metadata.filePath, previousBytes)
            throw new ChapterWriteError(
              'CHAPTER_POST_WRITE_FAILED',
              '章节删除后的统计或元数据更新失败，正文已恢复',
              { cause: error }
            )
          }
        }
        return { deleted: true, previousHash: before.rawHash }
      } catch (error) {
        if (error instanceof ChapterWriteError) throw error
        throw new ChapterWriteError('CHAPTER_DELETE_FAILED', '章节删除失败，原正文保持不变', {
          cause: error,
          retryable: true
        })
      }
    })
  }

  async reconcileCommittedChapter({
    bookName,
    volumeName,
    chapterName,
    previousContent,
    content
  } = {}) {
    if (!this.onCommitted) return
    await this.onCommitted({
      bookName: safeSegment(bookName, '书籍名称'),
      volumeName: safeSegment(volumeName, '卷名'),
      chapterName: safeSegment(chapterName, '章节名'),
      previousContent: String(previousContent || ''),
      content: String(content || ''),
      recovered: true
    })
  }
}

export default ChapterWriteService
