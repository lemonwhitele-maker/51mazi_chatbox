import fs from 'node:fs'
import crypto, { randomUUID } from 'node:crypto'
import { join, relative } from 'node:path'
import yaml from 'js-yaml'
import { safeSegment } from './bookSavedSnapshotService.js'
import { writeFileAtomically } from './chapterWriteService.js'
import { resolveCharacterImagePath } from './characterImageService.js'
import {
  parseKnowledgeMarkdown,
  replaceKnowledgeSection,
  validateKnowledgeDocument
} from './knowledgeMarkdownParser.js'

const SCOPE_TYPES = Object.freeze({
  characters: 'character',
  settings: 'setting',
  outlines: 'outline'
})
const BACKUP_ROOT = join('.51mazi', 'backups', 'knowledge-documents')
const TEMPLATE_CONFIG = Object.freeze({
  characters: {
    prefix: 'char',
    metadata: { type: 'character', status: 'draft', aliases: [], tags: [] },
    sections: [
      ['summary', '核心定位'],
      ['current-state', '当前状态'],
      ['facts', '已确认事实']
    ]
  },
  settings: {
    prefix: 'setting',
    metadata: { type: 'setting', kind: 'custom', status: 'draft', aliases: [], tags: [] },
    sections: [
      ['definition', '定义'],
      ['rules', '规则与边界'],
      ['facts', '已确认事实']
    ]
  },
  outlines: {
    prefix: 'outline',
    metadata: {
      type: 'outline',
      status: 'planned',
      tags: [],
      order: null,
      relatedOutlines: [],
      chapterRefs: [],
      characterRefs: [],
      settingRefs: []
    },
    sections: [
      ['summary', '核心内容'],
      ['details', '展开说明'],
      ['constraints', '约束与结果']
    ]
  }
})

export const INITIAL_KNOWLEDGE_DOCUMENTS = Object.freeze([
  Object.freeze({
    scope: 'characters',
    id: 'example_character',
    title: '样例人物：林舟',
    metadata: {
      status: 'confirmed',
      aliases: ['小舟'],
      tags: ['样例', '主角']
    },
    sections: {
      summary: '一名负责替雾港传递密信的年轻向导。',
      'current-state': '刚收到一封没有署名的信，准备前往 [[setting:example_setting|雾港旧灯塔]]。',
      facts: '- 熟悉雾港的潮汐与暗巷。\n- 随身携带一枚刻着陌生家徽的铜扣。'
    }
  }),
  Object.freeze({
    scope: 'settings',
    id: 'example_setting',
    title: '样例设定：雾港旧灯塔',
    kind: 'location',
    metadata: {
      status: 'confirmed',
      aliases: ['旧灯塔'],
      tags: ['样例', '地点']
    },
    sections: {
      definition: '位于雾港外堤尽头的废弃灯塔，也是城内秘密消息的中转站。',
      rules: '- 退潮后的一个小时内才能从礁洞进入。\n- 塔顶的蓝灯只在有人求援时点亮。',
      facts:
        '- [[character:example_character|林舟]] 知道礁洞入口。\n- 铜制大门需要两枚不同的钥匙同时开启。'
    }
  }),
  Object.freeze({
    scope: 'outlines',
    id: 'example_outline',
    title: '样例大纲：雾港来信',
    metadata: {
      status: 'planned',
      tags: ['样例', '主线'],
      order: 1,
      relatedOutlines: [],
      chapterRefs: ['正文/第1章.txt'],
      characterRefs: ['example_character'],
      settingRefs: ['example_setting']
    },
    sections: {
      summary:
        '[[character:example_character|林舟]] 收到神秘来信，被引向 [[setting:example_setting|雾港旧灯塔]]。',
      details:
        '1. 林舟发现信纸带有海盐与蓝色蜡痕。\n2. 他在退潮前赶到旧灯塔。\n3. 塔顶蓝灯突然亮起。',
      constraints: '- 本段只提出家徽谜团，不揭示寄信人。\n- 结尾留下必须立即行动的悬念。'
    }
  })
])

function sha256(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
  } catch {
    throw new KnowledgeDocumentError('KNOWLEDGE_ENCODING_INVALID', '知识文档不是有效的 UTF-8 文本')
  }
}

function toPosix(value) {
  return String(value || '').replaceAll('\\', '/')
}

// Locate the YAML value with parser offsets so unrelated metadata and Markdown stay byte-identical.
export function withCharacterAvatar(source, avatar) {
  const original = String(source ?? '')
  const parsed = parseKnowledgeMarkdown(original)
  if (parsed.diagnostics.some((item) => item.code.startsWith('FRONTMATTER_'))) {
    throw new KnowledgeDocumentError('KNOWLEDGE_AVATAR_METADATA_INVALID', '请先修复人物文档的元数据再保存头像')
  }
  const raw = parsed.frontmatter.raw
  const stack = []
  let root = null
  yaml.load(raw, {
    schema: yaml.JSON_SCHEMA,
    listener(event, state) {
      if (event === 'open') {
        const node = { start: state.position, children: [] }
        if (stack.length) stack.at(-1).children.push(node)
        else root = node
        stack.push(node)
      } else {
        Object.assign(stack.pop(), { end: state.position, kind: state.kind, result: state.result })
      }
    }
  })
  while (root?.children.length === 1 && root.children[0].kind === 'mapping') root = root.children[0]
  if (root?.kind !== 'mapping') {
    throw new KnowledgeDocumentError('KNOWLEDGE_AVATAR_METADATA_INVALID', '人物元数据必须为键值对象')
  }
  let nextRaw = ''
  const quoted = JSON.stringify(String(avatar))
  for (let index = 0; index < root.children.length; index += 2) {
    if (root.children[index].result !== 'avatar') continue
    const value = root.children[index + 1]
    if (!value) break
    const previous = raw.slice(value.start, value.end)
    const leading = /^[ \t]*/.exec(previous)[0] || ' '
    const trailing = /(?:\r\n|\n|\r)[ \t]*$/.exec(previous)?.[0] || ''
    nextRaw = raw.slice(0, value.start) + leading + quoted + trailing + raw.slice(value.end)
    break
  }
  if (!nextRaw) {
    if (raw.slice(root.start).startsWith('{')) {
      const closing = raw.lastIndexOf('}', root.end - 1)
      nextRaw = raw.slice(0, closing) + `${root.children.length ? ', ' : ''}avatar: ${quoted}` + raw.slice(closing)
    } else {
      const eol = parsed.lineEnding
      nextRaw = raw + (raw && !/[\r\n]$/.test(raw) ? eol : '') + `avatar: ${quoted}${eol}`
    }
  }
  const opening = /^\uFEFF?---(?:\r\n|\n|\r)/.exec(original)
  if (!opening) {
    throw new KnowledgeDocumentError('KNOWLEDGE_AVATAR_METADATA_INVALID', '人物文档缺少元数据起始标记')
  }
  const next = original.slice(0, opening[0].length) + nextRaw + original.slice(opening[0].length + raw.length)
  const nextParsed = parseKnowledgeMarkdown(next)
  const withoutAvatar = (metadata) => {
    const remaining = { ...metadata }
    delete remaining.avatar
    return remaining
  }
  if (
    nextParsed.diagnostics.some((item) => item.code.startsWith('FRONTMATTER_')) ||
    nextParsed.metadata.avatar !== String(avatar) ||
    JSON.stringify(withoutAvatar(parsed.metadata)) !== JSON.stringify(withoutAvatar(nextParsed.metadata))
  ) {
    throw new KnowledgeDocumentError('KNOWLEDGE_AVATAR_METADATA_INVALID', '无法单独更新头像，请将 avatar 改为普通文本字段后重试')
  }
  return next
}

export class KnowledgeDocumentError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'KnowledgeDocumentError'
    this.code = code
    this.retryable = details.retryable === true
    Object.assign(this, details)
  }
}

export class KnowledgeDocumentService {
  constructor({
    snapshotService,
    atomicWriter = writeFileAtomically,
    tokenFactory = randomUUID,
    onCommitted = null
  } = {}) {
    if (!snapshotService) throw new TypeError('snapshotService is required')
    this.snapshotService = snapshotService
    this.atomicWriter = atomicWriter
    this.tokenFactory = tokenFactory
    this.onCommitted = typeof onCommitted === 'function' ? onCommitted : null
    this.writeQueues = new Map()
  }

  async notifyCommitted(event) {
    if (!this.onCommitted) return { indexStale: false }
    try {
      await this.onCommitted(event)
      return { indexStale: false }
    } catch (error) {
      return {
        indexStale: true,
        indexError: error?.message || '知识索引更新失败，可稍后重建'
      }
    }
  }

  createTemplateSource(scope, id, options = {}) {
    const config = TEMPLATE_CONFIG[scope]
    if (!config) throw new KnowledgeDocumentError('KNOWLEDGE_SCOPE_INVALID', '知识文档 scope 无效')
    const title = String(options.title || '').trim() || '未命名文档'
    const metadata = {
      ...config.metadata,
      ...(options.metadata || {}),
      id,
      type: config.metadata.type,
      title
    }
    if (scope === 'settings' && options.kind) metadata.kind = String(options.kind)
    const frontmatter = yaml
      .dump(metadata, {
        schema: yaml.JSON_SCHEMA,
        noRefs: true,
        lineWidth: 120,
        noCompatMode: true,
        sortKeys: false
      })
      .trimEnd()
    const sections = config.sections
      .map(([key, heading]) => {
        const content = String(options.sections?.[key] || '').trim()
        return `### ${heading} <!-- 51:section=${key} -->\n${content ? `\n${content}\n` : ''}`
      })
      .join('\n')
    return `---\n${frontmatter}\n---\n\n${sections}`
  }

  async createDocument({ bookName, scope, title = '', kind = '' } = {}) {
    const config = TEMPLATE_CONFIG[String(scope || '')]
    if (!config) throw new KnowledgeDocumentError('KNOWLEDGE_SCOPE_INVALID', '知识文档 scope 无效')
    const documentId = `${config.prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    const target = this.resolveDocumentFile(bookName, scope, documentId)
    return this.enqueue(`${bookName}:${target.relativePath}`, async () => {
      if (fs.existsSync(target.filePath)) {
        throw new KnowledgeDocumentError('KNOWLEDGE_DOCUMENT_EXISTS', '知识文档已存在')
      }
      const source = this.createTemplateSource(scope, documentId, { title, kind })
      this.validateSource(source, target, 'formal')
      await fs.promises.mkdir(join(target.filePath, '..'), { recursive: true })
      await this.atomicWriter(target.filePath, Buffer.from(source, 'utf8'))
      const created = this.readDocument({ bookName, scope, documentId })
      const indexState = await this.notifyCommitted({
        action: 'create',
        bookName,
        scope,
        documentId,
        fileHash: created.fileHash
      })
      return {
        documentId,
        source: created.source,
        fileHash: created.fileHash,
        sectionHashes: created.sectionHashes,
        savedAt: created.savedAt,
        ...indexState
      }
    })
  }

  async createDocumentFromSource({ bookName, scope, documentId, source } = {}) {
    const target = this.resolveDocumentFile(bookName, scope, documentId)
    return this.enqueue(`${bookName}:${target.relativePath}`, async () => {
      if (fs.existsSync(target.filePath)) {
        throw new KnowledgeDocumentError('KNOWLEDGE_DOCUMENT_EXISTS', '知识文档已存在')
      }
      this.validateSource(String(source ?? ''), target, 'formal')
      await fs.promises.mkdir(join(target.filePath, '..'), { recursive: true })
      await this.atomicWriter(target.filePath, Buffer.from(String(source ?? ''), 'utf8'))
      const created = this.readDocument({ bookName, scope, documentId: target.id })
      const indexState = await this.notifyCommitted({
        action: 'create',
        bookName,
        scope,
        documentId: target.id,
        fileHash: created.fileHash
      })
      return {
        documentId: target.id,
        fileHash: created.fileHash,
        sectionHashes: created.sectionHashes,
        savedAt: created.savedAt,
        ...indexState
      }
    })
  }

  async undoCreateDocument({ bookName, scope, documentId, expectedCurrentHash = '' } = {}) {
    const target = this.resolveDocumentFile(bookName, scope, documentId)
    return this.enqueue(`${bookName}:${target.relativePath}`, async () => {
      const current = this.readDocument({ bookName, scope, documentId: target.id })
      if (expectedCurrentHash && current.fileHash !== expectedCurrentHash) {
        throw new KnowledgeDocumentError(
          'KNOWLEDGE_UNDO_VERSION_CONFLICT',
          '知识文档在创建后又发生变化，无法安全撤销创建',
          { expectedHash: expectedCurrentHash, currentHash: current.fileHash }
        )
      }
      await fs.promises.unlink(target.filePath)
      const indexState = await this.notifyCommitted({
        action: 'delete-created',
        bookName,
        scope,
        documentId: target.id,
        previousHash: current.fileHash
      })
      return { deleted: true, documentId: target.id, ...indexState }
    })
  }

  async initializeBook({ bookName } = {}) {
    const created = []
    const existing = []
    for (const example of INITIAL_KNOWLEDGE_DOCUMENTS) {
      const target = this.resolveDocumentFile(bookName, example.scope, example.id)
      if (fs.existsSync(target.filePath)) {
        existing.push({ scope: example.scope, documentId: example.id })
        continue
      }
      const source = this.createTemplateSource(example.scope, example.id, example)
      this.validateSource(source, target, 'formal')
      await fs.promises.mkdir(join(target.filePath, '..'), { recursive: true })
      await this.atomicWriter(target.filePath, Buffer.from(source, 'utf8'))
      const read = this.readDocument({
        bookName,
        scope: example.scope,
        documentId: example.id
      })
      await this.notifyCommitted({
        action: 'initialize',
        bookName,
        scope: example.scope,
        documentId: example.id,
        fileHash: read.fileHash
      })
      created.push({
        scope: example.scope,
        documentId: example.id,
        relativePath: target.relativePath,
        fileHash: read.fileHash
      })
    }
    return { created, existing }
  }

  resolveDocumentFile(bookName, scope, documentId) {
    const type = SCOPE_TYPES[String(scope || '')]
    if (!type) throw new KnowledgeDocumentError('KNOWLEDGE_SCOPE_INVALID', '知识文档 scope 无效')
    const id = safeSegment(String(documentId || '').replace(/\.md$/i, ''), '知识文档 ID')
    const bookPath = this.snapshotService.resolveBookPath(bookName)
    const relativePath = join('knowledge', scope, `${id}.md`)
    const filePath = this.snapshotService.resolveInside(bookPath, relativePath, '知识文档')
    if (!filePath.toLowerCase().endsWith('.md')) {
      throw new KnowledgeDocumentError('KNOWLEDGE_EXTENSION_INVALID', '知识文档只支持 .md 文件')
    }
    return { bookPath, filePath, relativePath: toPosix(relativePath), id, type, scope }
  }

  readDocument({ bookName, scope, documentId } = {}) {
    const target = this.resolveDocumentFile(bookName, scope, documentId)
    if (!fs.existsSync(target.filePath)) {
      throw new KnowledgeDocumentError('KNOWLEDGE_DOCUMENT_NOT_FOUND', '知识文档不存在')
    }
    const stat = fs.statSync(target.filePath)
    if (!stat.isFile())
      throw new KnowledgeDocumentError('KNOWLEDGE_DOCUMENT_NOT_FILE', '知识文档路径不是文件')
    const rawBuffer = fs.readFileSync(target.filePath)
    const source = decodeUtf8(rawBuffer)
    const document = parseKnowledgeMarkdown(source)
    return {
      ...target,
      source,
      rawBuffer,
      fileHash: sha256(rawBuffer),
      mtimeMs: stat.mtimeMs,
      savedAt: stat.mtime.toISOString(),
      fileSize: stat.size,
      hasBom:
        rawBuffer.length >= 3 &&
        rawBuffer[0] === 0xef &&
        rawBuffer[1] === 0xbb &&
        rawBuffer[2] === 0xbf,
      sectionHashes: Object.fromEntries(
        document.sections.map((section) => [section.key, section.contentHash])
      ),
      document
    }
  }

  async enqueue(key, work) {
    const previous = this.writeQueues.get(key) || Promise.resolve()
    const current = previous.catch(() => {}).then(work)
    this.writeQueues.set(key, current)
    try {
      return await current
    } finally {
      if (this.writeQueues.get(key) === current) this.writeQueues.delete(key)
    }
  }

  validateSource(source, target, mode) {
    const document = parseKnowledgeMarkdown(source)
    const validation = validateKnowledgeDocument(document, { expectedType: target.type, mode })
    if (!validation.valid) {
      throw new KnowledgeDocumentError('KNOWLEDGE_DOCUMENT_INVALID', '知识文档校验失败', {
        diagnostics: validation.diagnostics
      })
    }
    if (String(document.metadata.id || '') !== target.id) {
      throw new KnowledgeDocumentError(
        'KNOWLEDGE_ID_MISMATCH',
        'frontmatter id 与目标文档 ID 不一致'
      )
    }
    return { document, validation }
  }

  async writeCharacterAvatar({ bookName, documentId, source, expectedFileHash, relativePath } = {}) {
    if (!String(expectedFileHash || '').trim()) {
      throw new KnowledgeDocumentError('KNOWLEDGE_DOCUMENT_VERSION_REQUIRED', '请先读取人物文档版本再保存头像')
    }
    const bookPath = this.snapshotService.resolveBookPath(bookName)
    const image = resolveCharacterImagePath(bookPath, relativePath)
    return this.writeDocument({
      bookName,
      scope: 'characters',
      documentId,
      expectedFileHash,
      source: withCharacterAvatar(source, image.relativePath),
      mode: 'formal'
    })
  }

  async writeDocument({
    bookName,
    scope,
    documentId,
    expectedFileHash = '',
    source,
    mode = 'formal'
  } = {}) {
    const target = this.resolveDocumentFile(bookName, scope, documentId)
    return this.enqueue(`${bookName}:${target.relativePath}`, async () => {
      const before = this.readDocument({ bookName, scope, documentId })
      const expected = String(expectedFileHash || '').trim()
      if (expected && expected !== before.fileHash) {
        throw new KnowledgeDocumentError(
          'KNOWLEDGE_DOCUMENT_VERSION_CONFLICT',
          '知识文档已发生变化，请重新读取后再保存',
          {
            expectedHash: expected,
            currentHash: before.fileHash
          }
        )
      }

      this.validateSource(String(source ?? ''), target, mode)
      const nextBuffer = before.hasBom
        ? Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from(String(source ?? ''), 'utf8')
          ])
        : Buffer.from(String(source ?? ''), 'utf8')
      const undoToken = safeSegment(this.tokenFactory(), '撤销令牌')
      const backupRoot = this.snapshotService.resolveInside(
        target.bookPath,
        BACKUP_ROOT,
        '知识文档备份'
      )
      await fs.promises.mkdir(backupRoot, { recursive: true })
      const backupPath = this.snapshotService.resolveInside(
        backupRoot,
        `${undoToken}.content`,
        '知识文档备份'
      )
      const manifestPath = this.snapshotService.resolveInside(
        backupRoot,
        `${undoToken}.json`,
        '知识文档备份清单'
      )
      await this.atomicWriter(backupPath, before.rawBuffer)

      try {
        const writeResult = await this.atomicWriter(target.filePath, nextBuffer)
        const after = this.readDocument({ bookName, scope, documentId })
        const manifest = {
          schemaVersion: 1,
          undoToken,
          status: 'applied',
          bookName: String(bookName),
          scope,
          documentId: target.id,
          target: toPosix(relative(target.bookPath, target.filePath)),
          backup: toPosix(relative(target.bookPath, backupPath)),
          previousHash: before.fileHash,
          appliedHash: after.fileHash,
          appliedAt: new Date().toISOString()
        }
        await this.atomicWriter(manifestPath, JSON.stringify(manifest, null, 2))
        const indexState = await this.notifyCommitted({
          action: 'write',
          bookName,
          scope,
          documentId: target.id,
          previousHash: before.fileHash,
          fileHash: after.fileHash
        })
        return {
          previousHash: before.fileHash,
          fileHash: after.fileHash,
          sectionHashes: after.sectionHashes,
          savedAt: after.savedAt,
          bytesWritten: writeResult?.bytesWritten ?? nextBuffer.byteLength,
          undoToken,
          ...indexState
        }
      } catch (error) {
        try {
          await this.atomicWriter(target.filePath, before.rawBuffer)
        } catch (restoreError) {
          throw new KnowledgeDocumentError(
            'KNOWLEDGE_WRITE_AND_RESTORE_FAILED',
            '知识文档保存失败，且自动恢复原文件失败',
            {
              cause: error,
              restoreError
            }
          )
        }
        if (error instanceof KnowledgeDocumentError) throw error
        throw new KnowledgeDocumentError(
          'KNOWLEDGE_DOCUMENT_WRITE_FAILED',
          '知识文档保存失败，原文件已恢复',
          {
            cause: error,
            retryable: true
          }
        )
      }
    })
  }

  async writeSection({
    bookName,
    scope,
    documentId,
    sectionKey,
    expectedFileHash = '',
    expectedSectionHash = '',
    content,
    mode = 'formal'
  } = {}) {
    const before = this.readDocument({ bookName, scope, documentId })
    const source = replaceKnowledgeSection(before.document, sectionKey, content, {
      expectedSectionHash
    })
    return this.writeDocument({
      bookName,
      scope,
      documentId,
      expectedFileHash: expectedFileHash || before.fileHash,
      source,
      mode
    })
  }

  async undoWrite({ bookName, undoToken, expectedCurrentHash = '' } = {}) {
    const token = safeSegment(undoToken, '撤销令牌')
    const bookPath = this.snapshotService.resolveBookPath(bookName)
    const backupRoot = this.snapshotService.resolveInside(bookPath, BACKUP_ROOT, '知识文档备份')
    const manifestPath = this.snapshotService.resolveInside(
      backupRoot,
      `${token}.json`,
      '知识文档备份清单'
    )
    if (!fs.existsSync(manifestPath))
      throw new KnowledgeDocumentError('KNOWLEDGE_UNDO_NOT_FOUND', '撤销记录不存在')
    const manifest = JSON.parse(decodeUtf8(fs.readFileSync(manifestPath)))
    if (manifest.status !== 'applied')
      throw new KnowledgeDocumentError('KNOWLEDGE_UNDO_ALREADY_USED', '该撤销记录已使用')
    const target = this.resolveDocumentFile(bookName, manifest.scope, manifest.documentId)

    return this.enqueue(`${bookName}:${target.relativePath}`, async () => {
      const current = this.readDocument({
        bookName,
        scope: manifest.scope,
        documentId: manifest.documentId
      })
      const expected = String(expectedCurrentHash || manifest.appliedHash || '')
      if (expected && current.fileHash !== expected) {
        throw new KnowledgeDocumentError(
          'KNOWLEDGE_UNDO_VERSION_CONFLICT',
          '知识文档在应用后又发生变化，无法安全撤销',
          {
            expectedHash: expected,
            currentHash: current.fileHash
          }
        )
      }
      const backupPath = this.snapshotService.resolveInside(
        bookPath,
        manifest.backup,
        '知识文档备份'
      )
      const backup = fs.readFileSync(backupPath)
      await this.atomicWriter(target.filePath, backup)
      const restored = this.readDocument({
        bookName,
        scope: manifest.scope,
        documentId: manifest.documentId
      })
      manifest.status = 'undone'
      manifest.undoneAt = new Date().toISOString()
      manifest.restoredHash = restored.fileHash
      await this.atomicWriter(manifestPath, JSON.stringify(manifest, null, 2))
      const indexState = await this.notifyCommitted({
        action: 'undo',
        bookName,
        scope: manifest.scope,
        documentId: manifest.documentId,
        fileHash: restored.fileHash
      })
      return {
        fileHash: restored.fileHash,
        sectionHashes: restored.sectionHashes,
        savedAt: restored.savedAt,
        ...indexState
      }
    })
  }
}

export default KnowledgeDocumentService
