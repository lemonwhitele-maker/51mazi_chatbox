import fs from 'node:fs'
import crypto from 'node:crypto'
import { dirname, join } from 'node:path'
import { parseSourceReference } from './bookSavedSnapshotService.js'
import {
  KNOWLEDGE_CATALOG_SCHEMA_VERSION,
  normalizeCatalogName
} from './bookKnowledgeCatalogService.js'

export const BOOK_REFERENCE_INDEX_SCHEMA_VERSION = 2
const REFERENCE_FILE = join('.51mazi', 'index', 'v2', 'references.catalog.json')

function keyOf(type, id) {
  return `${type}:${id}`
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

function lineAt(source, offset) {
  return String(source || '')
    .slice(0, offset)
    .split(/\r\n|\n|\r/).length
}

function findOccurrences(source, needle) {
  const normalizedSource = String(source || '').toLocaleLowerCase('zh-CN')
  const normalizedNeedle = String(needle || '').toLocaleLowerCase('zh-CN')
  if (!normalizedNeedle) return []
  const occurrences = []
  let start = 0
  while (occurrences.length < 100) {
    const index = normalizedSource.indexOf(normalizedNeedle, start)
    if (index < 0) break
    occurrences.push(index)
    start = index + Math.max(1, normalizedNeedle.length)
  }
  return occurrences
}

function sectionForLine(entry, line) {
  return (
    (entry.sections || []).find((section) => line >= section.startLine && line <= section.endLine)
      ?.key || ''
  )
}

function sourceBody(snapshot) {
  if (!snapshot.parsed) return { text: snapshot.source, offset: 0 }
  const offset = snapshot.parsed.frontmatter?.end || 0
  return { text: snapshot.source.slice(offset), offset }
}

export class BookReferenceIndexService {
  constructor({ snapshotService, catalogService } = {}) {
    if (!snapshotService || !catalogService)
      throw new TypeError('snapshotService and catalogService are required')
    this.snapshotService = snapshotService
    this.catalogService = catalogService
    this.memory = new Map()
  }

  indexPath(bookName) {
    const bookPath = this.snapshotService.resolveBookPath(bookName)
    return this.snapshotService.resolveInside(bookPath, REFERENCE_FILE, '引用索引')
  }

  catalogFingerprint(catalogs) {
    return Object.fromEntries(
      Object.entries(catalogs).map(([scope, catalog]) => [scope, catalog.sourceFingerprint])
    )
  }

  readStored(bookName, fingerprint) {
    const path = this.indexPath(bookName)
    if (!fs.existsSync(path)) return null
    try {
      const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
      if (
        parsed?.schemaVersion !== BOOK_REFERENCE_INDEX_SCHEMA_VERSION ||
        parsed?.catalogSchemaVersion !== KNOWLEDGE_CATALOG_SCHEMA_VERSION ||
        JSON.stringify(parsed.catalogFingerprint) !== JSON.stringify(fingerprint) ||
        !Array.isArray(parsed.references)
      )
        return null
      return parsed
    } catch {
      return null
    }
  }

  buildIndex(bookName, { force = false } = {}) {
    const catalogs = this.catalogService.getAllCatalogs(bookName)
    const fingerprint = this.catalogFingerprint(catalogs)
    const stored = force ? null : this.readStored(bookName, fingerprint)
    if (stored) {
      this.memory.set(String(bookName), stored)
      return stored
    }

    const entries = Object.values(catalogs).flatMap((catalog) => catalog.entries)
    const targets = new Map()
    const names = new Map()
    for (const entry of entries) {
      const targetKey = keyOf(entry.type, entry.id)
      if (!targets.has(targetKey)) targets.set(targetKey, [])
      targets.get(targetKey).push(entry)
      for (const name of [entry.title, ...(entry.aliases || [])]) {
        const normalized = normalizeCatalogName(name)
        if (!normalized || normalized.length < 2) continue
        if (!names.has(normalized)) names.set(normalized, { labels: new Set(), targets: new Map() })
        const record = names.get(normalized)
        record.labels.add(String(name))
        record.targets.set(targetKey, entry)
      }
    }

    const references = []
    const dangling = []
    const ambiguities = []
    for (const sourceEntry of entries) {
      const snapshot = this.catalogService.readEntry(bookName, sourceEntry)
      const explicit = this.catalogService.referenceLocations(bookName, sourceEntry)
      const explicitRanges = explicit.map((reference) => [reference.start, reference.end])
      const explicitTargets = new Set()
      for (const reference of explicit) {
        const targetKey = keyOf(reference.sourceType, reference.targetId)
        explicitTargets.add(targetKey)
        const matches = targets.get(targetKey) || []
        const resolution =
          matches.length === 1 ? 'resolved' : matches.length ? 'duplicate' : 'dangling'
        const item = {
          kind: 'explicit_ref',
          source: {
            type: sourceEntry.type,
            id: sourceEntry.id,
            path: sourceEntry.path,
            section: reference.section || '',
            line: reference.line,
            contentHash: sourceEntry.fileHash
          },
          target: {
            type: reference.sourceType,
            id: reference.targetId,
            candidateIds: matches.map((entry) => entry.id)
          },
          label: reference.label || '',
          raw: reference.raw,
          resolution
        }
        references.push(item)
        if (resolution === 'dangling') dangling.push(item)
        if (resolution === 'duplicate') ambiguities.push(item)
      }
      for (const rawTarget of sourceEntry.outgoingRefs || []) {
        const separator = rawTarget.indexOf(':')
        if (separator < 1 || explicitTargets.has(rawTarget)) continue
        const targetType = rawTarget.slice(0, separator)
        const targetId = rawTarget.slice(separator + 1)
        const matches = targets.get(rawTarget) || []
        const resolution =
          matches.length === 1 ? 'resolved' : matches.length ? 'duplicate' : 'dangling'
        const item = {
          kind: 'explicit_ref',
          source: {
            type: sourceEntry.type,
            id: sourceEntry.id,
            path: sourceEntry.path,
            section: 'frontmatter',
            line: 1,
            contentHash: sourceEntry.fileHash
          },
          target: {
            type: targetType,
            id: targetId,
            candidateIds: matches.map((entry) => entry.id)
          },
          label: '',
          raw: rawTarget,
          resolution
        }
        references.push(item)
        if (resolution === 'dangling') dangling.push(item)
        if (resolution === 'duplicate') ambiguities.push(item)
      }

      const body = sourceBody(snapshot)
      for (const { labels, targets: namedTargets } of names.values()) {
        const label = [...labels].sort((a, b) => b.length - a.length)[0]
        const occurrences = findOccurrences(body.text, label)
        if (!occurrences.length) continue
        const candidates = [...namedTargets.entries()].filter(
          ([targetKey]) => targetKey !== keyOf(sourceEntry.type, sourceEntry.id)
        )
        if (!candidates.length) continue
        for (const occurrence of occurrences) {
          const absoluteStart = body.offset + occurrence
          if (explicitRanges.some(([start, end]) => absoluteStart >= start && absoluteStart < end))
            continue
          const line = lineAt(snapshot.source, absoluteStart)
          const item = {
            kind: 'text_match',
            source: {
              type: sourceEntry.type,
              id: sourceEntry.id,
              path: sourceEntry.path,
              section: sectionForLine(sourceEntry, line),
              line,
              contentHash: sourceEntry.fileHash
            },
            target: {
              type: candidates.length === 1 ? candidates[0][1].type : '',
              id: candidates.length === 1 ? candidates[0][1].id : '',
              candidateIds: candidates.map(([targetKey]) => targetKey)
            },
            label,
            resolution: candidates.length === 1 ? 'weak_unique' : 'ambiguous'
          }
          references.push(item)
          if (candidates.length > 1) ambiguities.push(item)
        }
      }
    }

    const outgoing = {}
    const backlinks = {}
    for (const reference of references) {
      const sourceKey = keyOf(reference.source.type, reference.source.id)
      if (!outgoing[sourceKey]) outgoing[sourceKey] = []
      outgoing[sourceKey].push(reference)
      if (reference.target.type && reference.target.id) {
        const targetKey = keyOf(reference.target.type, reference.target.id)
        if (!backlinks[targetKey]) backlinks[targetKey] = []
        backlinks[targetKey].push(reference)
      }
    }

    const duplicateIds = [...targets.entries()]
      .filter(([, matches]) => matches.length > 1)
      .map(([key, matches]) => ({
        code: 'REFERENCE_DUPLICATE_ID',
        key,
        paths: matches.map((entry) => entry.path)
      }))
    const index = {
      schemaVersion: BOOK_REFERENCE_INDEX_SCHEMA_VERSION,
      catalogSchemaVersion: KNOWLEDGE_CATALOG_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      catalogFingerprint: fingerprint,
      references,
      outgoing,
      backlinks,
      dangling,
      ambiguities,
      diagnostics: duplicateIds,
      stats: {
        total: references.length,
        explicit: references.filter((item) => item.kind === 'explicit_ref').length,
        textMatches: references.filter((item) => item.kind === 'text_match').length,
        dangling: dangling.length,
        ambiguous: ambiguities.length
      }
    }
    atomicWriteJson(this.indexPath(bookName), index)
    this.memory.set(String(bookName), index)
    return index
  }

  getIndex(bookName) {
    return this.buildIndex(bookName)
  }

  readBacklinks(bookName, reference, { includeWeak = true, limit = 50 } = {}) {
    const parsed = typeof reference === 'string' ? parseSourceReference(reference) : reference
    const index = this.getIndex(bookName)
    const key = keyOf(parsed.sourceType, parsed.targetId)
    const all = (index.backlinks[key] || []).filter(
      (item) => includeWeak || item.kind === 'explicit_ref'
    )
    const bounded = all.slice(0, Math.min(200, Math.max(1, Number(limit) || 50)))
    return {
      reference: key,
      target: { type: parsed.sourceType, id: parsed.targetId },
      backlinks: bounded,
      dangling: index.dangling.filter(
        (item) => item.target.type === parsed.sourceType && item.target.id === parsed.targetId
      ),
      truncated: bounded.length < all.length,
      generatedAt: index.generatedAt
    }
  }

  invalidate(bookName) {
    this.memory.delete(String(bookName || ''))
  }
}

export default BookReferenceIndexService
