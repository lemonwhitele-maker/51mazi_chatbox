import { normalizeVirtualPath } from './virtualDocumentPaths.js'

function cleanSegment(value) {
  const segment = String(value || '').trim()
  if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) return null
  return segment
}

export function workspaceDocumentPath(workspace = {}) {
  const metadata = workspace.metadata || {}
  const fileType = String(metadata.file_type || '').toLowerCase()
  const currentModule = String(workspace.currentModule || '').toLowerCase()
  if (fileType === 'note' || currentModule === 'quick-notes') return 'book/notes/quick-notes.md'

  if (fileType === 'chapter' || currentModule === 'editor') {
    const volume = cleanSegment(metadata.volume_name)
    const chapter = cleanSegment(metadata.chapter_name)
    if (!volume || !chapter) return null
    return normalizeVirtualPath(
      `book/chapters/${volume}/${chapter.replace(/\.txt$/i, '')}.txt`
    )
  }

  const scope = cleanSegment(metadata.knowledge_scope)
  const documentId = cleanSegment(
    metadata.knowledge_document_id || workspace.currentDocumentId || workspace.currentEntityId
  )
  if (['characters', 'settings', 'outlines'].includes(scope) && documentId)
    return normalizeVirtualPath(`book/knowledge/${scope}/${documentId.replace(/\.md$/i, '')}.md`)
  return null
}

export class EditorDirtyStateRegistry {
  constructor({ canonicalizePath = null } = {}) {
    this.bySender = new Map()
    this.canonicalizePath = canonicalizePath
  }

  update({ senderId, frameId = 0, bookIdentity, bookKey, bookScope, workspace } = {}) {
    const owner = `${String(senderId)}:${String(frameId)}`
    let path = workspaceDocumentPath(workspace)
    if (path && bookScope && this.canonicalizePath) path = this.canonicalizePath(bookScope, path)
    this.bySender.delete(owner)
    if (path && workspace?.hasUnsavedChanges === true)
      this.bySender.set(owner, { bookIdentity, bookKey, path })
    return { path, dirty: workspace?.hasUnsavedChanges === true }
  }

  revokeSender(senderId) {
    const prefix = `${String(senderId)}:`
    for (const key of this.bySender.keys()) if (key.startsWith(prefix)) this.bySender.delete(key)
  }

  isDirty({ bookIdentity, bookKey, path } = {}) {
    return [...this.bySender.values()].some(
      (entry) =>
        entry.path === path &&
        (bookIdentity ? entry.bookIdentity === bookIdentity : entry.bookKey === bookKey)
    )
  }
}

export default EditorDirtyStateRegistry
