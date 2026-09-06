import { makeSourceReference } from './bookSavedSnapshotService.js'

const DEFAULT_LIMIT = 8
const MAX_SNIPPET = 360
const MAX_TOTAL = 6000
function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, '')
}

function truncate(value, maxLength) {
  const text = String(value || '')
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function cjkNgrams(value) {
  const chars = [...String(value || '')].filter((char) => /\p{Script=Han}/u.test(char))
  const result = []
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index <= chars.length - size; index += 1)
      result.push(chars.slice(index, index + size).join(''))
  }
  return result
}

function queryTerms(query) {
  const normalized = String(query || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
  const terms = new Set()
  for (const word of normalized.match(/[a-z0-9][a-z0-9._-]*/gi) || []) terms.add(word)
  for (const term of cjkNgrams(normalized)) terms.add(term)
  const compact = normalizeSearchText(normalized)
  if (compact) terms.add(compact)
  return [...terms].sort((a, b) => b.length - a.length)
}

function chapterChunks(snapshot, descriptor) {
  const lines = snapshot.content.split('\n')
  const chunks = []
  const maxChars = 1000
  let start = 0
  let buffer = ''
  for (let index = 0; index < lines.length; index += 1) {
    buffer += `${buffer ? '\n' : ''}${lines[index]}`
    const isBoundary =
      /^\s*$/.test(lines[index]) || buffer.length >= maxChars || index === lines.length - 1
    if (!isBoundary) continue
    if (buffer.trim()) {
      chunks.push({
        text: buffer.trim(),
        location: { startLine: start + 1, endLine: index + 1 },
        ordinal: chunks.length
      })
    }
    const overlapStart = Math.max(start, index)
    start = overlapStart
    buffer = lines
      .slice(start, index + 1)
      .join('\n')
      .trim()
    if (buffer.length >= maxChars) {
      buffer = ''
      start = index + 1
    }
  }
  if (!chunks.length && snapshot.content.trim())
    chunks.push({
      text: snapshot.content.trim(),
      location: { startLine: 1, endLine: lines.length },
      ordinal: 0
    })
  return chunks.map((chunk) => ({
    ...chunk,
    sourceType: 'chapter',
    targetId: descriptor.targetId,
    reference: makeSourceReference({
      sourceType: 'chapter',
      targetId: descriptor.targetId,
      location: `L${chunk.location.startLine}-${chunk.location.endLine}`,
      contentHash: snapshot.rawHash
    }),
    title: descriptor.title,
    normalizedText: normalizeSearchText(chunk.text),
    aliases: [],
    authorityStatus: 'authoritative_saved',
    contentHash: snapshot.rawHash,
    savedAt: snapshot.savedAt,
    metadata: {
      volumeName: descriptor.volumeName,
      chapterName: descriptor.chapterName,
      ...chunk.location
    }
  }))
}

function makeChunk({
  sourceType,
  targetId,
  title,
  text,
  aliases = [],
  reference,
  contentHash = '',
  authorityStatus,
  savedAt = null,
  metadata = {},
  ordinal = 0
}) {
  return {
    chunkId: `${sourceType}:${targetId}:${ordinal}:${contentHash}`,
    bookKey: '',
    sourceType,
    targetId,
    reference,
    title,
    text: String(text || '').trim(),
    normalizedText: normalizeSearchText(text),
    aliases: aliases.map((item) => String(item || '').trim()).filter(Boolean),
    authorityStatus,
    contentHash,
    ordinal,
    savedAt,
    metadata
  }
}

function snippetFor(text, query, terms) {
  const source = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  const normalizedSource = normalizeSearchText(source)
  const normalizedQuery = normalizeSearchText(query)
  let index = normalizedQuery ? normalizedSource.indexOf(normalizedQuery) : -1
  if (index < 0) {
    const term = terms.find((item) => item.length > 1 && normalizedSource.includes(item))
    index = term ? normalizedSource.indexOf(term) : -1
  }
  if (index < 0) return truncate(source, MAX_SNIPPET)
  // For display we locate the same term in the un-normalized text when possible.
  const displayTerm =
    terms.find((item) => source.toLocaleLowerCase('en-US').includes(item)) ||
    String(query || '').trim()
  const displayIndex = displayTerm
    ? source.toLocaleLowerCase('en-US').indexOf(displayTerm.toLocaleLowerCase('en-US'))
    : index
  const start = Math.max(0, displayIndex - 100)
  const end = Math.min(source.length, displayIndex + Math.max(displayTerm.length, 20) + 180)
  return `${start ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`.slice(
    0,
    MAX_SNIPPET
  )
}

function scoreChunk(chunk, query, terms) {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return null
  const title = normalizeSearchText(chunk.title)
  const aliases = chunk.aliases.map(normalizeSearchText)
  const matchedTerms = terms.filter(
    (term) =>
      chunk.normalizedText.includes(term) ||
      title.includes(term) ||
      aliases.some((alias) => alias.includes(term))
  )
  const exact = chunk.normalizedText.includes(normalizedQuery)
  if (!exact && !matchedTerms.length) return null
  let score = exact ? 0.65 : 0.15
  score += Math.min(0.25, (matchedTerms.length / Math.max(terms.length, 1)) * 0.25)
  if (title.includes(normalizedQuery)) score += 0.3
  if (aliases.some((alias) => alias.includes(normalizedQuery))) score += 0.2
  if (
    chunk.sourceType === 'character' &&
    (title.includes(normalizedQuery) || aliases.some((alias) => alias.includes(normalizedQuery)))
  )
    score += 0.08
  return { score: Math.min(1, score), matchedTerms }
}

function scoreRegexChunk(chunk, expression) {
  expression.lastIndex = 0
  const searchable = `${chunk.title}\n${chunk.aliases.join('\n')}\n${chunk.text}`
  const match = expression.exec(searchable)
  if (!match) return null
  const inTitle = expression.test(String(chunk.title || ''))
  expression.lastIndex = 0
  return { score: inTitle ? 0.95 : 0.75, matchedTerms: [match[0]].filter(Boolean) }
}

function knowledgeDocumentChunks(catalogService, bookName, entry) {
  const snapshot = catalogService.readEntry(bookName, entry)
  const parsed = snapshot.parsed
  const common = {
    sourceType: entry.type,
    targetId: entry.id,
    aliases: [...(entry.aliases || []), ...(entry.tags || [])],
    contentHash: snapshot.fileHash,
    authorityStatus: entry.authorityStatus,
    savedAt: snapshot.savedAt
  }
  if (!parsed?.sections?.length) {
    return [
      makeChunk({
        ...common,
        title: entry.title,
        text: snapshot.source,
        reference: makeSourceReference({
          sourceType: entry.type,
          targetId: entry.id,
          location: 'document',
          contentHash: snapshot.fileHash
        }),
        metadata: {
          path: entry.path,
          kind: entry.kind || null,
          status: entry.status || null,
          tags: entry.tags || [],
          outgoingRefs: entry.outgoingRefs || [],
          ambiguous: Boolean(entry.ambiguous),
          ambiguousNames: entry.ambiguousNames || []
        }
      })
    ]
  }
  return parsed.sections.map((section, ordinal) =>
    makeChunk({
      ...common,
      title: `${entry.title} / ${section.title}`,
      text: `${section.title}\n${section.content}`,
      reference: makeSourceReference({
        sourceType: entry.type,
        targetId: entry.id,
        location: section.key,
        contentHash: snapshot.fileHash
      }),
      metadata: {
        path: entry.path,
        section: section.key,
        heading: section.title,
        startLine: section.startLine,
        endLine: section.endLine,
        sectionHash: section.contentHash,
        kind: entry.kind || null,
        status: entry.status || null,
        tags: entry.tags || [],
        outgoingRefs: entry.outgoingRefs || [],
        ambiguous: Boolean(entry.ambiguous),
        ambiguousNames: entry.ambiguousNames || []
      },
      ordinal
    })
  )
}

export class BookSearchIndexService {
  constructor({ snapshotService, catalogService = null } = {}) {
    this.snapshotService = snapshotService
    this.catalogService = catalogService
    this.indexes = new Map()
  }

  buildIndex(bookName, scopes = ['chapters', 'characters', 'settings', 'outlines']) {
    const selected = new Set(
      Array.isArray(scopes) && scopes.length
        ? scopes
        : ['chapters', 'characters', 'settings', 'outlines']
    )
    const chunks = []
    const fingerprints = []
    const add = (chunk) => {
      if (!chunk?.text?.trim()) return
      chunk.bookKey = String(bookName)
      chunks.push(chunk)
    }

    const catalogEntries = (scope) =>
      this.catalogService ? this.catalogService.listEntries(bookName, scope) : []

    if (this.catalogService) {
      for (const scope of ['characters', 'settings', 'outlines']) {
        if (!selected.has(scope)) continue
        const entries = catalogEntries(scope)
        if (!entries.length) continue
        for (const entry of entries) {
          fingerprints.push(`${entry.type}:${entry.id}:${entry.fileHash}`)
          knowledgeDocumentChunks(this.catalogService, bookName, entry).forEach(add)
        }
      }
    }

    if (selected.has('chapters')) {
      for (const descriptor of this.snapshotService.listChapterDescriptors(bookName)) {
        const snapshot = this.snapshotService.readChapterSnapshot(bookName, descriptor.targetId)
        fingerprints.push(`chapter:${descriptor.targetId}:${snapshot.rawHash}`)
        chapterChunks(snapshot, descriptor).forEach((chunk) => add(chunk))
      }
    }

    if (selected.has('notes')) {
      try {
        const snapshot = this.snapshotService.readQuickNotesSnapshot(bookName)
        fingerprints.push(`note:${snapshot.rawHash}`)
        add(
          makeChunk({
            sourceType: 'note',
            targetId: snapshot.targetId,
            title: '助手速记',
            text: snapshot.content,
            reference: makeSourceReference({
              sourceType: 'note',
              targetId: snapshot.targetId,
              contentHash: snapshot.rawHash
            }),
            contentHash: snapshot.rawHash,
            authorityStatus: 'private_note',
            savedAt: snapshot.savedAt,
            metadata: { relativePath: snapshot.metadata.relativePath },
            ordinal: 0
          })
        )
      } catch {
        // 速记文件不存在时不影响正式来源检索。
      }
    }

    return {
      bookName,
      builtAt: new Date().toISOString(),
      fingerprints: fingerprints.sort(),
      chunks
    }
  }

  ensureIndex(bookName, scopes) {
    const key = String(bookName || '')
    const next = this.buildIndex(key, scopes)
    const previous = this.indexes.get(key)
    if (
      previous &&
      JSON.stringify(previous.fingerprints) === JSON.stringify(next.fingerprints) &&
      previous.scopes === JSON.stringify(scopes || [])
    )
      return previous
    next.scopes = JSON.stringify(scopes || [])
    this.indexes.set(key, next)
    return next
  }

  invalidate(bookName) {
    this.indexes.delete(String(bookName || ''))
  }

  search(bookName, query, options = {}) {
    const selectedScopes =
      Array.isArray(options.scopes) && options.scopes.length
        ? options.scopes
        : ['chapters', 'characters', 'settings', 'outlines']
    const index = this.ensureIndex(bookName, selectedScopes)
    const terms = queryTerms(query)
    const mode = ['literal', 'regex', 'semantic', 'hybrid'].includes(options.mode)
      ? options.mode
      : 'hybrid'
    let expression = null
    if (mode === 'regex') {
      try {
        expression = new RegExp(String(query), 'iu')
      } catch (error) {
        const invalid = new Error(`正则表达式无效：${error.message}`)
        invalid.code = 'BOOK_SEARCH_REGEX_INVALID'
        throw invalid
      }
    }
    const limit = Math.min(50, Math.max(1, Number(options.limit) || DEFAULT_LIMIT))
    const authorityFilter = new Set(options.filters?.authorityStatus || [])
    const sourceFilter = new Set(
      selectedScopes.map(
        (scope) =>
          ({
            chapters: 'chapter',
            characters: 'character',
            settings: 'setting',
            outlines: 'outline',
            notes: 'note'
          })[scope] || scope
      )
    )
    const headingFilter = normalizeSearchText(options.filters?.heading || '')
    const kindFilter = String(options.filters?.kind || '')
    const statusFilter = String(options.filters?.status || '')
    const referenceFilter = String(options.filters?.reference || '')
    const tagFilter = new Set(options.filters?.tags || [])
    const results = index.chunks
      .filter(
        (chunk) =>
          sourceFilter.has(chunk.sourceType) &&
          (!authorityFilter.size || authorityFilter.has(chunk.authorityStatus)) &&
          (!headingFilter ||
            normalizeSearchText(chunk.metadata?.heading).includes(headingFilter)) &&
          (!kindFilter || chunk.metadata?.kind === kindFilter) &&
          (!statusFilter || chunk.metadata?.status === statusFilter) &&
          (!referenceFilter || (chunk.metadata?.outgoingRefs || []).includes(referenceFilter)) &&
          (!tagFilter.size ||
            [...tagFilter].every((tag) => (chunk.metadata?.tags || []).includes(tag)))
      )
      .map((chunk) => {
        const scored = expression
          ? scoreRegexChunk(chunk, expression)
          : scoreChunk(chunk, query, terms)
        if (!scored) return null
        return {
          reference: chunk.reference,
          sourceType: chunk.sourceType,
          targetId: chunk.targetId,
          title: chunk.title,
          snippet: snippetFor(chunk.text, query, scored.matchedTerms),
          matchedTerms: scored.matchedTerms.slice(0, 12),
          authorityStatus: chunk.authorityStatus,
          contentHash: chunk.contentHash || null,
          savedAt: chunk.savedAt,
          score: Number(scored.score.toFixed(4)),
          location: chunk.metadata,
          ambiguous: Boolean(chunk.metadata?.ambiguous),
          ambiguousNames: chunk.metadata?.ambiguousNames || []
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title), 'zh-CN'))
      .slice(0, limit)
    let total = 0
    const boundedResults = []
    for (const result of results) {
      const size = JSON.stringify(result).length
      if (total + size > MAX_TOTAL && boundedResults.length) break
      boundedResults.push(result)
      total += size
    }
    return {
      results: boundedResults,
      truncated: boundedResults.length < results.length,
      builtAt: index.builtAt,
      mode
    }
  }
}

export default BookSearchIndexService
