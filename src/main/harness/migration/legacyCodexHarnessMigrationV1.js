import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { isLibraryMetadataName } from '../../services/libraryApiConfigStore.js'

const BINDINGS_KEY = 'codexAgent.bookBindingsV1'
const HISTORY_KEY = 'codexAgent.threadHistoryV1'
const LEGACY_NOTES = join('.codex', 'quick-notes.md')
const NEW_NOTES = join('.51mazi', 'notes', 'quick-notes.md')
const MARKER_NAME = 'migration-v1.json'
const VALID_EFFORTS = new Set(['codex-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`
}

function decodeBookName(value) {
  try { return decodeURIComponent(value) } catch { return String(value || '') }
}

function threadEntries(binding) {
  return [...(Array.isArray(binding?.threads) ? binding.threads : []), ...(Array.isArray(binding?.archivedThreads) ? binding.archivedThreads : [])]
}

function sanitizeLegacyPreferences(bindings) {
  let changed = false
  for (const binding of Object.values(bindings)) {
    for (const thread of threadEntries(binding)) {
      const model = typeof thread?.modelPreference === 'string' ? thread.modelPreference.trim() : ''
      const effort = typeof thread?.effortPreference === 'string' ? thread.effortPreference.trim() : ''
      const nextModel = model && model !== '[object Object]' ? model : 'codex-default'
      const nextEffort = VALID_EFFORTS.has(effort) ? effort : 'codex-default'
      if (thread.modelPreference !== nextModel) { thread.modelPreference = nextModel; changed = true }
      if (thread.effortPreference !== nextEffort) { thread.effortPreference = nextEffort; changed = true }
    }
  }
  return changed
}

export class LegacyCodexHarnessMigrationV1 {
  constructor({ store, harnessStore, snapshotService } = {}) {
    this.store = store
    this.harnessStore = harnessStore
    this.snapshotService = snapshotService
  }

  async migrate() {
    const bindings = objectOrEmpty(this.store?.get?.(BINDINGS_KEY))
    const histories = objectOrEmpty(this.store?.get?.(HISTORY_KEY))
    if (sanitizeLegacyPreferences(bindings)) this.store?.set?.(BINDINGS_KEY, bindings)
    const result = { schemaVersion: 1, imported: [], skipped: [], conflicts: [], completedAt: new Date().toISOString() }
    const books = new Map()
    for (const [encodedBookName, binding] of Object.entries(bindings)) {
      const bookName = decodeBookName(encodedBookName).trim()
      if (bookName && !isLibraryMetadataName(bookName)) books.set(bookName, binding)
    }
    try {
      const root = this.snapshotService.getBooksDir?.()
      if (root) {
        const entries = await fs.readdir(root, { withFileTypes: true })
        for (const entry of entries) if (entry.isDirectory() && !isLibraryMetadataName(entry.name) && !books.has(entry.name)) books.set(entry.name, {})
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    for (const [bookName, binding] of books) {
      if (!bookName) continue
      let bookPath
      try { bookPath = this.snapshotService.resolveBookPath(bookName) } catch (error) {
        result.skipped.push({ bookDigest: digest(bookName), reason: String(error?.message || '书籍不存在') })
        continue
      }
      const markerPath = join(bookPath, '.51mazi', 'harness', MARKER_NAME)
      const marker = await this.harnessStore.readJson(markerPath, { schemaVersion: 1, imported: [], conflicts: [] })
      const importedKeys = new Set(marker.imported || [])
      for (const thread of threadEntries(binding)) {
        const oldThreadId = String(thread?.id || '').trim()
        if (!oldThreadId) continue
        const key = `${bookName}:${oldThreadId}`
        if (importedKeys.has(key)) continue
        const conversationId = `conv_legacy_${digest(key).slice('sha256:'.length, 40)}`
        const messages = Array.isArray(histories[oldThreadId]) ? histories[oldThreadId] : []
        const importedConversation = await this.harnessStore.importLegacyConversation({
          bookKey: bookName,
          conversationId,
          title: String(thread.name || '导入对话').slice(0, 120),
          archived: Boolean(thread.archived),
          threadDigest: digest(oldThreadId),
          modelPreference: thread.modelPreference,
          effortPreference: thread.effortPreference,
          messages
        })
        importedKeys.add(key)
        result.imported.push(importedConversation)
      }
      await this.migrateNotes(bookName, bookPath, marker, result)
      await this.harnessStore.writeJson(markerPath, { ...marker, schemaVersion: 1, imported: [...importedKeys], conflicts: result.conflicts.filter((item) => item.bookDigest === digest(bookName)), completedAt: result.completedAt })
    }
    return result
  }

  async migrateNotes(bookName, bookPath, marker, result) {
    const legacyPath = join(bookPath, LEGACY_NOTES)
    const newPath = join(bookPath, NEW_NOTES)
    let legacyContent = ''
    try { legacyContent = await fs.readFile(legacyPath, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!legacyContent) return
    try {
      await fs.access(newPath)
      const conflict = { bookDigest: digest(bookName), type: 'quick-notes', reason: 'new-file-wins' }
      result.conflicts.push(conflict)
      if (!Array.isArray(marker.conflicts)) marker.conflicts = []
      marker.conflicts.push(conflict)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await fs.mkdir(join(bookPath, '.51mazi', 'notes'), { recursive: true })
      await fs.writeFile(newPath, legacyContent, 'utf8')
    }
  }
}

export default LegacyCodexHarnessMigrationV1
