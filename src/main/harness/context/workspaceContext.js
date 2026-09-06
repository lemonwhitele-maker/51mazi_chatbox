const MAX_STRING = 400
const MAX_SELECTION = 12000
const ALLOWED_METADATA = new Set([
  'chapter_id',
  'chapter_name',
  'file_type',
  'volume_name',
  'character_id',
  'character_name',
  'character_kind',
  'character_section',
  'character_formal_version',
  'character_content_version',
  'character_draft',
  'knowledge_scope',
  'knowledge_document_id',
  'knowledge_section',
  'knowledge_title',
  'source_file'
])

function boundedString(value, max = MAX_STRING) {
  if (value == null) return null
  return String(value).slice(0, max)
}

export function safeWorkspace(value = {}) {
  const range = value.selectionRange
  const selectionRange = range && Number.isFinite(Number(range.from ?? range.start)) && Number.isFinite(Number(range.to ?? range.end))
    ? {
        ...(range.from != null ? { from: Math.max(0, Math.floor(Number(range.from))) } : { start: Math.max(0, Math.floor(Number(range.start))) }),
        ...(range.to != null ? { to: Math.max(0, Math.floor(Number(range.to))) } : { end: Math.max(0, Math.floor(Number(range.end))) })
      }
    : null
  const rawEditorRange = value.editorRange ?? (range?.from != null ? range : null)
  const editorRange = rawEditorRange && Number.isFinite(Number(rawEditorRange.from)) && Number.isFinite(Number(rawEditorRange.to))
    ? {
        from: Math.max(0, Math.floor(Number(rawEditorRange.from))),
        to: Math.max(0, Math.floor(Number(rawEditorRange.to)))
      }
    : null
  const rawTextRange = value.textRange ?? (range?.start != null ? range : null)
  const textRange = rawTextRange && Number.isFinite(Number(rawTextRange.start)) && Number.isFinite(Number(rawTextRange.end))
    ? {
        start: Math.max(0, Math.floor(Number(rawTextRange.start))),
        end: Math.max(0, Math.floor(Number(rawTextRange.end)))
      }
    : null
  const metadata = {}
  if (value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)) {
    for (const [key, item] of Object.entries(value.metadata)) {
      if (!ALLOWED_METADATA.has(key)) continue
      if (typeof item === 'string') metadata[key] = item.slice(0, MAX_STRING)
      else if (typeof item === 'number' && Number.isFinite(item)) metadata[key] = item
      else if (typeof item === 'boolean') metadata[key] = item
    }
  }
  return {
    currentModule: boundedString(value.currentModule),
    currentDocumentId: boundedString(value.currentDocumentId),
    currentEntityId: boundedString(value.currentEntityId),
    selectionText: String(value.selectionText || '').slice(0, MAX_SELECTION),
    selectionRange,
    editorRange,
    textRange,
    currentDocumentSavedHash: boundedString(value.currentDocumentSavedHash),
    currentSectionId: boundedString(value.currentSectionId),
    currentSectionSavedHash: boundedString(value.currentSectionSavedHash),
    hasUnsavedChanges: value.hasUnsavedChanges === true,
    metadata
  }
}

export { ALLOWED_METADATA }
