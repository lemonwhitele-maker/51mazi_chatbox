import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'

const MAX_RETAINED_CANCELLED_SESSIONS = 256
const MAX_RETAINED_SESSIONS = 512

export class CharacterImageError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CharacterImageError'
    this.code = code
  }
}

function fail(code, message) {
  throw new CharacterImageError(code, message)
}

// Check every existing component; resolving only the final file misses linked parents.
function checkedPath(bookPath, relativePath, { createParents = false } = {}) {
  const parts = String(relativePath || '').split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\:\0]/.test(part))) {
    fail('CHARACTER_IMAGE_PATH_INVALID', '人物图片路径无效')
  }
  const root = resolve(bookPath)
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    const isParent = index < parts.length - 1
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink() || (isParent && !stat.isDirectory())) {
        fail('CHARACTER_IMAGE_PATH_INVALID', '人物图片路径不能经过符号链接或非目录文件')
      }
    } else if (isParent && createParents) {
      fs.mkdirSync(current)
    }
  }
  const location = relative(root, current)
  if (!location || location === '..' || location.startsWith(`..${sep}`)) {
    fail('CHARACTER_IMAGE_PATH_INVALID', '人物图片路径越出书籍范围')
  }
  return current
}

export function resolveCharacterImagePath(bookPath, relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/')
  if (!/^character_images\/[^/]+\.(?:png|jpe?g|webp)$/i.test(normalized)) {
    fail('CHARACTER_IMAGE_PATH_INVALID', '头像必须是当前书籍 character_images 中的图片')
  }
  const filePath = checkedPath(bookPath, normalized)
  if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
    fail('CHARACTER_IMAGE_NOT_FOUND', '人物图片不存在，请重新选择或生成')
  }
  return { filePath, relativePath: normalized }
}

export class CharacterImageService {
  constructor({ snapshotService, generateImageBuffer } = {}) {
    if (!snapshotService || typeof generateImageBuffer !== 'function') {
      throw new TypeError('snapshotService and generateImageBuffer are required')
    }
    this.snapshotService = snapshotService
    this.generateImageBuffer = generateImageBuffer
    this.sessions = new Map()
  }

  session(options, { create = false, allowCancelled = false } = {}) {
    const sessionId = String(options.sessionId || '')
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(sessionId)) {
      fail('CHARACTER_IMAGE_SESSION_INVALID', '人物图片会话标识无效，请重新打开生成窗口')
    }
    let session = this.sessions.get(sessionId)
    if (!session && create) {
      if (this.sessions.size >= MAX_RETAINED_SESSIONS) {
        fail('CHARACTER_IMAGE_SESSION_LIMIT', '人物图片会话过多，请关闭旧窗口后重试')
      }
      session = {
        sessionId,
        bookName: String(options.bookName || ''),
        bookPath: this.snapshotService.resolveBookPath(options.bookName),
        tempRelativePath: `.51mazi/tmp/character-images/${sessionId}`,
        cancelled: false,
        candidates: new Map()
      }
      this.sessions.set(sessionId, session)
    }
    if (!session || session.bookName !== String(options.bookName || '')) {
      fail('CHARACTER_IMAGE_SESSION_INVALID', '人物图片会话不存在或不属于此书籍')
    }
    if (session.cancelled && !allowCancelled) {
      fail('CHARACTER_IMAGE_SESSION_CANCELLED', '本次人物图片生成已取消，请重新打开生成窗口')
    }
    return session
  }

  async generate(options = {}) {
    const session = this.session(options, { create: true })
    const prompt = String(options.prompt || '').trim()
    if (!prompt) fail('CHARACTER_IMAGE_PROMPT_REQUIRED', '请输入人物图片描述')
    const buffer = await this.generateImageBuffer({
      ...options,
      prompt,
      size: options.size || '720*1280',
      bookPath: session.bookPath
    })
    if (session.cancelled) {
      fail('CHARACTER_IMAGE_SESSION_CANCELLED', '本次人物图片生成已取消')
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      fail('CHARACTER_IMAGE_RESULT_INVALID', '图片服务没有返回有效图片')
    }
    const localPath = checkedPath(
      session.bookPath,
      `${session.tempRelativePath}/${randomUUID()}.png`,
      { createParents: true }
    )
    fs.writeFileSync(localPath, buffer, { flag: 'wx' })
    session.candidates.set(localPath, { relativePath: '', localPath: '' })
    return { success: true, sessionId: session.sessionId, localPath }
  }

  confirm(options = {}) {
    const session = this.session(options)
    const chosenPath = resolve(String(options.chosenPath || options.tempImagePath || ''))
    const candidate = session.candidates.get(chosenPath)
    if (!candidate) {
      fail('CHARACTER_IMAGE_CANDIDATE_INVALID', '只能使用本次生成会话中的候选图片')
    }
    if (candidate.relativePath) {
      const saved = resolveCharacterImagePath(session.bookPath, candidate.relativePath)
      return { success: true, sessionId: session.sessionId, localPath: saved.filePath, relativePath: saved.relativePath }
    }
    const candidateRelativePath = relative(session.bookPath, chosenPath).split(sep).join('/')
    const source = checkedPath(session.bookPath, candidateRelativePath)
    if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) {
      fail('CHARACTER_IMAGE_NOT_FOUND', '候选图片不存在，请重新生成')
    }
    const relativePath = `character_images/${randomUUID()}.png`
    const localPath = checkedPath(session.bookPath, relativePath, { createParents: true })
    fs.copyFileSync(source, localPath, fs.constants.COPYFILE_EXCL)
    Object.assign(candidate, { localPath, relativePath })
    return { success: true, sessionId: session.sessionId, localPath, relativePath }
  }

  discard(options = {}) {
    const session = this.session(options, { create: true, allowCancelled: true })
    session.cancelled = true
    const tempPath = checkedPath(session.bookPath, session.tempRelativePath)
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { recursive: true, force: true })
    session.candidates.clear()
    let cancelledCount = 0
    for (const item of this.sessions.values()) if (item.cancelled) cancelledCount += 1
    for (const [sessionId, item] of this.sessions) {
      if (cancelledCount <= MAX_RETAINED_CANCELLED_SESSIONS) break
      if (!item.cancelled || sessionId === session.sessionId) continue
      this.sessions.delete(sessionId)
      cancelledCount -= 1
    }
    return { success: true, sessionId: session.sessionId }
  }
}

export default CharacterImageService
