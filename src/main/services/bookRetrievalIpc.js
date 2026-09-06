const IPC_HANDLERS = [
  'book:list-saved-structure',
  'book:search-saved-knowledge',
  'book:read-saved-source',
  'book:read-backlinks',
  'book:read-outline-context',
  'book:refresh-saved-index'
]

function requireBookName(payload) {
  const bookName = String(payload?.bookName || '').trim()
  if (!bookName) throw new Error('缺少书籍名称')
  return bookName
}

function safeInvoke(task) {
  try {
    return { success: true, ...task() }
  } catch (error) {
    return {
      success: false,
      message: error?.message || '书籍检索失败',
      code: error?.code || 'BOOK_RETRIEVAL_ERROR'
    }
  }
}

export function registerBookRetrievalIpc({
  ipcMain,
  retrievalService,
  searchIndexService,
  catalogService = null,
  referenceIndexService = null
}) {
  ipcMain.handle('book:list-saved-structure', (_, payload = {}) =>
    safeInvoke(() =>
      retrievalService.listBookStructure(requireBookName(payload), payload.scopes, {
        mode: payload.mode
      })
    )
  )

  ipcMain.handle('book:search-saved-knowledge', (_, payload = {}) =>
    safeInvoke(() => {
      const bookName = requireBookName(payload)
      return retrievalService.searchBookKnowledge(bookName, payload.query, {
        scopes: payload.scopes,
        filters: payload.filters,
        limit: payload.limit,
        mode: payload.mode
      })
    })
  )

  ipcMain.handle('book:read-saved-source', (_, payload = {}) =>
    safeInvoke(() => {
      const bookName = requireBookName(payload)
      const reference = String(payload.reference || '').trim()
      if (!reference) throw new Error('缺少来源引用')
      return retrievalService.readBookSource(bookName, reference, {
        before: payload.before,
        after: payload.after,
        sectionKey: payload.sectionKey,
        heading: payload.heading,
        startLine: payload.startLine,
        endLine: payload.endLine,
        maxChars: payload.maxChars,
        includeParent: payload.includeParent,
        includeChildren: payload.includeChildren
      })
    })
  )

  ipcMain.handle('book:read-backlinks', (_, payload = {}) =>
    safeInvoke(() =>
      retrievalService.readBookBacklinks(
        requireBookName(payload),
        String(payload.reference || ''),
        { includeWeak: payload.includeWeak, limit: payload.limit }
      )
    )
  )

  ipcMain.handle('book:read-outline-context', (_, payload = {}) =>
    safeInvoke(() =>
      retrievalService.readOutlineContext(
        requireBookName(payload),
        String(payload.reference || ''),
        {
          maxDepth: payload.maxDepth,
          maxRelated: payload.maxRelated,
          maxChars: payload.maxChars
        }
      )
    )
  )

  ipcMain.handle('book:refresh-saved-index', (_, payload = {}) =>
    safeInvoke(() => {
      const bookName = requireBookName(payload)
      searchIndexService.invalidate(bookName)
      catalogService?.invalidate(bookName)
      referenceIndexService?.invalidate(bookName)
      const catalogs = catalogService?.rebuildBook(bookName)
      const references = referenceIndexService?.buildIndex(bookName, { force: true })
      return {
        invalidated: true,
        rebuilt: Boolean(catalogs),
        bookName,
        catalogs: catalogs
          ? Object.fromEntries(
              Object.entries(catalogs).map(([scope, catalog]) => [scope, catalog.stats])
            )
          : null,
        references: references?.stats || null
      }
    })
  )

  return {
    dispose() {
      for (const channel of IPC_HANDLERS) ipcMain.removeHandler(channel)
    }
  }
}

export default registerBookRetrievalIpc
