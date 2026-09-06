import { EventEmitter } from 'node:events'
import HarnessStore from './store/harnessStore.js'
import DomainToolRegistry from './tools/domainToolRegistry.js'
import { createBookReadTools } from './tools/bookReadTools.js'
import ContextAssembler from './context/contextAssembler.js'
import TurnCoordinator from './turn/turnCoordinator.js'
import FakeRuntime from './runtime/fakeRuntime.js'
import CodexAppServerRuntime from './runtime/codexAppServerRuntime.js'
import AgentApiRuntime from './runtime/agentApiRuntime.js'
import AgentRouterRuntime from './runtime/agentRouterRuntime.js'
import { safeWorkspace } from './context/workspaceContext.js'
import LegacyCodexHarnessMigrationV1 from './migration/legacyCodexHarnessMigrationV1.js'
import ConversationRetrievalService from './retrieval/conversationRetrievalService.js'
import FunctionApiService from '../services/functionApiService.js'
import BodyWriteProposalService from './write/bodyWriteProposalService.js'
import { createBodyWriteProposalTools } from './tools/bodyWriteProposalTools.js'
import KnowledgeWriteProposalService from './write/knowledgeWriteProposalService.js'
import { createKnowledgeWriteProposalTools } from './tools/knowledgeWriteProposalTools.js'
import AgentModelConfigService from '../services/agentModelConfigService.js'
import { requestAgentCompletion } from '../services/agentCompletionClient.js'

const VALID_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function modelPreference(value) {
  const preference = typeof value === 'string' ? value.trim() : ''
  return preference && preference !== 'codex-default' && preference !== 'agent-default' && preference !== '[object Object]'
    ? preference
    : null
}

function effortPreference(value) {
  const preference = typeof value === 'string' ? value.trim() : ''
  return VALID_EFFORTS.has(preference) ? preference : null
}

export class DomainHarnessService extends EventEmitter {
  constructor({
    snapshotService,
    retrievalService,
    chapterWriteService,
    knowledgeDocumentService = null,
    knowledgeCatalogService = null,
    referenceIndexService = null,
    legacyStore = null,
    settingsStore = legacyStore,
    clientVersion = '0.0.0',
    getWindows = () => []
  } = {}) {
    super()
    this.snapshotService = snapshotService
    this.getWindows = getWindows
    this.store = new HarnessStore({ snapshotService })
    this.functionApi = new FunctionApiService({ store: settingsStore })
    this.agentModels = new AgentModelConfigService({ store: settingsStore })
    this.conversationRetrievalService = new ConversationRetrievalService({ store: this.store })
    this.bodyWriteProposals = new BodyWriteProposalService({
      store: this.store,
      snapshotService,
      chapterWriteService,
      eventSink: (event) => this.emitEvent(event)
    })
    this.knowledgeWriteProposals = knowledgeDocumentService
      ? new KnowledgeWriteProposalService({
          store: this.store,
          snapshotService,
          documentService: knowledgeDocumentService,
          catalogService: knowledgeCatalogService,
          referenceIndexService,
          eventSink: (event) => this.emitEvent(event)
        })
      : null
    this.tools = new DomainToolRegistry()
    createBookReadTools({
      retrievalService,
      conversationRetrievalService: this.conversationRetrievalService
    }).forEach((tool) => this.tools.register(tool))
    createBodyWriteProposalTools({ proposalService: this.bodyWriteProposals }).forEach((tool) =>
      this.tools.register(tool)
    )
    if (this.knowledgeWriteProposals) {
      createKnowledgeWriteProposalTools({ proposalService: this.knowledgeWriteProposals }).forEach(
        (tool) => this.tools.register(tool)
      )
    }
    const codexRuntime = new CodexAppServerRuntime({ clientVersion })
    const agentRuntime = new AgentApiRuntime({ configService: this.agentModels })
    const agentRouter = new AgentRouterRuntime({
      codexRuntime,
      agentRuntime,
      configService: this.agentModels
    })
    this.runtimes = new Map([
      ['fake', new FakeRuntime()],
      ['codex-app-server', codexRuntime],
      ['agent-api', agentRuntime],
      ['agent-router', agentRouter]
    ])
    this.coordinator = new TurnCoordinator({
      store: this.store,
      toolRegistry: this.tools,
      contextAssembler: new ContextAssembler(),
      runtimes: this.runtimes,
      eventSink: (event) => this.emitEvent(event),
      onTurnCompleted: (event) => this.handleTurnCompleted(event)
    })
    this.ready = this.initialize(legacyStore)
  }

  async initialize(legacyStore) {
    if (legacyStore)
      await new LegacyCodexHarnessMigrationV1({
        store: legacyStore,
        harnessStore: this.store,
        snapshotService: this.snapshotService
      }).migrate()
    await this.store.recoverAllKnownBooks()
  }

  emitEvent(event) {
    this.emit('event', event)
    for (const win of this.getWindows() || []) {
      if (win && !win.isDestroyed()) win.webContents.send('harness:event', event)
    }
  }
  validateBookName(bookName) {
    return (
      this.snapshotService.resolveBookPath(String(bookName || '').trim()) &&
      String(bookName || '').trim()
    )
  }
  async listConversations(bookName) {
    await this.ready
    this.validateBookName(bookName)
    return this.store.listConversations(bookName)
  }
  async createConversation({ bookName, title, runtimeId, model, effort, autoTitle }) {
    await this.ready
    this.validateBookName(bookName)
    return this.store.createConversation({
      bookKey: bookName,
      title,
      runtimeId,
      modelPreference: modelPreference(model),
      effortPreference: effortPreference(effort),
      autoTitle: autoTitle === true
    })
  }
  async readConversation({ bookName, conversationId }) {
    await this.ready
    this.validateBookName(bookName)
    return this.store.loadConversation(bookName, conversationId)
  }
  async archiveConversation({ bookName, conversationId }) {
    await this.ready
    const data = await this.readConversation({ bookName, conversationId })
    return this.store.archiveConversation(data.state)
  }
  async listModels() {
    await this.ready
    const runtime = this.runtimes.get('agent-router')
    return runtime.listModels()
  }
  getAgentModelConfig() {
    return this.agentModels.getConfig()
  }
  setAgentModelConfig(payload) {
    const providerId = payload?.providerId || payload?.selectedProvider
    return this.agentModels.saveProvider(providerId, payload || {})
  }
  async validateAgentModelConfig(payload) {
    const config = this.agentModels.saveProvider(payload?.providerId || payload?.selectedProvider, payload || {})
    const provider = this.agentModels.getProvider(config.selectedProvider)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      await requestAgentCompletion({
        provider,
        messages: [{ role: 'user', content: '只回复 OK' }],
        tools: [],
        signal: controller.signal,
        maxTokens: 8
      })
      return { success: true, isValid: true, message: 'Agent API 验证成功', config }
    } catch (error) {
      return { success: true, isValid: false, message: error?.name === 'AbortError' ? 'Agent API 验证超时' : error?.message || 'Agent API 验证失败', config }
    } finally {
      clearTimeout(timer)
    }
  }
  getFunctionApiConfig() {
    return this.functionApi.getConfig()
  }
  setFunctionApiConfig(payload) {
    return this.functionApi.setConfig(payload || {})
  }
  validateFunctionApiConfig(payload) {
    return this.functionApi.validateConfig(payload || {})
  }
  async handleTurnCompleted({ conversation, userText, assistantText, isFirstUserMessage }) {
    if (!isFirstUserMessage || conversation.autoTitleStatus !== 'pending') return
    const result = await this.functionApi.generateConversationTitle({ userMessage: userText, assistantMessage: assistantText })
    const state = await this.store.completeAutoTitle({
      bookKey: conversation.bookKey,
      conversationId: conversation.conversationId,
      title: result.title,
      generated: result.generated
    })
    this.emitEvent({
      type: 'conversation.updated',
      conversationId: state.conversationId,
      conversation: state
    })
  }
  async updateConversationSettings({ bookName, conversationId, model, effort, runtimeId }) {
    await this.ready
    const data = await this.readConversation({ bookName, conversationId })
    data.state.modelPreference = modelPreference(model)
    data.state.effortPreference = effortPreference(effort)
    if (runtimeId === 'agent-router' && data.state.status !== 'running') data.state.runtimeId = runtimeId
    const state = await this.store.updateState(data.state)
    if (data.runtime?.runtimeId !== state.runtimeId) {
      await this.store.updateRuntime(state, { ...data.runtime, runtimeId: state.runtimeId })
    }
    return state
  }
  async startTurn({ bookName, conversationId, text, workspace, model, effort }) {
    await this.ready
    const data = await this.readConversation({ bookName, conversationId })
    const selectedModel =
      model === undefined ? modelPreference(data.state.modelPreference) : modelPreference(model)
    const selectedEffort =
      effort === undefined
        ? effortPreference(data.state.effortPreference)
        : effortPreference(effort)
    return this.coordinator.startTurn(
      conversationId,
      text,
      { ...safeWorkspace(workspace), bookKey: data.state.bookKey },
      { model: selectedModel, effort: selectedEffort }
    )
  }
  async cancelTurn({ bookName, conversationId }) {
    await this.ready
    this.validateBookName(bookName)
    return this.coordinator.cancelTurn(conversationId)
  }
  async listWriteProposals({ bookName, conversationId }) {
    await this.ready
    this.validateBookName(bookName)
    const [body, knowledge] = await Promise.all([
      this.bodyWriteProposals.list({ bookName, conversationId }),
      this.knowledgeWriteProposals?.list({ bookName, conversationId }) || []
    ])
    return [...body, ...knowledge].sort((left, right) =>
      String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
    )
  }
  async proposalOwner(payload) {
    if (
      this.knowledgeWriteProposals &&
      (await this.knowledgeWriteProposals.findRecord(
        payload?.bookName,
        payload?.conversationId,
        payload?.proposalId
      ))
    ) {
      return this.knowledgeWriteProposals
    }
    return this.bodyWriteProposals
  }
  async rejectWriteProposal(payload) {
    await this.ready
    this.validateBookName(payload?.bookName)
    return (await this.proposalOwner(payload)).reject(payload || {})
  }
  async applyWriteProposal(payload) {
    await this.ready
    this.validateBookName(payload?.bookName)
    return (await this.proposalOwner(payload)).apply(payload || {})
  }
  async undoWriteProposal(payload) {
    await this.ready
    this.validateBookName(payload?.bookName)
    return (await this.proposalOwner(payload)).undo(payload || {})
  }
  async getStatus({ bookName, conversationId } = {}) {
    await this.ready
    if (!conversationId) return { runtimes: [...this.runtimes.keys()] }
    const data = await this.readConversation({ bookName, conversationId })
    const runtime = this.runtimes.get(data.state.runtimeId)
    return {
      conversationId,
      runtimeId: data.state.runtimeId,
      state: data.state.status,
      activeTurnId: data.state.activeTurnId,
      capabilities: runtime ? await runtime.getCapabilities() : null
    }
  }
  async dispose() {
    await this.ready
    for (const runtime of this.runtimes.values()) {
      if (typeof runtime.dispose === 'function') await runtime.dispose().catch(() => {})
      if (runtime.bridge) await runtime.bridge.stop().catch(() => {})
    }
  }
}

export default DomainHarnessService
