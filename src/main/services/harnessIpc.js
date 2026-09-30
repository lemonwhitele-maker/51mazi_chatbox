import { logSaveDiagnostic, saveErrorDetails } from './saveDiagnostics.js'
import DomainHarnessService from '../harness/domainHarnessService.js'
import BookScopeRegistry from '../harness/sandbox/bookScopeRegistry.js'
import EditorDirtyStateRegistry from '../harness/documents/editorDirtyStateRegistry.js'

function requestIdentity(event) {
  return {
    senderId: event?.sender?.id ?? null,
    frameId: event?.senderFrame?.routingId ?? event?.frameId ?? 0
  }
}

export function registerHarnessIpc({ ipcMain, snapshotService, retrievalService, chapterWriteService, knowledgeDocumentService = null, knowledgeCatalogService = null, referenceIndexService = null, isDocumentDirty = () => false, legacyStore, settingsStore = legacyStore, getWindows, clientVersion }) {
  const dirtyStates = new EditorDirtyStateRegistry({
    canonicalizePath: (scope, path) => service.bookDocuments.canonicalPath(scope, path)
  })
  const service = new DomainHarnessService({
    snapshotService,
    retrievalService,
    chapterWriteService,
    knowledgeDocumentService,
    knowledgeCatalogService,
    referenceIndexService,
    isDocumentDirty: async (payload) =>
      (await isDocumentDirty(payload)) || dirtyStates.isDirty(payload),
    legacyStore,
    settingsStore,
    getWindows,
    clientVersion
  })
  const scopes = new BookScopeRegistry({ sandboxService: service.bookSandbox })
  service.eventAudience = (win, event) => scopes.canReceive({
    senderId: win?.webContents?.id,
    bookName: event?.bookName || event?.bookKey || null,
    conversationId: event?.conversationId || null
  })
  const observedSenders = new Set()
  const bind = (event, payload = {}) => {
    const identity = requestIdentity(event)
    if (identity.senderId == null) throw new Error('无法识别请求窗口')
    if (!observedSenders.has(identity.senderId)) {
      observedSenders.add(identity.senderId)
      event.sender?.once?.('destroyed', () => {
        scopes.revokeSender(identity.senderId)
        dirtyStates.revokeSender(identity.senderId)
        observedSenders.delete(identity.senderId)
      })
    }
    const result = scopes.bindBook({ ...identity, bookName: payload?.bookName })
    return { scopeId: result.scope.scopeId, bookKey: result.scope.bookKey, policyVersion: result.scope.policyVersion }
  }
  const assertScope = (event, payload = {}) => scopes.assertBound({
    ...requestIdentity(event),
    bookName: payload?.bookName,
    conversationId: payload?.conversationId || null,
    turnId: payload?.turnId || null
  })
  ipcMain.handle('harness:book:bind', (event, payload = {}) => bind(event, payload))
  ipcMain.handle('harness:editor-state:update', (event, payload = {}) => {
    const allowed = new Set(['bookName', 'workspace'])
    if (Object.keys(payload || {}).some((key) => !allowed.has(key)))
      throw new Error('编辑器状态包含不受信任的额外参数')
    const scope = assertScope(event, payload)
    return dirtyStates.update({
      senderId: requestIdentity(event).senderId,
      frameId: requestIdentity(event).frameId,
      bookIdentity: scope.bookIdentity,
      bookKey: scope.bookKey,
      bookScope: scope,
      workspace: payload.workspace || {}
    })
  })
  ipcMain.handle('harness:status', (event, payload = {}) => {
    if (payload?.bookName) assertScope(event, payload)
    return service.getStatus(payload)
  })
  ipcMain.handle('harness:conversation:list', (event, payload) => { assertScope(event, payload); return service.listConversations(payload?.bookName) })
  ipcMain.handle('harness:conversation:create', (event, payload) => { assertScope(event, payload); return service.createConversation(payload || {}) })
  ipcMain.handle('harness:conversation:read', (event, payload) => { assertScope(event, payload); return service.readConversation(payload || {}) })
  ipcMain.handle('harness:conversation:archive', (event, payload) => { assertScope(event, payload); return service.archiveConversation(payload || {}) })
  ipcMain.handle('harness:model:list', (_event, options) => service.listModels(options))
  ipcMain.handle('agent-api:config:get', () => service.getAgentModelConfig())
  ipcMain.handle('agent-api:config:set', (_, payload) => service.setAgentModelConfig(payload || {}))
  ipcMain.handle('agent-api:config:validate', (_, payload) =>
    service.validateAgentModelConfig(payload || {})
  )
  ipcMain.handle('harness:conversation:settings:update', (event, payload) => { assertScope(event, payload); return service.updateConversationSettings(payload || {}) })
  ipcMain.handle('harness:turn:start', (event, payload) => {
    const scope = assertScope(event, payload)
    return service.startTurn(payload || {}, { scope, assertScope: () => scopes.assertScopeToken(scope) })
  })
  ipcMain.handle('harness:turn:cancel', (event, payload) => { assertScope(event, payload); return service.cancelTurn(payload || {}) })
  ipcMain.handle('harness:write-proposal:list', async (event, payload) => {
    const scope = assertScope(event, payload)
    const proposals = await service.listWriteProposals(payload || {}, {
      scope,
      allowScopeRebind: (scopeId) => !scopes.isScopeActive(scopeId)
    })
    return proposals.map((proposal) => proposal.proposalType === 'document'
      ? {
          ...proposal,
          confirmationCredential: proposal.confirmationAllowed
            ? scopes.issueConfirmation(scope, proposal)
            : null
        }
      : proposal)
  })
  const trustedDocumentAction = (event, payload = {}) => {
    const allowed = new Set(['proposalId', 'revision', 'confirmationCredential'])
    if (Object.keys(payload || {}).some((key) => !allowed.has(key)))
      throw new Error('文档提案操作包含不受信任的额外参数')
    const verified = scopes.verifyConfirmation({ ...requestIdentity(event), ...payload })
    return {
      scope: verified.scope,
      grant: verified.grant,
      payload: {
        proposalId: verified.grant.proposalId,
        revision: verified.grant.revision,
        candidateHash: verified.grant.candidateHash,
        bookName: verified.grant.bookKey,
        conversationId: verified.grant.conversationId
      }
    }
  }
  ipcMain.handle('harness:document-proposal:reject', (event, payload) => {
    const trusted = trustedDocumentAction(event, payload)
    return service.rejectWriteProposal(trusted.payload, { scope: trusted.scope, document: true })
  })
  ipcMain.handle('harness:document-proposal:apply', async (event, payload) => {
    try {
      const trusted = trustedDocumentAction(event, payload)
      const result = await service.applyWriteProposal(trusted.payload, { scope: trusted.scope, document: true })
      return {
        ...result,
        proposal: result?.proposal
          ? { ...result.proposal, confirmationCredential: scopes.issueConfirmation(trusted.scope, result.proposal) }
          : result?.proposal
      }
    } catch (error) {
      logSaveDiagnostic('proposal.apply-failed', { senderId: event.sender.id, proposalId: payload?.proposalId, error: saveErrorDetails(error) })
      throw error
    }
  })
  ipcMain.handle('harness:document-proposal:undo', (event, payload) => {
    const trusted = trustedDocumentAction(event, payload)
    return service.undoWriteProposal(trusted.payload, { scope: trusted.scope, document: true })
  })
  ipcMain.handle('function-api:config:get', () => service.getFunctionApiConfig())
  ipcMain.handle('function-api:config:set', (_, payload) => service.setFunctionApiConfig(payload || {}))
  ipcMain.handle('function-api:config:validate', (_, payload) =>
    service.validateFunctionApiConfig(payload || {})
  )
  return { service, scopes, dirtyStates, dispose: () => { scopes.revokeAll(); void service.dispose() } }
}
