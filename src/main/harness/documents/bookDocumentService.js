import crypto from 'node:crypto'
import fs from 'node:fs'
import { basename } from 'node:path'
import { HarnessError } from '../harnessErrors.js'
import { HELP_DOCUMENTS, getHelpDocument } from '../docs/helpDocuments.js'
import { makeSourceReference, parseSourceReference } from '../../services/bookSavedSnapshotService.js'
import { parseKnowledgeMarkdown, extractKnowledgeReferences } from '../../services/knowledgeMarkdownParser.js'
import { normalizeVirtualPath, describeDocumentPath } from './virtualDocumentPaths.js'
import { DEFAULT_TOOL_READ_BUDGET, resolveToolReadBudget } from '../../services/agentBudgets.js'
import { matchRelatedDocuments } from './relatedDocuments.js'

const RESULT_BUDGET = DEFAULT_TOOL_READ_BUDGET.maxResultChars
const COLLECTIONS = Object.freeze({
  characters: 'character',
  settings: 'setting',
  outlines: 'outline'
})
const TYPE_COLLECTIONS = Object.freeze(
  Object.fromEntries(Object.entries(COLLECTIONS).map(([collection, type]) => [type, collection]))
)
const CREATE_PREFIXES = Object.freeze({
  characters: 'char',
  settings: 'setting',
  outlines: 'outline'
})
const QUICK_NOTES_PATH = 'book/notes/quick-notes.md'

function fail(code, message, options = {}) {
  throw new HarnessError(code, message, { retryable: false, ...options })
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
  } catch {
    fail('DOCUMENT_ENCODING_INVALID', '文档不是有效的 UTF-8 文本')
  }
}

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n|\r/g, '\n')
}

function safeSliceEnd(text, start, length) {
  let end = Math.min(text.length, start + length)
  if (
    end > start &&
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[end])
  ) {
    end -= 1
  }
  return end
}

function clip(value, maxLength) {
  return String(value ?? '').slice(0, maxLength)
}

function clippedStrings(value, maxItems = 24, maxLength = 200) {
  return (Array.isArray(value) ? value : []).slice(0, maxItems).map((item) => clip(item, maxLength))
}

function titleFromMarkdown(text, fallback) {
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalizeText(text))?.[1] || ''
  const title = /^title:\s*(.+?)\s*$/m.exec(frontmatter)?.[1]
  return title ? title.replace(/^['"]|['"]$/g, '') : fallback
}

function pageItems(items, start, maxChars, resultBudget = RESULT_BUDGET) {
  const selected = []
  let used = 160
  for (let index = start; index < items.length; index += 1) {
    const size = JSON.stringify(items[index]).length + 2
    if (selected.length && used + size > Math.min(maxChars, resultBudget - 2500)) break
    selected.push(items[index])
    used += size
  }
  return { items: selected, nextOffset: start + selected.length }
}

function scopeFromContext(context) {
  const scope = context?.bookScope || context?.scope
  if (!scope) fail('BOOK_SCOPE_MISMATCH', 'read 缺少受信任的当前书籍 scope')
  return scope
}

function encodeViewReference(reference) {
  return Buffer.from(String(reference || ''), 'utf8').toString('base64url')
}

function decodeViewReference(value) {
  try {
    const decoded = Buffer.from(String(value || ''), 'base64url').toString('utf8')
    if (!decoded) throw new Error('empty')
    return decoded
  } catch {
    fail('DOCUMENT_NOT_FOUND', '只读视图地址无效')
  }
}

export class BookDocumentService {
  constructor({ sandboxService, retrievalService, conversationRetrievalService = null, readBudget = {} } = {}) {
    this.readBudget = resolveToolReadBudget(readBudget)
    this.sandboxService = sandboxService
    this.retrievalService = retrievalService
    this.conversationRetrievalService = conversationRetrievalService
    this.cursorPrefix = crypto.randomBytes(4).toString('hex')
    this.cursorSequence = 0
    this.cursors = new Map()
    this.cursorKeys = new Map()
    this.snapshots = new Map()
  }

  createCursor(context, payload) {
    const value = { ...payload, conversationId: context.conversationId || '', turnId: context.turnId || '' }
    const key = JSON.stringify(value)
    const previous = this.cursorKeys.get(key)
    if (previous && this.cursors.get(previous)?.expiresAt > Date.now()) return previous
    // Session-local handles: metadata stays on the backend, never in model arguments.
    for (const [token, entry] of this.cursors) {
      if (entry.expiresAt <= Date.now()) {
        this.cursors.delete(token)
        this.cursorKeys.delete(entry.key)
      }
    }
    while (this.cursors.size >= 4096) {
      const [token, entry] = this.cursors.entries().next().value
      this.cursors.delete(token)
      this.cursorKeys.delete(entry.key)
    }
    const token = `r${this.cursorPrefix}-${(++this.cursorSequence).toString(36)}`
    this.cursors.set(token, { value, key, expiresAt: Date.now() + 60 * 60 * 1000 })
    this.cursorKeys.set(key, token)
    return token
  }

  resolveCursor(context, token, tool) {
    const scope = scopeFromContext(context)
    const entry = this.cursors.get(token)
    if (!entry || entry.expiresAt <= Date.now()) {
      fail('CURSOR_INVALID', '续读游标不存在或已失效，请重新读取目标路径获取新游标', {
        retryable: true,
        nextAction: tool === 'list_files'
          ? '重新调用 list_files（可指定原目录 path），再使用返回的 nextCursor。'
          : '调用 read 并指定原文档 path，从头获取新 nextCursor；不要修改或猜测游标。'
      })
    }
    const value = entry.value
    if (value.scopeId !== scope.scopeId || value.bookIdentity !== scope.bookIdentity ||
        value.conversationId !== (context.conversationId || '') || value.turnId !== (context.turnId || '') ||
        (value.kind === 'manifest' ? 'list_files' : 'read') !== tool) {
      fail('CURSOR_INVALID', '游标与当前书籍、会话、轮次或工具不一致，请重新读取', {
        retryable: true, nextAction: '在当前任务中重新读取目标路径，使用新返回的 nextCursor。'
      })
    }
    return value
  }

  knowledgeAliases(scope, collection) {
    const items = this.retrievalService.listBookStructure(scope.bookKey, [collection], { mode: 'flat' })[collection] || []
    const entries = items.map((item) => {
      const actual = String(item.path || `knowledge/${collection}/${item.targetId}.md`).replaceAll('\\', '/')
      if (!actual.startsWith(`knowledge/${collection}/`) || actual.slice(`knowledge/${collection}/`.length).includes('/')) return null
      // eslint-disable-next-line no-control-regex
      const title = String(item.title || item.targetId).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) || '未命名'
      return { actual: `book/${actual}`, title, alias: `book/knowledge/${collection}/${title}.md` }
    }).filter(Boolean)
    const reserved = new Set(entries.map((item) => item.actual.toLowerCase()))
    const counts = new Map()
    for (const item of entries) counts.set(item.alias.toLowerCase(), (counts.get(item.alias.toLowerCase()) || 0) + 1)
    for (const item of entries) {
      if (counts.get(item.alias.toLowerCase()) > 1 || (reserved.has(item.alias.toLowerCase()) && item.alias.toLowerCase() !== item.actual.toLowerCase()))
        item.alias = item.alias.slice(0, -3) + `（${crypto.createHash('sha256').update(item.actual).digest('hex').slice(0, 12)}）.md`
    }
    return entries
  }

  canonicalPath(scope, value) {
    this.sandboxService.assertScope(scope)
    const path = normalizeVirtualPath(value)
    const actualName = (directory, name) => {
      let parent
      try {
        parent = this.sandboxService.resolveReadable(scope, directory, { kind: 'directory' })
      } catch (error) {
        if (error?.code === 'DOCUMENT_NOT_FOUND') return name
        throw error
      }
      const names = fs.readdirSync(parent)
      if (names.includes(name)) return name
      const matches = names.filter((entry) => entry.toLowerCase() === name.toLowerCase())
      if (matches.length > 1) fail('PATH_AMBIGUOUS', '存在多个仅大小写不同的目标，请复制目录中的准确 path')
      return matches[0] || name
    }
    const target = describeDocumentPath(path)
    if (target && ['character', 'setting', 'outline'].includes(target.type)) {
      const diskName = actualName(`knowledge/${target.collection}`, basename(path))
      try {
        this.sandboxService.resolveReadable(scope, `knowledge/${target.collection}/${diskName}`, { kind: 'file' })
        return `book/knowledge/${target.collection}/${diskName}`
      } catch (error) {
        if (error.code !== 'DOCUMENT_NOT_FOUND') throw error
      }
      const alias = this.knowledgeAliases(scope, target.collection).filter((item) => item.alias.toLowerCase() === path.toLowerCase())
      if (alias.length > 1) fail('PATH_AMBIGUOUS', '文档名称不唯一，请重新 list_files')
      const resolved = alias[0]?.actual || path
      return `book/knowledge/${target.collection}/${actualName(`knowledge/${target.collection}`, basename(resolved))}`
    }
    const chapter = /^book\/chapters\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path)
    if (chapter) {
      const volume = actualName('正文', chapter[1])
      return chapter[2]
        ? `book/chapters/${volume}/${actualName(`正文/${volume}`, chapter[2])}`
        : `book/chapters/${volume}/`
    }
    return path
  }

  physicalFile(scope, value) {
    const path = this.canonicalPath(scope, value)
    const target = describeDocumentPath(path)
    if (!target) return null
    const { relativePath, type: sourceType, documentId: objectId, internal } = target
    const authorityStatus = sourceType === 'note' ? 'private_note'
      : sourceType === 'outline' ? 'planned_saved' : 'authoritative_saved'
    const filePath = internal
      ? this.sandboxService.resolveInternal(scope, relativePath, { kind: 'file' })
      : this.sandboxService.resolveReadable(scope, relativePath, { kind: 'file' })
    let raw
    try {
      raw = fs.readFileSync(filePath)
    } catch {
      fail('READ_VERSION_CHANGED', '文档在读取时发生变化，请重新读取', { retryable: true })
    }
    const text = normalizeText(decodeUtf8(raw))
    const savedHash = hash(raw)
    return {
      path,
      raw: Buffer.from(raw),
      text,
      savedHash,
      sourceType,
      objectId,
      authorityStatus,
      title: titleFromMarkdown(text, basename(path).replace(/\.(?:md|txt)$/i, '')),
      reference: makeSourceReference({
        sourceType,
        targetId: objectId,
        location: ['character', 'setting', 'outline'].includes(sourceType) ? 'document' : '',
        contentHash: savedHash
      })
    }
  }

  async conversationFile(scope, path, bookKey) {
    const match = /^book\/conversations\/([^/]+)\.md$/i.exec(path)
    if (!match) return null
    if (!this.conversationRetrievalService) fail('RESOURCE_NOT_SUPPORTED', '历史对话读取服务不可用')
    let conversationId
    try {
      conversationId = decodeURIComponent(match[1])
    } catch {
      fail('DOCUMENT_NOT_FOUND', '历史对话地址无效')
    }
    const result = await this.conversationRetrievalService.readConversationDocument(
      bookKey,
      conversationId
    )
    return {
      path,
      text: normalizeText(result.text),
      savedHash: result.contentHash,
      sourceType: 'conversation',
      objectId: result.targetId,
      authorityStatus: result.authorityStatus,
      title: result.title,
      reference: result.reference
    }
  }

  async fileSnapshot(scope, path, bookKey) {
    const help = getHelpDocument(path)
    if (help !== null) {
      return {
        path,
        raw: Buffer.from(help, 'utf8'),
        text: normalizeText(help),
        savedHash: hash(help),
        sourceType: 'help',
        objectId: path,
        authorityStatus: 'instructional',
        title: path.split('/').at(-1),
        reference: null
      }
    }
    const snapshot =
      this.physicalFile(scope, path) || (await this.conversationFile(scope, path, bookKey))
    if (snapshot && !snapshot.raw) snapshot.raw = Buffer.from(snapshot.text, 'utf8')
    return snapshot
  }

  rememberSnapshot(scope, snapshot) {
    const key = `${scope.scopeId}|${snapshot.path}|${snapshot.savedHash}`
    this.snapshots.delete(key)
    this.snapshots.set(key, {
      ...snapshot,
      raw: Buffer.from(snapshot.raw),
      text: String(snapshot.text)
    })
    while (this.snapshots.size > 128) this.snapshots.delete(this.snapshots.keys().next().value)
  }

  getSnapshot(context, path, savedHash) {
    const scope = scopeFromContext(context)
    this.sandboxService.assertScope(scope)
    const normalized = this.canonicalPath(scope, path)
    const snapshot = this.snapshots.get(`${scope.scopeId}|${normalized}|${savedHash}`)
    return snapshot
      ? { ...snapshot, raw: Buffer.from(snapshot.raw), text: String(snapshot.text) }
      : null
  }

  describeKnowledgePath(context, path, { mustExist = true } = {}) {
    const target = this.describeWritablePath(context, path, { mustExist })
    if (!['character', 'setting', 'outline'].includes(target.type))
      fail('RESOURCE_NOT_SUPPORTED', '此操作只支持人物、设定和大纲文档')
    return target
  }

  describeWritablePath(context, path, { mustExist = true } = {}) {
    const scope = scopeFromContext(context)
    this.sandboxService.assertScope(scope)
    const target = describeDocumentPath(this.canonicalPath(scope, path))
    if (!target) fail('RESOURCE_NOT_SUPPORTED', '只支持人物、设定、大纲、正文章节和速记文档')
    const resolve = target.internal
      ? mustExist ? 'resolveInternal' : 'prepareInternalPath'
      : mustExist ? 'resolveReadable' : 'prepareCandidateTarget'
    const filePath = this.sandboxService[resolve](scope, target.relativePath, { kind: 'file' })
    return { ...target, filePath }
  }

  prepareCreate(context, directory, { reservedPaths = [] } = {}) {
    const scope = scopeFromContext(context)
    this.sandboxService.assertScope(scope)
    const normalized = this.canonicalPath(scope, directory)
    if (/^book\/knowledge\/(characters|settings|outlines)\/$/.test(normalized)) return null

    const volumeName = /^book\/chapters\/([^/]+)\/$/.exec(normalized)?.[1]
    if (volumeName) {
      const reserved = new Set(reservedPaths.map(String))
      this.sandboxService.resolveReadable(scope, `正文/${volumeName}`, { kind: 'directory' })
      for (let index = 1; index <= 100000; index += 1) {
        const chapterName = `新章节-${index}`
        const target = this.describeWritablePath(
          context,
          `book/chapters/${volumeName}/${chapterName}.txt`,
          { mustExist: false }
        )
        if (!fs.existsSync(target.filePath) && !reserved.has(target.relativePath)) return target
      }
      fail('CREATE_TARGET_EXISTS', '当前卷无法分配新章节名')
    }

    if (normalized === 'book/notes/') {
      const target = this.describeWritablePath(context, QUICK_NOTES_PATH, { mustExist: false })
      if (fs.existsSync(target.filePath)) fail('CREATE_TARGET_EXISTS', '速记文档已存在')
      return target
    }
    fail('RESOURCE_NOT_SUPPORTED', '该目录不支持新建文档')
  }

  prepareKnowledgeCreate(context, directory, documentId) {
    const scope = scopeFromContext(context)
    this.sandboxService.assertScope(scope)
    const normalized = normalizeVirtualPath(directory)
    const collection = /^book\/knowledge\/(characters|settings|outlines)\/$/.exec(normalized)?.[1]
    if (!collection) fail('RESOURCE_NOT_SUPPORTED', 'P3 只支持在人物、设定和大纲目录中新建文档')
    const id = String(documentId || '')
    if (!new RegExp(`^${CREATE_PREFIXES[collection]}_[a-z0-9]+$`, 'i').test(id))
      fail('DOCUMENT_FORMAT_INVALID', '后端生成的知识文档 ID 无效')
    const target = this.describeKnowledgePath(context, `book/knowledge/${collection}/${id}.md`, {
      mustExist: false
    })
    if (fs.existsSync(target.filePath)) fail('CREATE_TARGET_EXISTS', '新建目标已经存在')
    return target
  }

  async currentKnowledgeSnapshot(context, path) {
    const target = this.describeKnowledgePath(context, path)
    const scope = scopeFromContext(context)
    const snapshot = this.physicalFile(scope, target.path)
    if (!snapshot) fail('DOCUMENT_NOT_FOUND', '知识文档不存在')
    return { target, snapshot }
  }

  async currentWritableSnapshot(context, path) {
    const target = this.describeWritablePath(context, path)
    const scope = scopeFromContext(context)
    const snapshot = this.physicalFile(scope, target.path)
    if (!snapshot) fail('DOCUMENT_NOT_FOUND', '文档不存在')
    return { target, snapshot }
  }

  async listDirectory(scope, path, bookKey) {
    if (path === 'book/')
      return [
        { kind: 'directory', name: 'knowledge', path: 'book/knowledge/' },
        { kind: 'directory', name: 'chapters', path: 'book/chapters/' },
        { kind: 'directory', name: 'notes', path: 'book/notes/' },
        { kind: 'directory', name: 'conversations', path: 'book/conversations/' }
      ]
    if (path === 'book/knowledge/')
      return Object.keys(COLLECTIONS).map((name) => ({
        kind: 'directory',
        name,
        path: `book/knowledge/${name}/`
      }))
    const collection = /^book\/knowledge\/(characters|settings|outlines)\/$/.exec(path)?.[1]
    if (collection) {
      const structure = this.retrievalService.listBookStructure(bookKey, [collection], {
        mode: 'flat'
      })
      const entries = []
      for (const item of structure[collection] || []) {
        const actual = String(
          item.path || `knowledge/${collection}/${item.targetId}.md`
        ).replaceAll('\\', '/')
        if (!actual.startsWith(`knowledge/${collection}/`) || !/\.md$/i.test(actual)) continue
        if (actual.slice(`knowledge/${collection}/`.length).includes('/')) continue
        try {
          this.sandboxService.resolveReadable(scope, actual, { kind: 'file' })
        } catch {
          continue
        }
        entries.push({
          kind: 'file',
          name: basename(actual),
          path: `book/${actual}`,
          title: clip(item.title || item.targetId, 300),
          sourceType: COLLECTIONS[collection],
          authorityStatus: item.authorityStatus || 'authoritative_saved',
          reference: item.reference ? clip(item.reference, 1500) : null
        })
      }
      return entries.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
    }
    if (path === 'book/chapters/' || /^book\/chapters\/[^/]+\/$/.test(path)) {
      const prefix = path === 'book/chapters/' ? '' : path.slice('book/chapters/'.length)
      let directoryPath
      try {
        directoryPath = this.sandboxService.resolveReadable(
          scope, prefix ? `正文/${prefix.slice(0, -1)}` : '正文', { kind: 'directory' }
        )
      } catch (error) {
        if (error?.code !== 'DOCUMENT_NOT_FOUND') throw error
        // The virtual chapters collection exists even before the first volume.
        if (!prefix) return []
        fail('DOCUMENT_NOT_FOUND', '指定的卷目录不存在', {
          retryable: true,
          nextAction: 'read book/chapters/，从返回结果中选择已有卷的 path'
        })
      }
      const items = []
      for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
        if (!prefix) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
          this.sandboxService.resolveReadable(scope, `正文/${entry.name}`, { kind: 'directory' })
          items.push({ kind: 'directory', name: entry.name, path: `book/chapters/${entry.name}/` })
        } else {
          if (!/\.txt$/i.test(entry.name) || (!entry.isFile() && !entry.isSymbolicLink())) continue
          const file = this.physicalFile(scope, `${path}${entry.name}`)
          items.push({
            kind: 'file',
            name: entry.name,
            path: file.path,
            title: clip(entry.name.replace(/\.txt$/i, ''), 300),
            sourceType: 'chapter',
            authorityStatus: 'authoritative_saved',
            reference: file.reference
          })
        }
      }
      return items.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
    }
    if (path === 'book/notes/') {
      try {
        const file = this.physicalFile(scope, 'book/notes/quick-notes.md')
        return [
          {
            kind: 'file',
            name: 'quick-notes.md',
            path: file.path,
            title: '助手速记',
            sourceType: 'note',
            authorityStatus: file.authorityStatus,
            reference: file.reference
          }
        ]
      } catch (error) {
        if (error?.code === 'DOCUMENT_NOT_FOUND') return []
        throw error
      }
    }
    if (path === 'book/conversations/') {
      if (!this.conversationRetrievalService) return []
      const entries = await this.conversationRetrievalService.listConversationStructure(bookKey)
      return entries
        .map((item) => ({
          kind: 'file',
          name: `${encodeURIComponent(item.targetId)}.md`,
          path: `book/conversations/${encodeURIComponent(item.targetId)}.md`,
          title: clip(item.title, 300),
          sourceType: 'conversation',
          authorityStatus: 'unconfirmed_conversation',
          updatedAt: item.updatedAt || null
        }))
        .filter((item) => item.path.length <= 1024)
    }
    if (path === 'help/')
      return Object.keys(HELP_DOCUMENTS).map((item) => ({
        kind: 'file',
        name: item.slice('help/'.length),
        path: item
      }))
    if (path === 'view/')
      return [
        { kind: 'directory', name: 'backlinks', path: 'view/backlinks/' },
        { kind: 'directory', name: 'outline-context', path: 'view/outline-context/' }
      ]
    if (path === 'view/backlinks/' || path === 'view/outline-context/') return []
    return null
  }

  async search(scope, path, query, bookKey) {
    const scopes = []
    if (path === 'book/' || path === 'book/knowledge/')
      scopes.push('chapters', 'characters', 'settings', 'outlines', 'notes')
    else if (path === 'book/chapters/' || path.startsWith('book/chapters/')) scopes.push('chapters')
    else if (path === 'book/notes/') scopes.push('notes')
    else {
      const collection = /^book\/knowledge\/(characters|settings|outlines)\/$/.exec(path)?.[1]
      if (collection) scopes.push(collection)
    }
    const hits = []
    if (scopes.length) {
      const result = this.retrievalService.searchBookKnowledge(bookKey, query, {
        scopes,
        limit: 50,
        mode: 'hybrid'
      })
      for (const hit of result.results || []) {
        const hitPath = await this.pathForSearchHit(scope, hit, bookKey)
        if (!hitPath || (path !== 'book/' && !hitPath.startsWith(path))) continue
        hits.push({
          path: hitPath,
          title: clip(hit.title || hit.targetId, 300),
          snippet: String(hit.snippet || '').slice(0, 600),
          sourceType: hit.sourceType,
          authorityStatus: hit.authorityStatus || 'authoritative_saved',
          reference: hit.reference ? clip(hit.reference, 1500) : null,
          score: hit.score ?? null
        })
      }
    }
    if (path === 'book/' || path === 'book/conversations/') {
      const result = await this.conversationRetrievalService?.search(bookKey, query, { limit: 50 })
      for (const hit of result?.results || [])
        hits.push({
          path: `book/conversations/${encodeURIComponent(hit.targetId)}.md`,
          title: clip(hit.title, 300),
          snippet: String(hit.snippet || '').slice(0, 600),
          sourceType: 'conversation',
          authorityStatus: 'unconfirmed_conversation',
          reference: hit.reference ? clip(hit.reference, 1500) : null,
          score: hit.score ?? null
        })
    }
    return hits.sort(
      (left, right) =>
        Number(right.score || 0) - Number(left.score || 0) || left.path.localeCompare(right.path)
    )
  }

  async pathForSearchHit(scope, hit, bookKey) {
    if (hit.sourceType === 'chapter') {
      const path = `book/chapters/${String(hit.targetId || '').replaceAll('\\', '/')}`
      try {
        return this.physicalFile(scope, path)?.path || null
      } catch {
        return null
      }
    }
    const collection = TYPE_COLLECTIONS[hit.sourceType]
    if (collection) {
      const structure = this.retrievalService.listBookStructure(bookKey, [collection], {
        mode: 'flat'
      })
      const item = (structure[collection] || []).find(
        (entry) => String(entry.targetId) === String(hit.targetId)
      )
      if (!item) return null
      const actual = String(item.path || '').replaceAll('\\', '/')
      try {
        this.sandboxService.resolveReadable(scope, actual, { kind: 'file' })
        return `book/${actual}`
      } catch {
        return null
      }
    }
    if (hit.sourceType === 'note') {
      try {
        return this.physicalFile(scope, 'book/notes/quick-notes.md')?.path || null
      } catch {
        return null
      }
    }
    return null
  }

  pathForReference(scope, reference) {
    try {
      const { sourceType, targetId } = parseSourceReference(reference)
      const collection = TYPE_COLLECTIONS[sourceType]
      const path = collection ? `book/knowledge/${collection}/${targetId}.md`
        : sourceType === 'chapter' ? `book/chapters/${targetId}`
          : sourceType === 'note' ? QUICK_NOTES_PATH : null
      return path ? this.describeWritablePath({ bookScope: scope }, path).path : null
    } catch {
      return null
    }
  }

  documentLinks(scope, snapshot, text) {
    if (!['character', 'setting', 'outline', 'note'].includes(snapshot.sourceType)) return []
    const references = extractKnowledgeReferences(text).map((item) => `${item.sourceType}:${item.targetId}`)
    if (snapshot.sourceType !== 'note') {
      const metadata = parseKnowledgeMarkdown(text).metadata
      for (const key of ['relatedOutlines', 'chapterRefs', 'characterRefs', 'settingRefs'])
        if (Array.isArray(metadata[key])) references.push(...metadata[key])
    }
    const links = []
    let size = 0
    for (const reference of [...new Set(references)].slice(0, 24)) {
      const path = this.pathForReference(scope, reference)
      if (!path) continue
      const link = { reference, path }
      size += JSON.stringify(link).length
      if (size > 2000) break
      links.push(link)
    }
    return links
  }

  async readView(path, bookKey, scope) {
    const match = /^view\/(backlinks|outline-context)\/([^/]+)$/.exec(path)
    if (!match) return null
    const reference = decodeViewReference(match[2])
    if (match[1] === 'backlinks') {
      const result = this.retrievalService.readBookBacklinks(bookKey, reference, { limit: 100 })
      return {
        kind: 'view',
        path,
        viewType: 'backlinks',
        reference: result.reference,
        target: result.target,
        items: (result.backlinks || []).map((item) => ({
          sourceType: item.sourceType || item.source?.type || null,
          objectId: clip(item.targetId || item.source?.id || '', 500) || null,
          title: clip(item.title || '', 300) || null,
          reference: clip(item.reference || '', 1500) || null,
          path: this.pathForReference(scope, item.reference || makeSourceReference({
            sourceType: item.sourceType || item.source?.type,
            targetId: item.targetId || item.source?.id
          })),
          kind: item.kind || null,
          line: item.line || null
        })),
        truncated: Boolean(result.truncated)
      }
    }
    const result = this.retrievalService.readOutlineContext(bookKey, reference, {
      maxDepth: 2,
      maxRelated: 30,
      maxChars: this.readBudget.maxPageChars
    })
    return {
      kind: 'view',
      path,
      viewType: 'outline-context',
      requested: result.requested,
      items: (result.documents || []).map((item) => ({
        id: item.id,
        title: clip(item.title, 300),
        reason: item.reason,
        summary: clip(item.summary, 1200),
        reference: clip(item.reference, 1500),
        path: this.pathForReference(scope, makeSourceReference({ sourceType: 'outline', targetId: item.id })),
        relatedOutlines: clippedStrings(item.relatedOutlines),
        chapterRefs: clippedStrings(item.chapterRefs),
        characterRefs: clippedStrings(item.characterRefs),
        settingRefs: clippedStrings(item.settingRefs)
      })),
      truncated: Boolean(result.truncated)
    }
  }

  viewPaths(reference) {
    const encoded = encodeViewReference(reference)
    const result = { backlinks: `view/backlinks/${encoded}` }
    if (/^(?:outline|chapter):/i.test(String(reference || '')))
      result.outlineContext = `view/outline-context/${encoded}`
    return result
  }

  async listFiles(context, args = {}) {
    const scope = scopeFromContext(context)
    this.sandboxService.assertScope(scope)
    const cursor = args.cursor ? this.resolveCursor(context, args.cursor, 'list_files') : null
    const path = normalizeVirtualPath(args.path || cursor?.path || 'book/')
    if (cursor && cursor.path !== path) fail('CURSOR_INVALID', '游标与目录不一致，请仅传 cursor 续列')
    if (!path.startsWith('book/') || !path.endsWith('/')) fail('RESOURCE_NOT_SUPPORTED', 'list_files 需要书籍目录')
    const items = []
    const walk = async (directory) => {
      const children = await this.listDirectory(scope, directory, scope.bookKey)
      if (!children) fail('RESOURCE_NOT_SUPPORTED', '不支持的文件目录')
      for (const child of children) {
        if (child.kind === 'directory') {
          if (child.path !== 'book/conversations/' || path === 'book/conversations/') await walk(child.path)
        } else {
          const collection = /^book\/knowledge\/(characters|settings|outlines)\//.exec(child.path)?.[1]
          const alias = collection ? this.knowledgeAliases(scope, collection).find((item) => item.actual === child.path)?.alias : null
          items.push({ path: alias || child.path, title: child.title || child.name, sourceType: child.sourceType })
        }
      }
    }
    await walk(path)
    const version = hash(JSON.stringify(items))
    if (cursor && (cursor.kind !== 'manifest' || cursor.version !== version)) fail('READ_VERSION_CHANGED', '文件列表已变化，请重新列出')
    const start = cursor?.offset || 0
    if (start > items.length) fail('CURSOR_INVALID', '清单游标越界')
    const maxChars = args.maxChars ?? cursor?.maxChars ?? this.readBudget.maxPageChars
    const page = pageItems(items, start, maxChars, this.readBudget.maxResultChars)
    const complete = page.nextOffset >= items.length
    return { data: { resultType: 'document_manifest', path, items: page.items, total: items.length, complete,
      nextCursor: complete ? null : this.createCursor(context, { scopeId: scope.scopeId, bookIdentity: scope.bookIdentity, path, maxChars, query: 'list_files', kind: 'manifest', version, offset: page.nextOffset })
    }, references: [], truncated: !complete }
  }

  attachRelatedDocuments(context, result) {
    const pages = result.data.resultType === 'document_batch'
      ? result.data.items.filter((item) => item.ok).map((item) => item.data)
      : [result.data]
    const fragments = pages.filter((page) => page.sourceType === 'chapter').map((page) => page.text)
    if (!fragments.length) return result
    const scope = scopeFromContext(context)
    const structure = this.retrievalService.listBookStructure(scope.bookKey, ['characters', 'settings'], { mode: 'flat' })
    const matches = matchRelatedDocuments(structure, fragments)
    result.data.relatedDocuments = {
      notice: '仅按本次返回正文中的名称和别名匹配，已按文档去重；同名称可能对应多个文档。列表不代表已读取详情，可按需 read(path)。',
      items: [],
      total: matches.length,
      truncated: false
    }
    // Keep the index inside the existing result budget; never shorten the body
    // after matching, or count linked documents as read evidence.
    let remaining = this.readBudget.maxResultChars - JSON.stringify(result).length - 512
    for (const match of matches) {
      const size = JSON.stringify(match).length + 1
      if (size > remaining) {
        result.data.relatedDocuments.truncated = true
        continue
      }
      result.data.relatedDocuments.items.push(match)
      remaining -= size
    }
    return result
  }

  async read(context, args = {}, includeRelatedDocuments = true) {
    if (args.paths !== undefined) {
      if (args.path !== undefined || args.cursor !== undefined || args.query !== undefined || !Array.isArray(args.paths) || !args.paths.length || args.paths.length > 12)
        fail('TOOL_ARGUMENT_INVALID', 'paths 批量读取不能同时使用 path、cursor 或 query；每批 1–12 个文件')
      const items = []
      const pendingPaths = []
      let remaining = this.readBudget.batchResultChars - JSON.stringify(args.paths).length
      for (const path of args.paths) {
        if (remaining < 2500) { pendingPaths.push(path); continue }
        try {
          const result = await this.read(context, { path, maxChars: Math.min(args.maxChars || this.readBudget.defaultPageChars, remaining - 2000) }, false)
          if (result.data.resultType !== 'document_read') fail('RESOURCE_NOT_SUPPORTED', '批量读取只支持文件，请用 list_files 列目录')
          const item = { ok: true, ...result }
          if (JSON.stringify(item).length > remaining) { pendingPaths.push(path); continue }
          items.push(item)
          remaining -= JSON.stringify(item).length
        } catch (error) {
          const item = { ok: false, path, error: { code: error.code || 'DOCUMENT_READ_FAILED', message: String(error.message).slice(0, 500) } }
          items.push(item)
          remaining -= JSON.stringify(item).length
        }
      }
      const result = { data: { resultType: 'document_batch', items, pendingPaths, complete: !pendingPaths.length && items.every((item) => item.ok && item.data.complete) },
        references: [...new Set(items.flatMap((item) => item.references || []))], truncated: pendingPaths.length > 0 || items.some((item) => item.truncated) }
      return this.attachRelatedDocuments(context, result)
    }
    const scope = scopeFromContext(context)
    this.sandboxService.assertScope(scope)
    const bookKey = scope.bookKey
    const cursor = args.cursor ? this.resolveCursor(context, args.cursor, 'read') : null
    const path = this.canonicalPath(scope, args.path ?? cursor?.path)
    const query = String(args.query ?? cursor?.query ?? '')
    if (cursor && (cursor.path !== path || cursor.query !== query))
      fail('CURSOR_INVALID', '游标与路径或查询条件不一致，请仅传 cursor 续读')
    if (query.length > 500) fail('TOOL_ARGUMENT_INVALID', 'query 超过 500 字符')
    if (args.cursor && String(args.cursor).length > 64)
      fail('CURSOR_INVALID', '续读 cursor 超过长度限制')
    if (
      args.maxChars !== undefined &&
      (!Number.isInteger(args.maxChars) || args.maxChars < 512 || args.maxChars > this.readBudget.maxPageChars)
    ) {
      fail('TOOL_ARGUMENT_INVALID', `maxChars 必须是 512 到 ${this.readBudget.maxPageChars} 的整数`)
    }
    const maxChars = args.maxChars ?? cursor?.maxChars ?? this.readBudget.defaultPageChars

    const directory = await this.listDirectory(scope, path, bookKey)
    if (directory) {
      if (cursor && cursor.kind !== (query ? 'search' : 'directory'))
        fail('CURSOR_INVALID', 'cursor 类型与当前读取不一致')
      const allItems = query ? await this.search(scope, path, query, bookKey) : directory
      const version = hash(JSON.stringify(allItems))
      if (cursor?.version && cursor.version !== version)
        fail('READ_VERSION_CHANGED', '目录或检索结果版本已变化，请从第一页重新读取', {
          retryable: true
        })
      const start = cursor?.offset || 0
      if (start > allItems.length) fail('CURSOR_INVALID', 'cursor 位置超出当前结果')
      const page = pageItems(allItems, start, maxChars, this.readBudget.maxResultChars)
      const complete = page.nextOffset >= allItems.length
      const nextCursor = complete
        ? null
        : this.createCursor(context, {
            scopeId: scope.scopeId,
            bookIdentity: scope.bookIdentity,
            path,
            maxChars,
            query,
            version,
            offset: page.nextOffset,
            kind: query ? 'search' : 'directory'
          })
      return {
        data: {
          kind: query ? 'search' : 'directory',
          resultType: query ? 'document_search' : 'document_directory',
          path,
          ...(query ? { query } : {}),
          items: page.items,
          complete,
          nextCursor
        },
        references: [],
        truncated: !complete
      }
    }

    if (query) fail('QUERY_NOT_APPLICABLE', 'query 只能用于目录或集合')
    const view = await this.readView(path, bookKey, scope)
    if (view) {
      if (cursor && cursor.kind !== 'view') fail('CURSOR_INVALID', 'cursor 类型与当前读取不一致')
      const version = hash(JSON.stringify(view))
      if (cursor?.version && cursor.version !== version)
        fail('READ_VERSION_CHANGED', '只读视图版本已变化，请从第一页重新读取', {
          retryable: true
        })
      const start = cursor?.offset || 0
      if (start > view.items.length) fail('CURSOR_INVALID', 'cursor 位置超出当前视图')
      const page = pageItems(view.items, start, maxChars, this.readBudget.maxResultChars)
      const complete = page.nextOffset >= view.items.length
      const nextCursor =
        page.nextOffset >= view.items.length
          ? null
          : this.createCursor(context, {
              scopeId: scope.scopeId,
              bookIdentity: scope.bookIdentity,
              path,
              maxChars,
              query: '',
              version,
              offset: page.nextOffset,
              kind: 'view'
            })
      return {
        data: {
          ...view,
          items: page.items,
          resultType: 'document_view',
          complete,
          sourceTruncated: Boolean(view.truncated),
          nextCursor
        },
        references: [],
        truncated: !complete || Boolean(view.truncated)
      }
    }
    const snapshot = await this.fileSnapshot(scope, path, bookKey)
    if (!snapshot) fail('DOCUMENT_NOT_FOUND', '虚拟资源不存在')
    this.rememberSnapshot(scope, snapshot)
    if (cursor && cursor.kind !== 'file') fail('CURSOR_INVALID', 'cursor 类型与当前读取不一致')
    if (cursor?.version && cursor.version !== snapshot.savedHash)
      fail('READ_VERSION_CHANGED', '文档版本已变化，请从头重新读取', { retryable: true })
    const start = cursor?.offset || 0
    if (start > snapshot.text.length) fail('CURSOR_INVALID', 'cursor 位置超出当前文档')
    // Only expand a read when the host provides room for the serialized result.
    // Explicit page sizes and batch reads retain their existing pagination.
    const canReadWhole = !cursor && context.wholeDocumentTask && args.maxChars === undefined &&
      snapshot.text.length <= this.readBudget.maxWholeDocumentChars &&
      Buffer.byteLength(JSON.stringify(snapshot.text.slice(start)), 'utf8') + 5000 <= (context.fullReadBudgetBytes || 0)
    const end = safeSliceEnd(snapshot.text, start, canReadWhole ? snapshot.text.length : maxChars)
    const complete = end >= snapshot.text.length
    const nextCursor = complete
      ? null
      : this.createCursor(context, {
          scopeId: scope.scopeId,
          bookIdentity: scope.bookIdentity,
          path,
          maxChars,
          query: '',
          version: snapshot.savedHash,
          offset: end,
          kind: 'file'
        })
    const evidenceEligible = !['help', 'conversation'].includes(snapshot.sourceType)
    const reference = snapshot.reference
    const result = {
      data: {
        readingNotice: complete && start === 0
          ? `已返回全文，共 ${snapshot.text.length} 字符。`
          : `本次仅返回字符范围 [${start}, ${end})，全文 ${snapshot.text.length} 字符。${complete ? '已到末尾；是否覆盖全文请核对此前各页。' : `尚余 ${snapshot.text.length - end} 字符；整篇整理必须用 nextCursor 继续 read，不能把本页当作全文。`}`,
        kind: snapshot.sourceType === 'help' ? 'help' : 'file',
        resultType: 'document_read',
        path,
        title: snapshot.title,
        text: snapshot.text.slice(start, end),
        links: this.documentLinks(scope, snapshot, snapshot.text.slice(start, end)),
        sourceType: snapshot.sourceType,
        objectId: snapshot.objectId,
        savedHash: snapshot.savedHash,
        authorityStatus: snapshot.authorityStatus,
        evidenceEligible,
        returnedCoverage: {
          startOffset: start,
          endOffset: end,
          totalChars: snapshot.text.length,
          complete: start === 0 && complete
        },
        complete,
        pageReachedEnd: complete,
        returnedWholeDocument: start === 0 && complete,
        nextCursor,
        ...(reference && evidenceEligible ? { views: this.viewPaths(reference) } : {})
      },
      references: reference ? [reference] : [],
      truncated: !complete
    }
    if (includeRelatedDocuments) this.attachRelatedDocuments(context, result)
    if (canReadWhole && (Buffer.byteLength(JSON.stringify(result), 'utf8') + 512 > context.fullReadBudgetBytes || JSON.stringify(result).length + 512 > this.readBudget.maxResultChars)) {
      return this.read(context, { ...args, maxChars }, includeRelatedDocuments)
    }
    return result
  }
}

export { normalizeVirtualPath, safeSliceEnd, encodeViewReference, decodeViewReference }
export default BookDocumentService
