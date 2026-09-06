import DomainHarnessService from '../harness/domainHarnessService.js'

export function registerHarnessIpc({ ipcMain, snapshotService, retrievalService, chapterWriteService, knowledgeDocumentService = null, knowledgeCatalogService = null, referenceIndexService = null, legacyStore, settingsStore = legacyStore, getWindows, clientVersion }) {
  const service = new DomainHarnessService({
    snapshotService,
    retrievalService,
    chapterWriteService,
    knowledgeDocumentService,
    knowledgeCatalogService,
    referenceIndexService,
    legacyStore,
    settingsStore,
    getWindows,
    clientVersion
  })
  ipcMain.handle('harness:status', (_, payload = {}) => service.getStatus(payload))
  ipcMain.handle('harness:conversation:list', (_, payload) => service.listConversations(payload?.bookName))
  ipcMain.handle('harness:conversation:create', (_, payload) => service.createConversation(payload || {}))
  ipcMain.handle('harness:conversation:read', (_, payload) => service.readConversation(payload || {}))
  ipcMain.handle('harness:conversation:archive', (_, payload) => service.archiveConversation(payload || {}))
  ipcMain.handle('harness:model:list', () => service.listModels())
  ipcMain.handle('agent-api:config:get', () => service.getAgentModelConfig())
  ipcMain.handle('agent-api:config:set', (_, payload) => service.setAgentModelConfig(payload || {}))
  ipcMain.handle('agent-api:config:validate', (_, payload) =>
    service.validateAgentModelConfig(payload || {})
  )
  ipcMain.handle('harness:conversation:settings:update', (_, payload) => service.updateConversationSettings(payload || {}))
  ipcMain.handle('harness:turn:start', (_, payload) => service.startTurn(payload || {}))
  ipcMain.handle('harness:turn:cancel', (_, payload) => service.cancelTurn(payload || {}))
  ipcMain.handle('harness:write-proposal:list', (_, payload) =>
    service.listWriteProposals(payload || {})
  )
  ipcMain.handle('harness:write-proposal:reject', (_, payload) =>
    service.rejectWriteProposal(payload || {})
  )
  ipcMain.handle('harness:write-proposal:apply', (_, payload) =>
    service.applyWriteProposal(payload || {})
  )
  ipcMain.handle('harness:write-proposal:undo', (_, payload) =>
    service.undoWriteProposal(payload || {})
  )
  ipcMain.handle('function-api:config:get', () => service.getFunctionApiConfig())
  ipcMain.handle('function-api:config:set', (_, payload) => service.setFunctionApiConfig(payload || {}))
  ipcMain.handle('function-api:config:validate', (_, payload) =>
    service.validateFunctionApiConfig(payload || {})
  )
  return { service, dispose: () => void service.dispose() }
}
