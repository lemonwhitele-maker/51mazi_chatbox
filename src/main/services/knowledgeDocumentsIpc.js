import { parseKnowledgeMarkdown, validateKnowledgeDocument } from './knowledgeMarkdownParser.js'
import { parseSourceReference } from './bookSavedSnapshotService.js'

const IPC_CHANNELS = Object.freeze([
  'knowledge:v2:list-documents',
  'knowledge:v2:create-document',
  'knowledge:v2:read-document',
  'knowledge:v2:validate-document',
  'knowledge:v2:write-document',
  'knowledge:v2:write-character-avatar',
  'knowledge:v2:undo-write',
  'knowledge:v2:index-health',
  'knowledge:v2:rebuild-index',
  'knowledge:v2:resolve-reference'
])

function errorPayload(error) {
  return {
    success: false,
    code: error?.code || 'KNOWLEDGE_V2_OPERATION_FAILED',
    message: error?.message || '开放式知识文档操作失败',
    retryable: error?.retryable === true,
    diagnostics: error?.diagnostics,
    expectedHash: error?.expectedHash,
    currentHash: error?.currentHash,
    invalid: error?.invalid
  }
}

function publicDocument(read) {
  return {
    id: read.id,
    scope: read.scope,
    type: read.type,
    path: read.relativePath,
    source: read.source,
    fileHash: read.fileHash,
    sectionHashes: read.sectionHashes,
    mtimeMs: read.mtimeMs,
    savedAt: read.savedAt,
    fileSize: read.fileSize,
    metadata: read.document.metadata,
    sections: read.document.sections.map((section) => ({
      key: section.key,
      title: section.title,
      startLine: section.startLine,
      endLine: section.endLine,
      contentHash: section.contentHash
    })),
    diagnostics: read.document.diagnostics
  }
}

export function registerKnowledgeDocumentsIpc({ ipcMain, documentService, catalogService, referenceIndexService } = {}) {
  if (!ipcMain || !documentService || !catalogService || !referenceIndexService) {
    throw new TypeError('registerKnowledgeDocumentsIpc dependencies are required')
  }
  const register = (channel, handler) => {
    ipcMain.handle(channel, async (_, payload = {}) => {
      try {
        return { success: true, ...(await handler(payload)) }
      } catch (error) {
        return errorPayload(error)
      }
    })
  }

  register('knowledge:v2:list-documents', async ({ bookName, scope, filters = {} }) => {
    let entries = catalogService.queryEntries(bookName, scope, filters)
    const query = String(filters.query || '')
      .trim()
      .toLocaleLowerCase('zh-CN')
    if (query) {
      entries = entries.filter((entry) =>
        [entry.id, entry.title, entry.kind, ...(entry.aliases || []), ...(entry.tags || [])]
          .join('\n')
          .toLocaleLowerCase('zh-CN')
          .includes(query)
      )
    }
    return { documents: entries.map((entry) => catalogService.descriptor(entry)) }
  })

  register('knowledge:v2:create-document', async ({ bookName, scope, title, kind }) => {
    const created = await documentService.createDocument({ bookName, scope, title, kind })
    const read = documentService.readDocument({
      bookName,
      scope,
      documentId: created.documentId
    })
    return {
      document: publicDocument(read),
      indexStale: created.indexStale,
      indexError: created.indexError
    }
  })

  register('knowledge:v2:read-document', async ({ bookName, scope, documentId }) => ({
    document: publicDocument(documentService.readDocument({ bookName, scope, documentId }))
  }))

  register('knowledge:v2:validate-document', async ({ scope, source, mode = 'formal' }) => {
    const expectedType = { characters: 'character', settings: 'setting', outlines: 'outline' }[
      scope
    ]
    const parsed = parseKnowledgeMarkdown(String(source ?? ''))
    return {
      validation: validateKnowledgeDocument(parsed, { expectedType, mode }),
      metadata: parsed.metadata,
      sections: parsed.sections.map((section) => ({
        key: section.key,
        title: section.title,
        startLine: section.startLine,
        endLine: section.endLine,
        contentHash: section.contentHash
      }))
    }
  })

  register(
    'knowledge:v2:write-document',
    async ({ bookName, scope, documentId, expectedFileHash, source, mode = 'formal' }) => {
      const saved = await documentService.writeDocument({
        bookName,
        scope,
        documentId,
        expectedFileHash,
        source,
        mode
      })
      const read = documentService.readDocument({ bookName, scope, documentId })
      return { saved, document: publicDocument(read) }
    }
  )

  register('knowledge:v2:write-character-avatar', async (payload) => {
    const saved = await documentService.writeCharacterAvatar(payload)
    const read = documentService.readDocument({
      bookName: payload.bookName,
      scope: 'characters',
      documentId: payload.documentId
    })
    return { saved, document: publicDocument(read) }
  })

  register('knowledge:v2:undo-write', async ({ bookName, undoToken, expectedCurrentHash }) => ({
    restored: await documentService.undoWrite({ bookName, undoToken, expectedCurrentHash })
  }))

  const indexHealth = (bookName, { rebuild = false } = {}) => {
    const scopes = ['chapters', 'characters', 'settings', 'outlines', 'notes']
    const catalogs = []
    const diagnostics = []
    let pendingFiles = 0
    for (const scope of scopes) {
      const stored = catalogService.readStoredCatalog(bookName, scope)
      let currentSignatures = []
      try {
        currentSignatures = catalogService.signatures(bookName, scope)
        if (stored && JSON.stringify(stored.sourceSignatures) !== JSON.stringify(currentSignatures)) {
          const old = new Map(stored.sourceSignatures.map((item) => [item.path, `${item.size}:${item.mtimeMs}`]))
          pendingFiles += currentSignatures.filter((item) => old.get(item.path) !== `${item.size}:${item.mtimeMs}`).length
          pendingFiles += stored.sourceSignatures.filter((item) => !currentSignatures.some((next) => next.path === item.path)).length
        } else if (!stored) pendingFiles += currentSignatures.length
        const catalog = catalogService.buildCatalog(bookName, scope, { force: rebuild })
        catalogs.push({ scope, generatedAt: catalog.generatedAt, total: catalog.entries.length, stats: catalog.stats })
        diagnostics.push(...(catalog.diagnostics || []).map((item) => ({ ...item, scope })))
        for (const entry of catalog.entries) {
          diagnostics.push(...(entry.diagnostics || []).map((item) => ({ ...item, scope, targetId: entry.id, path: entry.path })))
        }
      } catch (error) {
        diagnostics.push({ code: 'CATALOG_BUILD_FAILED', severity: 'error', scope, message: error?.message || '索引构建失败' })
      }
    }
    let references = { generatedAt: null, stats: { total: 0, dangling: 0, ambiguous: 0 }, dangling: [], diagnostics: [] }
    try {
      references = referenceIndexService.buildIndex(bookName, { force: rebuild })
      diagnostics.push(...(references.diagnostics || []).map((item) => ({ ...item, severity: 'error', scope: 'references' })))
      diagnostics.push(...(references.dangling || []).map((item) => ({
        code: 'REFERENCE_DANGLING', severity: 'warning', scope: 'references',
        message: `引用目标不存在：${item.target.type}:${item.target.id}`,
        source: item.source, target: item.target
      })))
    } catch (error) {
      diagnostics.push({ code: 'REFERENCE_INDEX_FAILED', severity: 'error', scope: 'references', message: error?.message || '引用索引构建失败' })
    }
    const generatedAt = [references.generatedAt, ...catalogs.map((item) => item.generatedAt)].filter(Boolean).sort().at(-1) || null
    return {
      generatedAt, pendingFiles, catalogs,
      stats: {
        files: catalogs.reduce((sum, item) => sum + item.total, 0),
        errors: diagnostics.filter((item) => item.severity === 'error').length,
        warnings: diagnostics.filter((item) => item.severity !== 'error').length,
        dangling: references.stats?.dangling || 0,
        ambiguous: references.stats?.ambiguous || 0
      },
      diagnostics
    }
  }

  register('knowledge:v2:index-health', async ({ bookName }) => ({ health: indexHealth(bookName) }))
  register('knowledge:v2:rebuild-index', async ({ bookName }) => {
    catalogService.invalidate(bookName)
    referenceIndexService.invalidate(bookName)
    return { health: indexHealth(bookName, { rebuild: true }) }
  })

  register('knowledge:v2:resolve-reference', async ({ bookName, reference }) => {
    const parsed = parseSourceReference(reference)
    const scope = { chapter: 'chapters', character: 'characters', setting: 'settings', outline: 'outlines', note: 'notes' }[parsed.sourceType]
    const entry = catalogService.findEntries(bookName, parsed.sourceType, parsed.targetId)[0]
    const lineRange = /^L(\d+)(?:-(\d+))?$/i.exec(parsed.location)
    const section = !lineRange && entry?.sections?.find((item) => item.key === parsed.location)
    const startLine = Number(lineRange?.[1]) || section?.startLine || 0
    const endLine = Number(lineRange?.[2]) || section?.endLine || startLine
    return {
      resolved: {
        reference,
        sourceType: parsed.sourceType,
        scope,
        targetId: parsed.targetId,
        title: entry?.title || parsed.targetId.split('/').pop()?.replace(/\.txt$/i, '') || parsed.targetId,
        section: section?.key || (!lineRange ? parsed.location : ''),
        sectionTitle: section?.heading || '',
        startLine,
        endLine,
        path: entry?.path || ''
      }
    }
  })

  return {
    dispose() {
      for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel)
    }
  }
}

export default registerKnowledgeDocumentsIpc
