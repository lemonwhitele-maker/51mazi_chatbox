import { makeSourceReference, parseSourceReference } from './bookSavedSnapshotService.js'

const DEFAULT_MAX_CHARS = 20_000
const MAX_MAX_CHARS = 100_000

function clampChars(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_MAX_CHARS
  return Math.min(MAX_MAX_CHARS, Math.floor(numeric))
}

function truncate(value, maxChars) {
  const text = String(value || '')
  return text.length <= maxChars
    ? { text, truncated: false }
    : {
        text: `${text.slice(0, maxChars)}\n\n……内容已按预算截断……`,
        truncated: true
      }
}

function splitLines(content) {
  return String(content || '')
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
}

function lineWindow(content, startLine, endLine, before, after) {
  const lines = splitLines(content)
  const requestedStart = Math.max(1, Number(startLine) || 1)
  const requestedEnd = Math.min(
    lines.length,
    Math.max(requestedStart, Number(endLine) || requestedStart)
  )
  const windowStart = Math.max(1, requestedStart - Math.max(0, Number(before) || 0))
  const windowEnd = Math.min(lines.length, requestedEnd + Math.max(0, Number(after) || 0))
  return {
    content: lines.slice(windowStart - 1, windowEnd).join('\n'),
    startLine: windowStart,
    endLine: windowEnd,
    totalLines: lines.length,
    hasMoreBefore: windowStart > 1,
    hasMoreAfter: windowEnd < lines.length
  }
}

function markdownHeadingRange(source, heading) {
  const wanted = String(heading || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN')
  if (!wanted) return null
  const lines = splitLines(source)
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index])
    if (!match) continue
    const visible = match[2]
      .replace(/\s*<!--.*?-->\s*$/, '')
      .normalize('NFKC')
      .trim()
      .toLocaleLowerCase('zh-CN')
    if (visible !== wanted) continue
    const level = match[1].length
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = /^(#{1,6})\s+/.exec(lines[cursor])
      if (next && next[1].length <= level) {
        end = cursor
        break
      }
    }
    return { startLine: index + 1, endLine: end }
  }
  return null
}

function normalizeChapterRef(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    return raw.startsWith('chapter:') ? parseSourceReference(raw).targetId : raw
  } catch {
    return raw.replace(/^chapter:/, '')
  }
}

export class BookRetrievalService {
  constructor({
    snapshotService,
    searchIndexService,
    catalogService = null,
    referenceIndexService = null
  } = {}) {
    this.snapshotService = snapshotService
    this.searchIndexService = searchIndexService
    this.catalogService = catalogService
    this.referenceIndexService = referenceIndexService
  }

  listBookStructure(bookName, scopes, options = {}) {
    const selected =
      Array.isArray(scopes) && scopes.length
        ? scopes
        : ['chapters', 'characters', 'settings', 'outlines']
    const result = {
      success: true,
      bookName,
      generatedAt: new Date().toISOString(),
      scopes: selected,
      mode: options.mode === 'flat' ? 'flat' : 'grouped'
    }
    if (selected.includes('chapters'))
      result.chapters = this.snapshotService.listChapterDescriptors(bookName)
    if (selected.includes('notes')) {
      try {
        const note = this.snapshotService.readQuickNotesSnapshot(bookName)
        result.notes = [
          {
            sourceType: 'note',
            targetId: note.targetId,
            title: '助手速记',
            contentHash: note.rawHash,
            savedAt: note.savedAt
          }
        ]
      } catch {
        result.notes = []
      }
    }
    for (const scope of selected) {
      const entries = this.catalogService?.listEntries(bookName, scope) || []
      if (['characters', 'settings', 'outlines'].includes(scope)) {
        result[scope] = entries.map((entry) => this.catalogService.descriptor(entry))
      }
      if (scope === 'chapters') {
        const byId = new Map((result.chapters || []).map((item) => [item.targetId, item]))
        for (const entry of entries) {
          const existing = byId.get(entry.id) || {}
          byId.set(entry.id, { ...this.catalogService.descriptor(entry), ...existing })
        }
        result.chapters = [...byId.values()]
      }
      if (scope === 'notes' && entries.length) {
        result.notes = entries.map((entry) => this.catalogService.descriptor(entry))
      }
    }
    if (result.mode === 'flat') {
      result.items = selected.flatMap((scope) =>
        (result[scope] || []).map((item) => ({ ...item, scope }))
      )
    }
    return result
  }

  searchBookKnowledge(bookName, query, options = {}) {
    const normalizedQuery = String(query || '').trim()
    if (!normalizedQuery) return { success: true, results: [], truncated: false, builtAt: null }
    return {
      success: true,
      query: normalizedQuery,
      ...this.searchIndexService.search(bookName, normalizedQuery, options)
    }
  }

  readBookSource(bookName, reference, options = {}) {
    const rawReference = String(reference || '').trim()
    const parsed = parseSourceReference(rawReference)
    const maxChars = clampChars(options.maxChars)
    if (['character', 'setting', 'outline'].includes(parsed.sourceType) && this.catalogService) {
      const entries = this.catalogService.findEntries(bookName, parsed.sourceType, parsed.targetId)
      if (entries.length > 1) {
        const error = new Error('知识文档 ID 存在歧义，无法安全点读')
        error.code = 'KNOWLEDGE_ID_AMBIGUOUS'
        error.matches = entries.map((entry) => entry.path)
        throw error
      }
      if (entries.length === 1)
        return this.readKnowledgeDocument(bookName, parsed, entries[0], options, maxChars)
    }
    if (parsed.sourceType === 'chapter')
      return this.readChapter(bookName, parsed, options, maxChars)
    if (parsed.sourceType === 'note') return this.readNote(bookName, parsed, options, maxChars)
    if (['character', 'setting', 'outline'].includes(parsed.sourceType)) {
      const error = new Error('Markdown 知识文档不存在；旧人物 HTML/JSON 和树形大纲 JSON 已不再支持')
      error.code = 'KNOWLEDGE_DOCUMENT_NOT_FOUND'
      throw error
    }
    throw new Error('不支持的来源类型')
  }

  versionInfo(snapshot, location = '') {
    return {
      reference: makeSourceReference({
        sourceType: snapshot.sourceType,
        targetId: snapshot.targetId,
        location,
        contentHash: snapshot.contentHash || snapshot.rawHash
      }),
      sourceType: snapshot.sourceType,
      targetId: snapshot.targetId,
      contentHash: snapshot.contentHash || snapshot.rawHash || null,
      authorityStatus: snapshot.authorityStatus,
      savedAt: snapshot.savedAt,
      metadata: snapshot.metadata
    }
  }

  readChapter(bookName, parsed, options, maxChars) {
    const snapshot = this.snapshotService.readChapterSnapshot(bookName, parsed.targetId)
    const changed = Boolean(parsed.contentHash && parsed.contentHash !== snapshot.rawHash)
    const match = /^L(\d+)-(\d+)$/i.exec(parsed.location || '')
    const startLine = options.startLine || (match ? Number(match[1]) : 1)
    const endLine =
      options.endLine || (match ? Number(match[2]) : splitLines(snapshot.content).length)
    const window = lineWindow(snapshot.content, startLine, endLine, options.before, options.after)
    const bounded = truncate(window.content, maxChars)
    return {
      success: true,
      versionChanged: changed,
      source: this.versionInfo(snapshot, `L${window.startLine}-${window.endLine}`),
      content: bounded.text,
      truncated: bounded.truncated,
      hasMoreBefore: window.hasMoreBefore,
      hasMoreAfter: window.hasMoreAfter || bounded.truncated,
      location: { startLine: window.startLine, endLine: window.endLine },
      continueWith: {
        before: window.hasMoreBefore ? { endLine: window.startLine - 1 } : null,
        after: window.hasMoreAfter || bounded.truncated ? { startLine: window.endLine + 1 } : null
      },
      message: changed ? '正式版本已变化，以下为当前磁盘正式版本' : undefined
    }
  }

  readKnowledgeDocument(bookName, parsed, entry, options, maxChars) {
    const snapshot = this.catalogService.readEntry(bookName, entry)
    const changed = Boolean(parsed.contentHash && parsed.contentHash !== snapshot.fileHash)
    const source = snapshot.source
    const totalLines = splitLines(source).length
    let startLine = 1
    let endLine = totalLines
    let sectionKey = String(options.sectionKey || '').trim()
    let heading = String(options.heading || '').trim()
    const referenceLocation = String(parsed.location || '')
    const referenceRange = /^L(\d+)-(\d+)$/i.exec(referenceLocation)
    if (
      !sectionKey &&
      !heading &&
      referenceLocation &&
      referenceLocation !== 'document' &&
      !referenceRange
    )
      sectionKey = referenceLocation
    if (referenceRange) {
      startLine = Number(referenceRange[1])
      endLine = Number(referenceRange[2])
    }
    if (options.startLine) startLine = options.startLine
    if (options.endLine) endLine = options.endLine
    if (sectionKey) {
      const section = snapshot.parsed?.sectionMap?.[sectionKey]
      if (!section) throw new Error(`稳定 section 不存在：${sectionKey}`)
      startLine = section.startLine
      endLine = section.endLine
      heading = section.title
    } else if (heading) {
      const range = markdownHeadingRange(source, heading)
      if (!range) throw new Error(`Markdown heading 不存在：${heading}`)
      startLine = range.startLine
      endLine = range.endLine
    }
    const window = lineWindow(source, startLine, endLine, options.before, options.after)
    const bounded = truncate(window.content, maxChars)
    const sections = entry.sections || []
    const currentIndex = sectionKey
      ? sections.findIndex((section) => section.key === sectionKey)
      : sections.findIndex(
          (section) => startLine >= section.startLine && startLine <= section.endLine
        )
    const adjacentSections = []
    for (const index of [currentIndex - 1, currentIndex + 1]) {
      if (index < 0 || index >= sections.length) continue
      const adjacent = sections[index]
      adjacentSections.push({
        key: adjacent.key,
        heading: adjacent.heading,
        startLine: adjacent.startLine,
        endLine: adjacent.endLine,
        contentHash: adjacent.contentHash,
        reference: makeSourceReference({
          sourceType: entry.type,
          targetId: entry.id,
          location: adjacent.key,
          contentHash: snapshot.fileHash
        })
      })
    }
    return {
      success: true,
      versionChanged: changed,
      source: {
        reference: makeSourceReference({
          sourceType: entry.type,
          targetId: entry.id,
          location: sectionKey || `L${window.startLine}-${window.endLine}`,
          contentHash: snapshot.fileHash
        }),
        sourceType: entry.type,
        targetId: entry.id,
        contentHash: snapshot.fileHash,
        authorityStatus: entry.authorityStatus,
        savedAt: snapshot.savedAt,
        metadata: {
          title: entry.title,
          path: entry.path,
          status: entry.status,
          kind: entry.kind || null,
          aliases: entry.aliases || [],
          tags: entry.tags || [],
          section: sectionKey || null,
          heading: heading || null
        }
      },
      content: bounded.text,
      truncated: bounded.truncated,
      hasMoreBefore: window.hasMoreBefore,
      hasMoreAfter: window.hasMoreAfter || bounded.truncated,
      location: {
        startLine: window.startLine,
        endLine: window.endLine,
        section: sectionKey || null,
        heading: heading || null
      },
      adjacentSections,
      continueWith: {
        before: window.hasMoreBefore ? { endLine: window.startLine - 1 } : null,
        after: window.hasMoreAfter || bounded.truncated ? { startLine: window.endLine + 1 } : null
      },
      message: changed ? '知识文档正式版本已变化，以下为当前磁盘版本' : undefined
    }
  }

  readNote(bookName, parsed, options, maxChars) {
    const snapshot = this.snapshotService.readQuickNotesSnapshot(bookName)
    const changed = Boolean(parsed.contentHash && parsed.contentHash !== snapshot.rawHash)
    const match = /^L(\d+)-(\d+)$/i.exec(parsed.location || '')
    let startLine = options.startLine || (match ? Number(match[1]) : 1)
    let endLine =
      options.endLine || (match ? Number(match[2]) : splitLines(snapshot.content).length)
    if (options.heading) {
      const range = markdownHeadingRange(snapshot.content, options.heading)
      if (!range) throw new Error(`速记 heading 不存在：${options.heading}`)
      startLine = range.startLine
      endLine = range.endLine
    }
    const window = lineWindow(snapshot.content, startLine, endLine, options.before, options.after)
    const bounded = truncate(window.content, maxChars)
    return {
      success: true,
      versionChanged: changed,
      source: this.versionInfo(snapshot, `L${window.startLine}-${window.endLine}`),
      content: bounded.text,
      truncated: bounded.truncated,
      hasMoreBefore: window.hasMoreBefore,
      hasMoreAfter: window.hasMoreAfter || bounded.truncated,
      location: {
        relativePath: snapshot.metadata.relativePath,
        startLine: window.startLine,
        endLine: window.endLine
      },
      message: changed ? '速记正式保存版本已变化，以下为当前磁盘版本' : undefined
    }
  }

  readBookBacklinks(bookName, reference, options = {}) {
    if (!this.referenceIndexService) throw new Error('引用索引服务不可用')
    return {
      success: true,
      ...this.referenceIndexService.readBacklinks(bookName, reference, options)
    }
  }

  readOutlineContext(bookName, reference, options = {}) {
    if (!this.catalogService) throw new Error('Catalog V2 服务不可用')
    let parsed
    try {
      parsed = parseSourceReference(reference)
    } catch {
      parsed = { sourceType: 'outline', targetId: String(reference || '') }
    }
    if (!['outline', 'chapter'].includes(parsed.sourceType))
      throw new Error('大纲上下文只接受 outline 或 chapter 引用')
    const entries = this.catalogService.listEntries(bookName, 'outlines')
    const maxDepth = Math.min(3, Math.max(0, Number(options.maxDepth) || 1))
    const maxRelated = Math.min(30, Math.max(1, Number(options.maxRelated) || 12))
    const maxChars = clampChars(options.maxChars || 20_000)
    const selected = []
    const reasons = new Map()
    const add = (entry, reason) => {
      if (!entry || selected.some((item) => item.id === entry.id) || selected.length >= maxRelated)
        return false
      selected.push(entry)
      reasons.set(entry.id, reason)
      return true
    }
    if (parsed.sourceType === 'outline') {
      const matches = entries.filter((entry) => entry.id === parsed.targetId)
      if (matches.length !== 1)
        throw new Error(matches.length ? '大纲 ID 存在歧义' : '大纲文档不存在')
      add(matches[0], 'requested')
    } else {
      const chapterId = normalizeChapterRef(parsed.targetId)
      entries
        .filter((entry) =>
          (entry.chapterRefs || []).some((item) => normalizeChapterRef(item) === chapterId)
        )
        .forEach((entry) => add(entry, 'chapter_ref'))
    }
    for (let depth = 0; depth < maxDepth; depth += 1) {
      const frontier = [...selected]
      for (const current of frontier) {
        for (const related of current.relatedOutlines || []) {
          const relatedId = String(related).replace(/^outline:/, '')
          add(
            entries.find((entry) => entry.id === relatedId),
            `related_depth_${depth + 1}`
          )
        }
      }
    }
    const seed = selected[0]
    if (seed && selected.length < maxRelated) {
      const tags = new Set(seed.tags || [])
      entries
        .filter((entry) => entry.id !== seed.id && (entry.tags || []).some((tag) => tags.has(tag)))
        .forEach((entry) => add(entry, 'shared_tag'))
      entries
        .filter(
          (entry) =>
            entry.id !== seed.id &&
            typeof entry.order === 'number' &&
            typeof seed.order === 'number'
        )
        .sort((a, b) => Math.abs(a.order - seed.order) - Math.abs(b.order - seed.order))
        .slice(0, 2)
        .forEach((entry) => add(entry, 'adjacent_order'))
    }

    const documents = []
    let usedChars = 0
    for (const entry of selected) {
      const snapshot = this.catalogService.readEntry(bookName, entry)
      const summary = snapshot.parsed?.sectionMap?.summary?.content.trim() || ''
      const boundedSummary = summary.slice(0, Math.min(1200, Math.max(0, maxChars - usedChars)))
      if (!boundedSummary && usedChars >= maxChars) break
      usedChars += boundedSummary.length
      documents.push({
        id: entry.id,
        title: entry.title,
        reason: reasons.get(entry.id),
        order: entry.order,
        tags: entry.tags,
        summary: boundedSummary,
        chapterRefs: entry.chapterRefs || [],
        relatedOutlines: entry.relatedOutlines || [],
        characterRefs: entry.characterRefs || [],
        settingRefs: entry.settingRefs || [],
        reference: makeSourceReference({
          sourceType: 'outline',
          targetId: entry.id,
          location: 'summary',
          contentHash: snapshot.fileHash
        })
      })
    }
    return {
      success: true,
      requested: { sourceType: parsed.sourceType, targetId: parsed.targetId },
      documents,
      truncated: documents.length < selected.length || selected.length >= maxRelated,
      limits: { maxDepth, maxRelated, maxChars }
    }
  }
}

export default BookRetrievalService
