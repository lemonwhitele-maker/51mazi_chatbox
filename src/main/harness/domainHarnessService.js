import { EventEmitter } from 'node:events'
import HarnessStore from './store/harnessStore.js'
import DomainToolRegistry from './tools/domainToolRegistry.js'
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
import AgentModelConfigService from '../services/agentModelConfigService.js'
import { requestAgentCompletion } from '../services/agentCompletionClient.js'
import BookSandboxService from './sandbox/bookSandboxService.js'
import BookDocumentService from './documents/bookDocumentService.js'
import ReadSnapshotLedger from './documents/readSnapshotLedger.js'
import { createDocumentTools } from './tools/documentTools.js'
import DocumentWriteProposalService from './write/documentWriteProposalService.js'
import { HarnessError } from './harnessErrors.js'
import { publicWriteProposal } from './write/writeProposalStateMachine.js'

const VALID_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function modelPreference(value) {
  const preference = typeof value === 'string' ? value.trim() : ''
  return preference &&
    preference !== 'codex-default' &&
    preference !== 'agent-default' &&
    preference !== '[object Object]'
    ? preference
    : null
}

function effortPreference(value) {
  const preference = typeof value === 'string' ? value.trim() : ''
  return VALID_EFFORTS.has(preference) ? preference : null
}

import { resolveExecutionBudget } from '../services/agentBudgets.js'

export class DomainHarnessService extends EventEmitter {
  constructor({
    snapshotService,
    retrievalService,
    chapterWriteService,
    knowledgeDocumentService = null,
    isDocumentDirty = () => false,
    legacyStore = null,
    settingsStore = legacyStore,
    clientVersion = '0.0.0',
    getWindows = () => [],
    eventAudience = () => true
  } = {}) {
    super()
    const budgetSettings = settingsStore?.get?.('harness.budgets.v1', {}) || {}
    const executionBudget = resolveExecutionBudget(budgetSettings.execution)
    this.snapshotService = snapshotService
    this.getWindows = getWindows
    this.eventAudience = eventAudience
    this.bookSandbox = new BookSandboxService({
      booksDirProvider: () => snapshotService.getBooksDir()
    })
    if (chapterWriteService && !chapterWriteService.sandboxService)
      chapterWriteService.sandboxService = this.bookSandbox
    this.store = new HarnessStore({ snapshotService, sandboxService: this.bookSandbox })
    this.functionApi = new FunctionApiService({ store: settingsStore })
    this.agentModels = new AgentModelConfigService({ store: settingsStore })
    this.conversationRetrievalService = new ConversationRetrievalService({ store: this.store })
    this.readSnapshots = new ReadSnapshotLedger()
    this.bookDocuments = new BookDocumentService({
      readBudget: budgetSettings.tools,
      sandboxService: this.bookSandbox,
      retrievalService,
      conversationRetrievalService: this.conversationRetrievalService
    })
    this.documentWriteProposals = new DocumentWriteProposalService({
      store: this.store,
      documentService: this.bookDocuments,
      readSnapshotLedger: this.readSnapshots,
      knowledgeDocumentService,
      chapterWriteService,
      isDocumentDirty,
      eventSink: (event) => this.emitEvent(event)
    })
    this.documentTools = new DomainToolRegistry()
    createDocumentTools({
      documentService: this.bookDocuments,
      proposalService: this.documentWriteProposals
    }).forEach((tool) => this.documentTools.register(tool))
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
      ...executionBudget,
      store: this.store,
      toolRegistry: this.documentTools,
      contextAssembler: new ContextAssembler(),
      runtimes: this.runtimes,
      eventSink: (event) => this.emitEvent(event),
      onTurnCompleted: (event) => this.handleTurnCompleted(event),
      readSnapshotLedger: this.readSnapshots
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
      if (win && !win.isDestroyed() && this.eventAudience(win, event))
        win.webContents.send('harness:event', event)
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
  async createConversation({ bookName, title, runtimeId, model, effort, autoTitle, toolMode }) {
    await this.ready
    if (toolMode !== undefined && toolMode !== 'book-primitives-v1')
      throw new HarnessError('TOOL_MODE_INVALID', '只支持四工具模式')
    this.validateBookName(bookName)
    return this.store.createConversation({
      bookKey: bookName,
      title,
      runtimeId,
      modelPreference: modelPreference(model),
      effortPreference: effortPreference(effort),
      toolMode: 'book-primitives-v1',
      autoTitle: autoTitle === true
    })
  }
  async readConversation({ bookName, conversationId }) {
    await this.ready
    this.validateBookName(bookName)
    const data = await this.store.loadConversation(bookName, conversationId)
    if (data.state.toolMode !== 'book-primitives-v1') {
      data.state.toolMode = 'book-primitives-v1'
      await this.store.updateState(data.state)
    }
    return data
  }
  async archiveConversation({ bookName, conversationId }) {
    await this.ready
    const data = await this.readConversation({ bookName, conversationId })
    return this.store.archiveConversation(data.state)
  }
  async listModels(options) {
    await this.ready
    const runtime = this.runtimes.get('agent-router')
    return runtime.listModels(options)
  }
  getAgentModelConfig() {
    return this.agentModels.getConfig()
  }
  setAgentModelConfig(payload) {
    if (payload?.providers) return this.agentModels.setConfig(payload)
    const providerId = payload?.providerId || payload?.selectedProvider
    return this.agentModels.saveProvider(providerId, payload || {})
  }
  async validateAgentModelConfig(payload) {
    const provider = this.agentModels.prepareProvider(
      payload?.providerId || payload?.selectedProvider,
      payload || {}
    )
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      await requestAgentCompletion({
        provider,
        messages: [{ role: 'user', content: '只回复 OK' }],
        tools: [],
        signal: controller.signal,
        maxTokens: 4096
      })
      return { success: true, isValid: true, message: 'Agent API 验证成功（保存后可在对话中选择）' }
    } catch (error) {
      return {
        success: true,
        isValid: false,
        message:
          error?.name === 'AbortError'
            ? 'Agent API 验证超时'
            : error?.message || 'Agent API 验证失败'
      }
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
    const result = await this.functionApi.generateConversationTitle({
      userMessage: userText,
      assistantMessage: assistantText
    })
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
  async updateConversationSettings({ bookName, conversationId, model, effort, runtimeId, toolMode }) {
    await this.ready
    return this.store.withLock(String(conversationId), async () => {
      const data = await this.readConversation({ bookName, conversationId })
      if (data.state.status === 'running' || data.state.activeTurnId)
        throw new Error('请等待当前回复完成后再切换模型')
      data.state.modelPreference = modelPreference(model)
      data.state.effortPreference = effortPreference(effort)
      if (toolMode !== undefined && toolMode !== 'book-primitives-v1')
        throw new Error('不支持的工具模式')
      data.state.toolMode = 'book-primitives-v1'
      if (runtimeId === 'agent-router') data.state.runtimeId = runtimeId
      const state = await this.store.updateState(data.state)
      if (data.runtime?.runtimeId !== state.runtimeId) {
        await this.store.updateRuntime(state, { ...data.runtime, runtimeId: state.runtimeId })
      }
      return state
    })
  }
  async startTurn(
    { bookName, conversationId, text, workspace, model, effort },
    trustedScope = null
  ) {
    await this.ready
    if (!trustedScope?.scope || typeof trustedScope.assertScope !== 'function')
      throw new HarnessError('BOOK_SCOPE_MISMATCH', '当前轮次缺少窗口绑定的书籍范围')
    trustedScope?.assertScope?.()
    if (trustedScope.scope.bookKey !== bookName)
      throw new HarnessError('BOOK_SCOPE_MISMATCH', '轮次书籍与绑定书籍不一致')
    const data = await this.readConversation({ bookName, conversationId })
    const toolMode = 'book-primitives-v1'
    const selectedModel =
      model === undefined ? modelPreference(data.state.modelPreference) : modelPreference(model)
    const selectedEffort =
      effort === undefined
        ? effortPreference(data.state.effortPreference)
        : effortPreference(effort)
    // Old conversations also need the router when resumed from the unified chat UI.
    if (['agent-router', 'agent-api', 'codex-app-server'].includes(data.state.runtimeId)) {
      await this.updateConversationSettings({
        bookName,
        conversationId,
        model: selectedModel,
        effort: selectedEffort,
        runtimeId: 'agent-router'
      })
    }
    return this.coordinator.startTurn(
      conversationId,
      text,
      { ...safeWorkspace(workspace), bookKey: data.state.bookKey },
      {
        model: selectedModel,
        effort: selectedEffort,
        assertBookScope: trustedScope?.assertScope || null,
        bookScope: trustedScope?.scope || null,
        toolRegistry: this.documentTools,
        toolMode,
        requireBookSandbox: true,
        prepareRuntimeDirectory: trustedScope?.scope
          ? (turnId) =>
              this.bookSandbox.prepareInternalPath(
                trustedScope.scope,
                `.51mazi/harness/runtime/${turnId}`,
                { kind: 'directory' }
              )
          : null
      }
    )
  }
  async cancelTurn({ bookName, conversationId }) {
    await this.ready
    await this.readConversation({ bookName, conversationId })
    return this.coordinator.cancelTurn(conversationId)
  }
  async listWriteProposals({ bookName, conversationId }, trusted = {}) {
    await this.ready
    this.validateBookName(bookName)
    if (!trusted.scope || trusted.scope.bookKey !== bookName)
      throw new HarnessError('BOOK_SCOPE_MISMATCH', '提案列表与绑定书籍不一致')
    this.bookSandbox.assertScope(trusted.scope)
    const [body, knowledge, documents] = await Promise.all([
      this.store.readWriteProposals(bookName, conversationId),
      this.store.readKnowledgeProposals(bookName, conversationId),
      trusted.scope
        ? this.documentWriteProposals.list({
            conversationId,
            bookScope: trusted.scope,
            allowScopeRebind: trusted.allowScopeRebind
          })
        : []
    ])
    const legacy = [...body, ...knowledge].map((record) => ({
      ...publicWriteProposal(record),
      legacyReadOnly: true,
      requiresRegeneration: ['pending', 'failed'].includes(record.status),
      requiresReview: record.status === 'applying',
      confirmationAllowed: false
    }))
    return [...legacy, ...documents].sort((left, right) =>
      String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
    )
  }
  async rejectWriteProposal(payload, trusted = {}) {
    await this.ready
    this.validateBookName(payload?.bookName)
    if (trusted.document === true && trusted.scope?.bookKey !== payload?.bookName)
      throw new HarnessError('BOOK_SCOPE_MISMATCH', '提案书籍与绑定书籍不一致')
    if (trusted.document === true)
      return this.documentWriteProposals.reject(
        { conversationId: payload.conversationId, bookScope: trusted.scope },
        payload.proposalId,
        payload.revision
      )
    throw new Error('旧提案只保留历史记录，请使用四工具重新生成')
  }
  async applyWriteProposal(payload, trusted = {}) {
    await this.ready
    this.validateBookName(payload?.bookName)
    if (trusted.document === true && trusted.scope?.bookKey !== payload?.bookName)
      throw new HarnessError('BOOK_SCOPE_MISMATCH', '提案书籍与绑定书籍不一致')
    if (trusted.document === true)
      return this.documentWriteProposals.apply(
        { conversationId: payload.conversationId, bookScope: trusted.scope },
        payload
      )
    throw new Error('旧提案没有冻结候选，不能确认写入；请使用四工具重新生成')
  }
  async undoWriteProposal(payload, trusted = {}) {
    await this.ready
    this.validateBookName(payload?.bookName)
    if (trusted.document === true && trusted.scope?.bookKey !== payload?.bookName)
      throw new HarnessError('BOOK_SCOPE_MISMATCH', '提案书籍与绑定书籍不一致')
    if (trusted.document === true)
      return this.documentWriteProposals.undo(
        { conversationId: payload.conversationId, bookScope: trusted.scope },
        payload.proposalId
      )
    throw new Error('旧提案撤销入口已关闭，请在书籍历史中核对后处理')
  }
  async getStatus({ bookName, conversationId } = {}) {
    await this.ready
    if (!conversationId) {
      const router = this.runtimes.get('agent-router')
      return {
        runtimes: [...this.runtimes.keys()],
        bookSandboxRuntimes: await router.listBookSandboxRuntimes()
      }
    }
    const data = await this.readConversation({ bookName, conversationId })
    const runtime = this.runtimes.get(data.state.runtimeId)
    return {
      conversationId,
      runtimeId: data.state.runtimeId,
      toolMode: 'book-primitives-v1',
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
