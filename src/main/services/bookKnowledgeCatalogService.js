import fs from 'node:fs'
import crypto from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { makeSourceReference } from './bookSavedSnapshotService.js'
import { extractKnowledgeReferences, parseKnowledgeMarkdown } from './knowledgeMarkdownParser.js'

export const KNOWLEDGE_CATALOG_SCHEMA_VERSION = 3
export const KNOWLEDGE_CATALOG_SCOPES = Object.freeze([
  'chapters',
  'characters',
  'settings',
  'outlines',
  'notes'
])

const SCOPE_TYPE = Object.freeze({
  chapters: 'chapter',
  characters: 'character',
  settings: 'setting',
  outlines: 'outline',
  notes: 'note'
})
const TYPE_SCOPE = Object.freeze(
  Object.fromEntries(Object.entries(SCOPE_TYPE).map(([scope, type]) => [type, scope]))
)
const INDEX_ROOT = join('.51mazi', 'index', 'v2')
const KNOWLEDGE_ROOT = 'knowledge'

function hashBuffer(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function decodeUtf8(buffer) {
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
}

function toPosix(value) {
  return String(value || '').replaceAll('\\', '/')
}

function uniqueStrings(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean)
    )
  ]
}

export function normalizeCatalogName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}_]+/gu, '')
}

function walkFiles(rootPath, predicate, result = []) {
  if (!fs.existsSync(rootPath)) return result
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const filePath = join(rootPath, entry.name)
    if (entry.isDirectory()) walkFiles(filePath, predicate, result)
    else if (entry.isFile() && predicate(entry.name)) result.push(filePath)
  }
  return result
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(temporary, filePath)
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    throw error
  }
}

function headingsFromPlainMarkdown(source) {
  const lines = String(source || '').split(/\r\n|\n|\r/)
  const headings = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index])
    if (!match) continue
    headings.push({ level: match[1].length, heading: match[2], startLine: index + 1 })
  }
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level)
    const endLine = next ? next.startLine - 1 : lines.length
    return {
      key: '',
      heading: heading.heading,
      startLine: heading.startLine,
      endLine,
      contentHash: hashBuffer(Buffer.from(lines.slice(heading.startLine - 1, endLine).join('\n')))
    }
  })
}

function sectionForLine(sections, line) {
  return sections.find((section) => line >= section.startLine && line <= section.endLine)?.key || ''
}

function entryLookup(entries) {
  const lookup = {}
  for (const entry of entries) {
    for (const name of [entry.title, ...(entry.aliases || [])]) {
      const normalized = normalizeCatalogName(name)
      if (!normalized) continue
      if (!lookup[normalized]) lookup[normalized] = []
      if (!lookup[normalized].includes(entry.id)) lookup[normalized].push(entry.id)
    }
  }
  return Object.fromEntries(Object.entries(lookup).sort(([a], [b]) => a.localeCompare(b)))
}

function duplicateDiagnostics(entries, lookup) {
  const diagnostics = []
  const byId = new Map()
  for (const entry of entries) {
    if (!byId.has(entry.id)) byId.set(entry.id, [])
    byId.get(entry.id).push(entry.path)
  }
  for (const [id, paths] of byId) {
    if (paths.length > 1)
      diagnostics.push({ code: 'CATALOG_DUPLICATE_ID', id, paths, severity: 'error' })
  }
  for (const [name, ids] of Object.entries(lookup)) {
    if (ids.length > 1)
      diagnostics.push({
        code: 'CATALOG_AMBIGUOUS_NAME',
        normalizedName: name,
        ids,
        severity: 'warning'
      })
  }
  return diagnostics
}

export class BookKnowledgeCatalogService {
  constructor({ snapshotService } = {}) {
    if (!snapshotService) throw new TypeError('snapshotService is required')
    this.snapshotService = snapshotService
    this.memory = new Map()
  }

  indexPath(bookName, scope) {
    const bookPath = this.snapshotService.resolveBookPath(bookName)
    return this.snapshotService.resolveInside(
      bookPath,
      join(INDEX_ROOT, `${scope}.catalog.json`),
      '知识目录索引'
    )
  }

  sourceFiles(bookName, scope) {
    if (!KNOWLEDGE_CATALOG_SCOPES.includes(scope))
      throw new Error(`不支持的 Catalog scope：${scope}`)
    const bookPath = this.snapshotService.resolveBookPath(bookName)
    if (scope === 'chapters') {
      return walkFiles(join(bookPath, '正文'), (name) => /\.txt$/i.test(name))
    }
    if (scope === 'notes') {
      const notePath = join(bookPath, '.51mazi', 'notes', 'quick-notes.md')
      return fs.existsSync(notePath) ? [notePath] : []
    }
    return walkFiles(join(bookPath, KNOWLEDGE_ROOT, scope), (name) => /\.md$/i.test(name))
  }

  signatures(bookName, scope) {
    const bookPath = this.snapshotService.resolveBookPath(bookName)
    return this.sourceFiles(bookName, scope)
      .map((filePath) => {
        const stat = fs.statSync(filePath)
        return {
          path: toPosix(relative(bookPath, filePath)),
          size: stat.size,
          mtimeMs: stat.mtimeMs
        }
      })
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
  }

  readStoredCatalog(bookName, scope) {
    const filePath = this.indexPath(bookName, scope)
    if (!fs.existsSync(filePath)) return null
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (
        parsed?.schemaVersion !== KNOWLEDGE_CATALOG_SCHEMA_VERSION ||
        parsed?.scope !== scope ||
        !Array.isArray(parsed?.entries) ||
        !Array.isArray(parsed?.sourceSignatures)
      )
        return null
      return parsed
    } catch {
      return null
    }
  }

  makeEntry(bookName, scope, filePath) {
    const bookPath = this.snapshotService.resolveBookPath(bookName)
    const raw = fs.readFileSync(filePath)
    const source = decodeUtf8(raw)
    const stat = fs.statSync(filePath)
    const path = toPosix(relative(bookPath, filePath))
    const fileHash = hashBuffer(raw)
    const type = SCOPE_TYPE[scope]

    if (scope === 'chapters') {
      const id = toPosix(relative(join(bookPath, '正文'), filePath))
      return {
        id,
        type,
        title:
          id
            .split('/')
            .pop()
            ?.replace(/\.txt$/i, '') || id,
        aliases: [],
        tags: [],
        path,
        fileHash,
        modifiedAt: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sections: headingsFromPlainMarkdown(source),
        outgoingRefs: uniqueStrings(
          extractKnowledgeReferences(source).map((item) => `${item.sourceType}:${item.targetId}`)
        ),
        status: 'confirmed',
        authorityStatus: 'authoritative_saved',
        sourceFormat: 'text'
      }
    }

    if (scope === 'notes') {
      return {
        id: 'quick-notes',
        type,
        title: '助手速记',
        aliases: [],
        tags: [],
        path,
        fileHash,
        modifiedAt: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sections: headingsFromPlainMarkdown(source),
        outgoingRefs: uniqueStrings(
          extractKnowledgeReferences(source).map((item) => `${item.sourceType}:${item.targetId}`)
        ),
        status: 'private',
        authorityStatus: 'private_note',
        sourceFormat: 'markdown'
      }
    }

    const parsed = parseKnowledgeMarkdown(source)
    const metadata = parsed.metadata || {}
    const id = String(metadata.id || '').trim() || path.split('/').pop().replace(/\.md$/i, '')
    const declaredType = String(metadata.type || type)
    const entry = {
      id,
      type,
      ...(declaredType !== type ? { declaredType } : {}),
      title: String(metadata.title || id),
      aliases: uniqueStrings(metadata.aliases),
      tags: uniqueStrings(metadata.tags),
      path,
      fileHash,
      modifiedAt: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sections: parsed.sections.map((section) => ({
        key: section.key,
        heading: section.title,
        startLine: section.startLine,
        endLine: section.endLine,
        contentHash: section.contentHash
      })),
      outgoingRefs: uniqueStrings(
        parsed.references.map((item) => `${item.sourceType}:${item.targetId}`)
      ),
      status: String(metadata.status || ''),
      authorityStatus: scope === 'outlines' ? 'planned_saved' : 'authoritative_saved',
      sourceFormat: 'markdown',
      diagnostics: [
        ...parsed.diagnostics,
        ...(declaredType !== type
          ? [
              {
                code: 'CATALOG_TYPE_MISMATCH',
                message: `文档 type ${declaredType} 与目录 ${type} 不一致`,
                severity: 'error'
              }
            ]
          : [])
      ]
    }
    if (scope === 'characters') entry.avatar = String(metadata.avatar || '').trim()
    if (scope === 'settings') entry.kind = String(metadata.kind || '')
    if (scope === 'outlines') {
      entry.order = typeof metadata.order === 'number' ? metadata.order : null
      entry.relatedOutlines = uniqueStrings(metadata.relatedOutlines)
      entry.chapterRefs = uniqueStrings(metadata.chapterRefs)
      entry.characterRefs = uniqueStrings(metadata.characterRefs)
      entry.settingRefs = uniqueStrings(metadata.settingRefs)
      entry.outgoingRefs = uniqueStrings([
        ...entry.outgoingRefs,
        ...entry.relatedOutlines.map((id) => (id.startsWith('outline:') ? id : `outline:${id}`)),
        ...entry.chapterRefs.map((id) => (id.startsWith('chapter:') ? id : `chapter:${id}`)),
        ...entry.characterRefs.map((id) => (id.startsWith('character:') ? id : `character:${id}`)),
        ...entry.settingRefs.map((id) => (id.startsWith('setting:') ? id : `setting:${id}`))
      ])
    }
    return entry
  }

  buildCatalog(bookName, scope, { force = false } = {}) {
    const signatures = this.signatures(bookName, scope)
    const stored = force ? null : this.readStoredCatalog(bookName, scope)
    if (stored && JSON.stringify(stored.sourceSignatures) === JSON.stringify(signatures)) {
      this.memory.set(`${bookName}:${scope}`, stored)
      return stored
    }

    const bookPath = this.snapshotService.resolveBookPath(bookName)
    const previousByPath = new Map((stored?.entries || []).map((entry) => [entry.path, entry]))
    const previousSignature = new Map(
      (stored?.sourceSignatures || []).map((signature) => [signature.path, signature])
    )
    const entries = []
    let reusedEntries = 0
    for (const signature of signatures) {
      const previous = previousSignature.get(signature.path)
      const reusable =
        previous &&
        previous.size === signature.size &&
        previous.mtimeMs === signature.mtimeMs &&
        previousByPath.has(signature.path)
      if (reusable) {
        entries.push(previousByPath.get(signature.path))
        reusedEntries += 1
      } else {
        entries.push(
          this.makeEntry(
            bookName,
            scope,
            this.snapshotService.resolveInside(bookPath, signature.path, 'Catalog 来源')
          )
        )
      }
    }
    entries.sort(
      (a, b) =>
        String(a.title).localeCompare(String(b.title), 'zh-CN') ||
        String(a.id).localeCompare(String(b.id))
    )
    const lookup = entryLookup(entries)
    for (const entry of entries) {
      entry.ambiguousNames = [entry.title, ...(entry.aliases || [])]
        .map(normalizeCatalogName)
        .filter(
          (name, index, all) => name && all.indexOf(name) === index && lookup[name]?.length > 1
        )
      entry.ambiguous = entry.ambiguousNames.length > 0
    }
    const catalog = {
      schemaVersion: KNOWLEDGE_CATALOG_SCHEMA_VERSION,
      scope,
      type: SCOPE_TYPE[scope],
      generatedAt: new Date().toISOString(),
      sourceSignatures: signatures,
      sourceFingerprint: hashBuffer(Buffer.from(JSON.stringify(signatures))),
      entries,
      lookup,
      diagnostics: duplicateDiagnostics(entries, lookup),
      stats: {
        total: entries.length,
        rebuiltEntries: entries.length - reusedEntries,
        reusedEntries,
        deletedEntries: Math.max(0, (stored?.entries?.length || 0) - reusedEntries)
      }
    }
    atomicWriteJson(this.indexPath(bookName, scope), catalog)
    this.memory.set(`${bookName}:${scope}`, catalog)
    return catalog
  }

  getCatalog(bookName, scope) {
    return this.buildCatalog(bookName, scope)
  }

  rebuildBook(bookName, scopes = KNOWLEDGE_CATALOG_SCOPES) {
    const result = {}
    for (const scope of scopes) result[scope] = this.buildCatalog(bookName, scope, { force: true })
    return result
  }

  getAllCatalogs(bookName) {
    return Object.fromEntries(
      KNOWLEDGE_CATALOG_SCOPES.map((scope) => [scope, this.getCatalog(bookName, scope)])
    )
  }

  listEntries(bookName, scope) {
    return this.getCatalog(bookName, scope).entries
  }

  listCharacterProfiles(bookName) {
    const profiles = []
    for (const entry of this.listEntries(bookName, 'characters')) {
      try {
        const snapshot = this.readEntry(bookName, entry)
        const metadata = snapshot.parsed?.metadata || {}
        const section = (key) => String(snapshot.parsed?.sectionMap?.[key]?.content || '').trim()
        const markerColor = String(metadata.markerColor || metadata.marker_color || '').trim()
        const avatar = String(metadata.avatar || '').trim()
        profiles.push({
          id: entry.id,
          name: entry.title,
          aliases: entry.aliases || [],
          tags: entry.tags || [],
          status: entry.status || '',
          summary: section('summary'),
          arc: section('current-state'),
          notes: section('facts'),
          markdownFile: entry.path,
          contentVersion: entry.fileHash,
          ...(markerColor ? { markerColor } : {}),
          ...(avatar ? { avatar } : {})
        })
      } catch {
        // 损坏的单个人物文档由 Catalog 诊断，不阻断其余人物用于高亮和关系视图。
      }
    }
    return profiles
  }

  queryEntries(bookName, scope, filters = {}) {
    return this.listEntries(bookName, scope).filter(
      (entry) =>
        (!filters.id || entry.id === filters.id) &&
        (!filters.kind || entry.kind === filters.kind) &&
        (!filters.status || entry.status === filters.status) &&
        (!filters.tags?.length || filters.tags.every((tag) => entry.tags.includes(tag))) &&
        (!filters.reference || entry.outgoingRefs.includes(filters.reference)) &&
        (!filters.chapterRef ||
          (entry.chapterRefs || []).some(
            (item) => item === filters.chapterRef || `chapter:${item}` === filters.chapterRef
          )) &&
        (!filters.relatedOutline ||
          (entry.relatedOutlines || []).some(
            (item) =>
              item === filters.relatedOutline || `outline:${item}` === filters.relatedOutline
          ))
    )
  }

  findEntries(bookName, sourceType, targetId) {
    const scope = TYPE_SCOPE[String(sourceType || '')]
    if (!scope) return []
    return this.listEntries(bookName, scope).filter((entry) => entry.id === String(targetId || ''))
  }

  resolveName(bookName, scope, name, filters = {}) {
    const catalog = this.getCatalog(bookName, scope)
    const ids = catalog.lookup[normalizeCatalogName(name)] || []
    return catalog.entries.filter(
      (entry) =>
        ids.includes(entry.id) &&
        (!filters.kind || entry.kind === filters.kind) &&
        (!filters.tags?.length || filters.tags.every((tag) => entry.tags.includes(tag)))
    )
  }

  readEntry(bookName, entry) {
    const bookPath = this.snapshotService.resolveBookPath(bookName)
    const filePath = this.snapshotService.resolveInside(bookPath, entry.path, 'Catalog 来源')
    const raw = fs.readFileSync(filePath)
    const source = decodeUtf8(raw)
    const stat = fs.statSync(filePath)
    return {
      entry,
      filePath,
      source,
      raw,
      fileHash: hashBuffer(raw),
      savedAt: stat.mtime.toISOString(),
      parsed:
        entry.sourceFormat === 'markdown' &&
        ['character', 'setting', 'outline'].includes(entry.type)
          ? parseKnowledgeMarkdown(source)
          : null
    }
  }

  referenceLocations(bookName, entry) {
    const snapshot = this.readEntry(bookName, entry)
    const references = extractKnowledgeReferences(snapshot.source)
    return references.map((reference) => ({
      ...reference,
      section: sectionForLine(entry.sections || [], reference.line)
    }))
  }

  descriptor(entry) {
    return {
      sourceType: entry.type,
      targetId: entry.id,
      reference: makeSourceReference({
        sourceType: entry.type,
        targetId: entry.id,
        location: entry.type === 'note' ? '' : 'document',
        contentHash: entry.fileHash
      }),
      title: entry.title,
      aliases: entry.aliases,
      tags: entry.tags,
      status: entry.status,
      kind: entry.kind,
      ...(entry.type === 'character' ? { avatar: entry.avatar || '' } : {}),
      order: entry.order,
      relatedOutlines: entry.relatedOutlines,
      chapterRefs: entry.chapterRefs,
      characterRefs: entry.characterRefs,
      settingRefs: entry.settingRefs,
      sections: entry.sections,
      contentHash: entry.fileHash,
      savedAt: entry.modifiedAt,
      authorityStatus: entry.authorityStatus,
      path: entry.path,
      ambiguity: this.getCatalogEntryAmbiguity(entry)
    }
  }

  getCatalogEntryAmbiguity(entry) {
    return Boolean(entry?.ambiguous)
  }

  invalidate(bookName) {
    const prefix = `${bookName}:`
    for (const key of this.memory.keys()) if (key.startsWith(prefix)) this.memory.delete(key)
  }
}

export default BookKnowledgeCatalogService
