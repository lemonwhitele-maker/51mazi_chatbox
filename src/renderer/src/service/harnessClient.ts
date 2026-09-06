export type HarnessWorkspace = {
  currentModule: string | null
  currentDocumentId: string | null
  currentEntityId: string | null
  selectionText: string
  selectionRange: { from: number; to: number } | { start: number; end: number } | null
  editorRange: { from: number; to: number } | null
  textRange: { start: number; end: number } | null
  currentDocumentSavedHash: string | null
  currentSectionId: string | null
  currentSectionSavedHash: string | null
  hasUnsavedChanges: boolean
  metadata: Record<string, string | number | boolean | null>
}

export type BodyWriteProposal = {
  schemaVersion: 1
  proposalId: string
  bookKey: string
  conversationId: string
  turnId: string
  target: { documentId: string; chapterName: string; volumeName: string }
  operation: 'replace_selection' | 'insert_before_selection' | 'insert_after_selection' | 'append_to_chapter'
  summary: string
  originalText: string
  proposedText: string
  editorRange: { from: number; to: number } | null
  textRange: { start: number; end: number } | null
  baseSavedHash: string
  status: 'pending' | 'applying' | 'applied' | 'rejected' | 'superseded' | 'stale' | 'failed' | 'undone'
  createdAt: string
  resolvedAt: string | null
  appliedHash?: string | null
  failure?: { code: string; message: string; retryable: boolean } | null
}

export type KnowledgeWriteProposal = {
  schemaVersion: 1
  proposalType: 'knowledge'
  proposalId: string
  bookKey: string
  conversationId: string
  turnId: string
  target: {
    type: 'character' | 'setting' | 'outline' | 'note'
    scope: 'characters' | 'settings' | 'outlines' | 'notes'
    documentId: string
    title: string
    path: string | null
    create: boolean
  }
  operation: string
  summary: string
  reason: string
  basis?: 'source_grounded' | 'creative'
  sourceReferences?: string[]
  evidence?: Array<{
    reference: string
    authorityStatus: string | null
    savedHash: string | null
    scope: string | null
    objectId: string | null
    truncated: boolean
    toolName: string
  }>
  preview: { before: string; after: string }
  affectedSections: string[]
  referenceChanges: Array<{ operation: string; reference: string; sectionKey?: string }>
  baseSavedHash: string
  baseSectionHash: string
  baseSectionHashes?: Record<string, string>
  status: 'pending' | 'applying' | 'applied' | 'rejected' | 'superseded' | 'stale' | 'conflicted' | 'failed' | 'undone'
  createdAt: string
  resolvedAt: string | null
  appliedHash?: string | null
  failure?: { code: string; message: string; retryable: boolean } | null
}

const electron = (window as any).electron

const ALLOWED_METADATA = new Set([
  'chapter_id', 'chapter_name', 'file_type', 'volume_name', 'character_id', 'character_name',
  'character_kind', 'character_section', 'character_formal_version', 'character_content_version',
  'character_draft', 'source_file', 'knowledge_scope', 'knowledge_document_id',
  'knowledge_section', 'knowledge_title'
])

export function normalizeHarnessWorkspaceContext(value: Record<string, any> = {}): HarnessWorkspace {
  const range = value.selectionRange
  const selectionRange = range && Number.isFinite(Number(range.from ?? range.start)) && Number.isFinite(Number(range.to ?? range.end))
    ? range.from != null
      ? { from: Math.max(0, Math.floor(Number(range.from))), to: Math.max(0, Math.floor(Number(range.to))) }
      : { start: Math.max(0, Math.floor(Number(range.start))), end: Math.max(0, Math.floor(Number(range.end))) }
    : null
  const metadata: Record<string, string | number | boolean | null> = {}
  const rawEditorRange = value.editorRange ?? (range?.from != null ? range : null)
  const editorRange = rawEditorRange && Number.isFinite(Number(rawEditorRange.from)) && Number.isFinite(Number(rawEditorRange.to))
    ? { from: Math.max(0, Math.floor(Number(rawEditorRange.from))), to: Math.max(0, Math.floor(Number(rawEditorRange.to))) }
    : null
  const rawTextRange = value.textRange ?? (range?.start != null ? range : null)
  const textRange = rawTextRange && Number.isFinite(Number(rawTextRange.start)) && Number.isFinite(Number(rawTextRange.end))
    ? { start: Math.max(0, Math.floor(Number(rawTextRange.start))), end: Math.max(0, Math.floor(Number(rawTextRange.end))) }
    : null
  for (const [key, item] of Object.entries(value.metadata || {})) {
    if (!ALLOWED_METADATA.has(key)) continue
    if (typeof item === 'string') metadata[key] = item.slice(0, 400)
    else if (typeof item === 'number' && Number.isFinite(item)) metadata[key] = item
    else if (typeof item === 'boolean' || item === null) metadata[key] = item
  }
  return {
    currentModule: value.currentModule ?? value.activeModule ?? null,
    currentDocumentId: value.currentDocumentId ?? value.activeDocumentId ?? null,
    currentEntityId: value.currentEntityId ?? value.activeEntityId ?? null,
    selectionText: String(value.selectionText ?? value.selection ?? '').slice(0, 12000),
    selectionRange,
    editorRange,
    textRange,
    currentDocumentSavedHash: value.currentDocumentSavedHash ?? value.formalHash ?? null,
    currentSectionId: value.currentSectionId ?? value.metadata?.knowledge_section ?? null,
    currentSectionSavedHash: value.currentSectionSavedHash ?? null,
    hasUnsavedChanges: value.hasUnsavedChanges === true || value.draftDirty === true,
    metadata
  }
}

export const harnessClient = {
  getStatus: (payload = {}) => electron.harnessGetStatus(payload),
  listConversations: (bookName: string) => electron.harnessListConversations(bookName),
  createConversation: (
    bookName: string,
    title?: string,
    runtimeId?: 'fake' | 'codex-app-server' | 'agent-router' | 'agent-api',
    options?: { model?: string | null; effort?: string | null; autoTitle?: boolean }
  ) => electron.harnessCreateConversation(bookName, title, runtimeId, options),
  readConversation: (bookName: string, conversationId: string) => electron.harnessReadConversation(bookName, conversationId),
  archiveConversation: (bookName: string, conversationId: string) => electron.harnessArchiveConversation(bookName, conversationId),
  listModels: () => electron.harnessListModels(),
  updateConversationSettings: (bookName: string, conversationId: string, model: string | null, effort: string | null, runtimeId?: 'agent-router') => electron.harnessUpdateConversationSettings(bookName, conversationId, model, effort, runtimeId),
  startTurn: (payload: { bookName: string; conversationId: string; text: string; workspace?: HarnessWorkspace; model?: string | null; effort?: string | null }) => electron.harnessStartTurn(payload),
  cancelTurn: (bookName: string, conversationId: string) => electron.harnessCancelTurn(bookName, conversationId),
  listWriteProposals: (bookName: string, conversationId: string): Promise<Array<BodyWriteProposal | KnowledgeWriteProposal>> => electron.harnessListWriteProposals(bookName, conversationId),
  rejectWriteProposal: (bookName: string, conversationId: string, proposalId: string): Promise<BodyWriteProposal | KnowledgeWriteProposal> => electron.harnessRejectWriteProposal(bookName, conversationId, proposalId),
  applyWriteProposal: (bookName: string, conversationId: string, proposalId: string) => electron.harnessApplyWriteProposal(bookName, conversationId, proposalId),
  undoWriteProposal: (bookName: string, conversationId: string, proposalId: string) => electron.harnessUndoWriteProposal(bookName, conversationId, proposalId),
  onEvent: (callback: (event: unknown) => void) => electron.onHarnessEvent(callback)
}

export default harnessClient
