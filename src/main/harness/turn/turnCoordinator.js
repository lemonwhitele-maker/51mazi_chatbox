import crypto from 'node:crypto'
import { createId } from '../ids.js'
import { assertRuntimeCapabilities, RUNTIME_TURN_BUDGET_V2 } from '../runtime/modelRuntime.js'
import { HarnessError, errorResult } from '../harnessErrors.js'
import { MemoryCompactor } from '../context/memoryCompactor.js'

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function argsDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex')}`
}

function textDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || '').replace(/\r\n?/g, '\n'), 'utf8').digest('hex')}`
}

function abortResult(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve({ kind: 'aborted' })
    signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true })
  })
}

export class TurnCoordinator {
  constructor({ store, toolRegistry, contextAssembler, runtimes, eventSink = () => {}, onTurnCompleted = () => {}, maxToolCalls = 12, maxToolRounds = 6, toolTimeoutMs = 30000, turnTimeoutMs = 180000, maxTurnTimeoutMs = 300000, toolConcurrency = 3, resultAckTimeoutMs = 5000 }) {
    this.store = store
    this.toolRegistry = toolRegistry
    this.contextAssembler = contextAssembler
    this.runtimes = runtimes
    this.eventSink = eventSink
    this.onTurnCompleted = onTurnCompleted
    this.maxToolCalls = maxToolCalls
    this.maxToolRounds = maxToolRounds
    this.toolTimeoutMs = toolTimeoutMs
    this.turnTimeoutMs = Math.min(Math.max(1, Number(turnTimeoutMs) || 180000), maxTurnTimeoutMs)
    this.toolConcurrency = Math.max(1, Math.min(3, Number(toolConcurrency) || 3))
    this.runtimeBudget = Object.freeze({
      ...RUNTIME_TURN_BUDGET_V2,
      maxAcceptedToolCalls: this.maxToolCalls,
      maxToolRounds: this.maxToolRounds,
      maxConcurrentReadTools: this.toolConcurrency,
      defaultToolTimeoutMs: this.toolTimeoutMs,
      resultAckTimeoutMs: Math.max(1, Number(resultAckTimeoutMs) || 5000)
    })
    this.active = new Map()
    this.compactor = new MemoryCompactor({ maxInputTokens: contextAssembler?.policy?.maxInputTokens || 24000 })
  }

  emit(event) { try { this.eventSink(event) } catch { /* UI subscribers must not break execution */ } }
  state(conversationId, turnId, value) { this.emit({ type: 'turn.state', conversationId, turnId, state: value }) }
  diagnostic(active, code, details = {}) { this.emit({ type: 'diagnostic', code, conversationId: active?.conversation?.conversationId || null, turnId: active?.turnId || null, ...details }) }

  async startTurn(conversationId, text, workspace = {}, options = {}) {
    const key = String(conversationId)
    return this.store.withLock(key, async () => {
      const bookKey = String(workspace.bookKey || '').trim()
      const conversation = await this.store.loadConversation(bookKey, conversationId)
      const state = conversation.state
      if (state.status === 'archived') throw new HarnessError('CONVERSATION_ARCHIVED', '归档对话不能继续发送')
      if (state.activeTurnId || state.status === 'running') throw new HarnessError('TURN_ALREADY_RUNNING', '当前对话已有进行中的 Turn')
      const content = String(text || '').trim()
      if (!content) throw new HarnessError('EMPTY_USER_MESSAGE', '消息不能为空')
      const runtime = this.runtimes.get(state.runtimeId)
      if (!runtime) throw new HarnessError('RUNTIME_NOT_FOUND', `找不到 Runtime：${state.runtimeId}`)
      const turnId = createId('turn')
      const messageId = createId('msg')
      const isFirstUserMessage = !conversation.transcript.some((item) => item.type === 'message.user')
      state.activeTurnId = turnId
      state.status = 'running'
      const persistedWorkspace = {
        currentModule: workspace.currentModule || null,
        currentDocumentId: workspace.currentDocumentId || null,
        currentEntityId: workspace.currentEntityId || null,
        selectionText: workspace.selectionText || '',
        selectionRange: workspace.selectionRange || null,
        editorRange: workspace.editorRange || null,
        textRange: workspace.textRange || null,
        currentDocumentSavedHash: workspace.currentDocumentSavedHash || null,
        hasUnsavedChanges: workspace.hasUnsavedChanges === true,
        metadata: workspace.metadata || {}
      }
      const userEvent = await this.store.appendTranscript(state, 'message.user', turnId, messageId, { text: content, workspace: persistedWorkspace })
      await this.store.appendTranscript(state, 'turn.started', turnId, null, { runtimeId: state.runtimeId })
      this.state(state.conversationId, turnId, 'preparing')
      let capabilities
      try {
        capabilities = await assertRuntimeCapabilities(runtime)
      } catch (error) {
        state.status = 'error'
        state.activeTurnId = null
        await this.store.appendTranscript(state, 'turn.failed', turnId, null, {
          code: error.code || 'RUNTIME_UNAVAILABLE',
          message: error.message || 'Runtime 不可用',
          retryable: true
        })
        await this.store.updateState(state)
        this.emit({
          type: 'turn.error',
          conversationId: state.conversationId,
          turnId,
          code: error.code || 'RUNTIME_UNAVAILABLE',
          message: error.message || 'Runtime 不可用',
          retryable: true
        })
        this.state(state.conversationId, turnId, 'failed')
        throw error
      }
      const controller = new AbortController()
      const active = {
        conversation: state,
        turnId,
        controller,
        runtime,
        workspace,
        finalText: '',
        references: [],
        completed: false,
        completedState: null,
        abortReason: null,
        toolCalls: new Map(),
        toolCallSignatures: new Map(),
        roundKeys: new Set(),
        pendingTools: new Set(),
        pendingReadTools: new Set(),
        evidenceReferences: new Map(),
        runningTools: 0,
        toolQueue: [],
        toolControllers: new Set(),
        deadlineTimer: null,
        userEvent,
        userText: content,
        isFirstUserMessage,
        runtimeSnapshotDigest: null
      }
      this.active.set(state.conversationId, active)
      // Only expose the persisted running state after cancellation can find the
      // in-memory turn. This closes the startup window where the UI could see a
      // running turn that cancelTurn() could not yet address.
      await this.store.updateState(state)
      active.deadlineTimer = setTimeout(() => {
        if (active.completed) return
        active.abortReason = 'timeout'
        active.controller.abort()
        void runtime.cancelTurn({ conversationId: state.conversationId, turnId }).catch(() => {})
      }, this.turnTimeoutMs)
      try {
        const transcript = [...conversation.transcript, userEvent]
        let context = this.contextAssembler.assemble({ conversation: state, transcript, memory: conversation.memory, workspace, userText: content, runtimeCapabilities: capabilities })
        if (this.compactor.shouldCompact(context.estimatedInputTokens, transcript)) {
          const memory = this.compactor.compact({ conversationId: state.conversationId, transcript, previous: conversation.memory, sourceReferences: active.references })
          await this.store.updateMemory(state, memory)
          conversation.memory = memory
          context = this.contextAssembler.assemble({ conversation: state, transcript, memory, workspace, userText: content, runtimeCapabilities: capabilities })
        }
        this.state(state.conversationId, turnId, 'model_running')
        const input = {
          conversationId: state.conversationId,
          turnId,
          model: options.model || null,
          effort: options.effort || null,
          instructions: {
            baseInstructions: context.instructions.base.text,
            developerInstructions: context.instructions.developer.text,
            schemaVersion: context.instructions.base.schemaVersion,
            baseHash: context.instructions.base.contentHash,
            developerHash: context.instructions.developer.contentHash
          },
          contextText: context.contextText,
          userText: context.userText,
          inputText: context.inputText,
          tools: this.toolRegistry.listDefinitions(),
          signal: controller.signal,
          budget: context.budget,
          runtimeBudget: this.runtimeBudget
        }
        const runtimeSnapshot = {
          runtimeId: state.runtimeId,
          providerModel: input.model,
          isolatedTurn: true,
          protocolVersion: String(runtime.protocolVersion || '2'),
          contractVersion: '2',
          toolsetHash: this.toolRegistry.getToolsetHash(),
          promptHash: textDigest(`${input.instructions.baseInstructions}\n${input.instructions.developerInstructions}`),
          lastHealthyAt: new Date().toISOString(),
          metadata: conversation.runtime?.metadata || {}
        }
        active.runtimeSnapshotDigest = argsDigest(runtimeSnapshot)
        await this.store.updateRuntime(state, runtimeSnapshot)
        await this.store.appendTranscript(state, 'turn.runtime.snapshot', turnId, null, {
          ...runtimeSnapshot,
          runtimeSnapshotDigest: active.runtimeSnapshotDigest
        })
        const iterator = runtime.streamTurn(input)[Symbol.asyncIterator]()
        while (!active.completed) {
          let next
          try {
            next = await Promise.race([iterator.next(), abortResult(controller.signal)])
          } catch (error) {
            if (!active.completed) await this.finishFailed(active, { code: error.code || 'RUNTIME_EOF', message: error.message || 'Runtime 读取失败', retryable: true })
            break
          }
          if (next?.kind === 'aborted') {
            if (active.abortReason === 'timeout') await this.finishFailed(active, { code: 'TURN_TIMEOUT', message: '本轮执行超时', retryable: true })
            else await this.finishCancelled(active, active.abortReason || 'cancelled')
            break
          }
          if (next?.kind === 'timeout') {
            active.abortReason = 'timeout'
            active.controller.abort()
            await this.finishFailed(active, { code: 'TURN_TIMEOUT', message: '本轮执行超时', retryable: true })
            break
          }
          if (!next || next.done) break
          await this.handleEvent(active, next.value)
        }
        if (!active.completed) {
          if (active.abortReason === 'timeout') await this.finishFailed(active, { code: 'TURN_TIMEOUT', message: '本轮执行超时', retryable: true })
          else if (controller.signal.aborted) await this.finishCancelled(active, active.abortReason || 'cancelled')
          else await this.finishFailed(active, { code: 'RUNTIME_EOF', message: 'Runtime 未返回终态', retryable: true })
        }
        try { const returned = iterator.return?.(); returned?.catch?.(() => {}) } catch { /* runtime cleanup is best effort */ }
        return { conversationId: state.conversationId, turnId, state: active.completedState, message: active.finalText || null }
      } catch (error) {
        if (!active.completed) {
          if (error.code === 'USER_INPUT_TOO_LARGE') await this.finishFailed(active, error)
          else await this.finishFailed(active, { code: error.code || 'TURN_FAILED', message: error.message || 'Turn 执行失败', retryable: Boolean(error.retryable) })
        }
        throw error
      } finally {
        clearTimeout(active.deadlineTimer)
        active.controller.abort()
        for (const child of active.toolControllers) child.abort()
        try { await runtime.disposeTurn({ conversationId: state.conversationId, turnId }) } catch { /* cleanup is best effort */ }
        this.active.delete(state.conversationId)
      }
    })
  }

  async handleEvent(active, event = {}) {
    if (active.completed) { this.diagnostic(active, 'LATE_EVENT_DROPPED', { eventType: event.type }); return }
    if (event.type === 'message.delta') { this.emit({ type: 'message.delta', conversationId: active.conversation.conversationId, turnId: active.turnId, delta: String(event.text || '') }); return }
    if (event.type === 'message.completed') {
      active.finalText = String(event.text || active.finalText)
      active.references = [...new Set([...active.references, ...(event.references || [])])]
      this.emit({ type: 'message.completed', conversationId: active.conversation.conversationId, turnId: active.turnId, message: { id: createId('msg-stream'), role: 'assistant', text: active.finalText, references: active.references } })
      return
    }
    if (event.type === 'usage') { await this.store.appendTranscript(active.conversation, 'runtime.usage', active.turnId, null, { ...event }); return }
    if (event.type === 'tool.call') {
      const task = this.handleToolCall(active, event)
      active.pendingTools.add(task)
      const risk = this.toolRegistry.get(event.name)?.risk || 'read'
      if (risk === 'read') active.pendingReadTools.add(task)
      task
        .catch((error) => this.diagnostic(active, 'TOOL_TASK_FAILED', { message: error.message }))
        .finally(() => {
          active.pendingTools.delete(task)
          if (risk === 'read') active.pendingReadTools.delete(task)
        })
      return
    }
    if (event.type === 'turn.cancelled') { await this.finishCancelled(active, event.reason || 'runtime-cancelled'); return }
    if (event.type === 'turn.failed') { await this.finishFailed(active, event); return }
    if (event.type === 'turn.completed') {
      await Promise.all([...active.pendingTools])
      await this.finishCompleted(active, event.stopReason)
    }
  }

  async acquireToolSlot(active) {
    if (active.controller.signal.aborted) return false
    if (active.runningTools < this.toolConcurrency) { active.runningTools += 1; return true }
    return new Promise((resolve) => {
      const entry = { resolve }
      active.toolQueue.push(entry)
      active.controller.signal.addEventListener('abort', () => {
        const index = active.toolQueue.indexOf(entry)
        if (index >= 0) active.toolQueue.splice(index, 1)
        resolve(false)
      }, { once: true })
    })
  }

  releaseToolSlot(active) {
    const next = active.toolQueue.shift()
    if (next && !active.controller.signal.aborted) next.resolve(true)
    else active.runningTools = Math.max(0, active.runningTools - 1)
  }

  async submitResult(active, providerCallId, result) {
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 'ack_timeout' }), this.runtimeBudget.resultAckTimeoutMs)
    })
    const ack = await Promise.race([
      active.runtime.submitToolResult({
        conversationId: active.conversation.conversationId,
        turnId: active.turnId,
        providerCallId,
        result
      }),
      timeout
    ])
    clearTimeout(timer)
    if (ack?.status !== 'accepted') {
      const error = new HarnessError('TOOL_RESULT_DELIVERY_FAILED', `工具结果未被 Runtime 接收：${ack?.status || 'missing_ack'}`, {
        retryable: ack?.status === 'ack_timeout',
        category: 'runtime',
        retryStrategy: 'new_turn',
        terminal: true
      })
      this.diagnostic(active, error.code, { providerCallId, ackStatus: ack?.status || 'missing_ack' })
      if (!active.completed) await this.finishFailed(active, error)
      active.abortReason = 'runtime-error'
      active.controller.abort()
      void active.runtime.cancelTurn({
        conversationId: active.conversation.conversationId,
        turnId: active.turnId
      }).catch(() => {})
      throw error
    }
    return ack
  }

  async handleToolCall(active, event) {
    const providerCallId = String(event.providerCallId || '').trim()
    const name = String(event.name || '')
    if (!providerCallId) {
      const result = errorResult(new HarnessError('TOOL_CALL_INVALID', '工具调用缺少唯一 call ID'), 'TOOL_CALL_INVALID')
      this.diagnostic(active, 'TOOL_CALL_INVALID', { toolName: name })
      return result
    }
    const previous = active.toolCalls.get(providerCallId)
    if (previous) {
      const result = await previous.promise
      if (!active.completed) await this.submitResult(active, providerCallId, result)
      return result
    }
    const providerRoundId = event.roundId ?? event.toolRound ?? event.batchId
    const roundKey = providerRoundId == null ? '' : String(providerRoundId).trim()
    if (roundKey) {
      if (!active.roundKeys.has(roundKey) && active.roundKeys.size >= this.maxToolRounds)
        return this.rejectToolLimit(active, providerCallId, name, {}, 'TOOL_LIMIT_REACHED')
      active.roundKeys.add(roundKey)
    }
    if (active.toolCalls.size >= this.maxToolCalls)
      return this.rejectToolLimit(active, providerCallId, name, {}, 'TOOL_LIMIT_REACHED')

    let args = event.arguments
    let parseError = event.argumentsParseError || null
    if (!parseError && event.argumentsJson !== undefined && (!args || typeof args !== 'object')) {
      try { args = JSON.parse(String(event.argumentsJson)) } catch (error) { parseError = error.message }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      parseError ||= 'arguments 必须是 JSON object'
      args = {}
    }
    if (parseError) {
      const toolCallId = createId('tool-invalid-json')
      const digest = argsDigest(String(event.argumentsJson || ''))
      const result = errorResult(new HarnessError(
        'TOOL_ARGUMENT_JSON_INVALID',
        '工具参数不是有效的 JSON object',
        {
          category: 'validation', retryStrategy: 'repair_arguments', terminal: false,
          violations: [{ path: '/', keyword: 'parse', message: parseError, params: {} }]
        }
      ), 'TOOL_ARGUMENT_JSON_INVALID')
      const entry = { toolCallId, argsDigest: digest, state: 'failed', result, promise: Promise.resolve(result) }
      active.toolCalls.set(providerCallId, entry)
      await this.store.appendLedger(active.conversation, {
        turnId: active.turnId, toolCallId, toolName: name, toolVersion: this.toolRegistry.get(name)?.version || 'unknown',
        state: 'failed', validation: 'rejected', argsDigest: digest,
        runtimeSnapshotDigest: active.runtimeSnapshotDigest, references: [], truncated: false,
        errorCode: result.error.code, errorMessage: result.error.message
      })
      await this.submitResult(active, providerCallId, result)
      return result
    }
    const digest = argsDigest(args)
    const signature = `${name}:${digest}`
    const duplicate = active.toolCallSignatures.get(signature)
    if (duplicate) {
      const result = await duplicate.promise
      const toolCallId = createId('tool-deduplicated')
      await this.store.appendLedger(active.conversation, {
        turnId: active.turnId,
        toolCallId,
        toolName: name,
        toolVersion: this.toolRegistry.get(name)?.version || 'unknown',
        state: result.ok ? 'completed' : 'failed',
        validation: 'deduplicated',
        argsDigest: digest,
        runtimeSnapshotDigest: active.runtimeSnapshotDigest,
        references: result.references || [],
        truncated: Boolean(result.truncated),
        errorCode: result.error?.code || null,
        errorMessage: result.error?.message || null,
        deduplicatedFromToolCallId: duplicate.toolCallId
      })
      if (!active.completed) {
        await this.submitResult(active, providerCallId, result)
      }
      this.diagnostic(active, 'TOOL_CALL_DEDUPLICATED', {
        toolName: name,
        toolCallId,
        deduplicatedFromToolCallId: duplicate.toolCallId
      })
      return result
    }
    const toolCallId = createId('tool')
    const toolRisk = this.toolRegistry.get(name)?.risk || 'read'
    const queuedText = toolRisk === 'proposal' ? '等待创建正文修改提案' : '等待读取书籍资料'
    const runningText = toolRisk === 'proposal' ? '正在创建正文修改提案' : '正在读取书籍资料'
    const completedText = toolRisk === 'proposal' ? '正文修改提案已创建，等待确认' : '书籍资料已返回'
    let resolveResult
    const resultPromise = new Promise((resolve) => { resolveResult = resolve })
    const roundOrdinal = roundKey ? [...active.roundKeys].indexOf(roundKey) + 1 : active.roundKeys.size + 1
    const toolCallEntry = { toolCallId, argsDigest: digest, state: 'queued', promise: resultPromise, roundOrdinal }
    active.toolCalls.set(providerCallId, toolCallEntry)
    active.toolCallSignatures.set(signature, toolCallEntry)
    const ledgerBase = { turnId: active.turnId, toolCallId, toolName: name, toolVersion: this.toolRegistry.get(name)?.version || 'unknown', validation: 'pending', argsDigest: digest, runtimeSnapshotDigest: active.runtimeSnapshotDigest, references: [], truncated: false }
    await this.store.appendLedger(active.conversation, { ...ledgerBase, state: 'queued', errorCode: null })
    this.state(active.conversation.conversationId, active.turnId, 'tool_requested')
    this.emit({ type: 'tool.state', conversationId: active.conversation.conversationId, turnId: active.turnId, toolCallId, toolName: name, state: 'queued', displayText: queuedText })
    const task = (async () => {
      if (toolRisk === 'proposal' && active.pendingReadTools.size) {
        await Promise.all([...active.pendingReadTools])
      }
      const acquired = await this.acquireToolSlot(active)
      if (!acquired) {
        const result = errorResult(new HarnessError('TOOL_CANCELLED', '工具调用已取消'), 'TOOL_CANCELLED')
        resolveResult(result)
        return result
      }
      const toolController = new AbortController()
      active.toolControllers.add(toolController)
      const onAbort = () => toolController.abort()
      active.controller.signal.addEventListener('abort', onAbort, { once: true })
      let result
      try {
        active.toolCalls.get(providerCallId).state = 'running'
        this.state(active.conversation.conversationId, active.turnId, 'tool_running')
        this.emit({ type: 'tool.state', conversationId: active.conversation.conversationId, turnId: active.turnId, toolCallId, toolName: name, state: 'running', displayText: runningText })
        await this.store.appendLedger(active.conversation, { ...ledgerBase, state: 'running', errorCode: null })
        const execution = this.toolRegistry.execute(name, {
          bookKey: active.conversation.bookKey,
           conversationId: active.conversation.conversationId,
           turnId: active.turnId,
           toolCallId,
           idempotencyEnforced: true,
           currentModule: active.workspace.currentModule || null,
           currentDocumentId: active.workspace.currentDocumentId || null,
           workspace: active.workspace,
           conversationState: active.conversation,
           evidenceEnforced: true,
           evidenceReferences: [...active.evidenceReferences.values()].filter(
             (item) => item.resultAckedAt && item.roundOrdinal < roundOrdinal
           )
         }, args, toolController.signal)
        let timeoutHandle
        const timeoutMs = this.toolRegistry.get(name)?.timeoutMs || this.toolTimeoutMs
        const timeout = new Promise((resolve) => { timeoutHandle = setTimeout(() => { toolController.abort(); resolve(errorResult(new HarnessError('TOOL_TIMEOUT', '工具调用超时', { retryable: true, category: 'transient', retryStrategy: 'retry_once', terminal: false }), 'TOOL_TIMEOUT')) }, timeoutMs) })
        result = await Promise.race([execution, timeout])
        clearTimeout(timeoutHandle)
        if (result?.error?.code === 'TOOL_TIMEOUT') {
          await Promise.race([
            execution.catch(() => null),
            new Promise((resolve) => setTimeout(resolve, this.runtimeBudget.resultAckTimeoutMs))
          ])
        }
        if (!result) result = errorResult(new HarnessError('TOOL_EXECUTION_FAILED', '工具没有返回结果'))
      } finally {
        active.controller.signal.removeEventListener('abort', onAbort)
        active.toolControllers.delete(toolController)
        this.releaseToolSlot(active)
      }
      const entry = active.toolCalls.get(providerCallId)
      entry.state = result.ok ? 'completed' : result.error?.code === 'TOOL_TIMEOUT' ? 'failed' : 'failed'
      entry.result = result
      await this.store.appendLedger(active.conversation, { ...ledgerBase, state: entry.state, validation: result.ok ? 'passed' : 'failed', references: result.references || [], truncated: Boolean(result.truncated), errorCode: result.error?.code || null, errorMessage: result.error?.message || null })
      this.emit({ type: 'tool.state', conversationId: active.conversation.conversationId, turnId: active.turnId, toolCallId, toolName: name, state: result.ok ? 'completed' : 'failed', displayText: result.ok ? completedText : result.error?.message || '工具调用失败', references: result.references || [] })
      resolveResult(result)
      if (!active.completed) {
        await this.submitResult(active, providerCallId, result)
        if (result.ok && toolRisk === 'read') {
          const resultAckedAt = new Date().toISOString()
          active.references = [...new Set([...active.references, ...(result.references || [])])]
          if (name === 'read_book_source') {
            for (const reference of result.references || []) {
              active.evidenceReferences.set(reference, {
                reference,
                authorityStatus: result.data?.authorityStatus || null,
                savedHash: result.data?.savedHash || null,
                scope: result.data?.sourceType || result.data?.scope || null,
                objectId: result.data?.objectId || null,
                truncated: Boolean(result.data?.truncated || result.truncated),
                normalizedLocator: result.data?.normalizedLocator || null,
                returnedCoverage: result.data?.returnedCoverage || result.data?.range || null,
                roundOrdinal,
                resultDeliveredAt: resultAckedAt,
                resultAckedAt,
                toolName: name
              })
            }
          }
        }
        if (result.error?.retryable && active.toolCallSignatures.get(signature) === entry) {
          active.toolCallSignatures.delete(signature)
        }
        this.state(active.conversation.conversationId, active.turnId, 'model_running')
      }
      return result
    })()
    active.toolCalls.get(providerCallId).promise = task
    return task
  }

  async rejectToolLimit(active, providerCallId, name, args, code) {
    const result = errorResult(new HarnessError(code, '本轮已达到工具调用上限，请基于已有证据回答并说明不足。'), code)
    await this.submitResult(active, providerCallId, result)
    await this.store.appendLedger(active.conversation, { turnId: active.turnId, toolCallId: createId('tool-limit'), toolName: name, toolVersion: this.toolRegistry.get(name)?.version || 'unknown', state: 'failed', validation: 'rejected', argsDigest: argsDigest(args), runtimeSnapshotDigest: active.runtimeSnapshotDigest, references: [], truncated: false, errorCode: code, errorMessage: result.error.message })
    this.emit({ type: 'tool.state', conversationId: active.conversation.conversationId, turnId: active.turnId, toolCallId: null, toolName: name, state: 'failed', displayText: result.error.message })
    return result
  }

  async finishCompleted(active, stopReason) {
    if (active.completed) return
    if (!active.finalText.trim()) return this.finishFailed(active, { code: 'EMPTY_MODEL_RESPONSE', message: '模型未返回最终回答', retryable: true })
    active.completed = true
    active.completedState = 'completed'
    const messageId = createId('msg')
    await this.store.appendTranscript(active.conversation, 'message.assistant', active.turnId, messageId, { text: active.finalText, references: active.references })
    await this.store.appendTranscript(active.conversation, 'turn.completed', active.turnId, messageId, { stopReason: stopReason || null, references: active.references })
    active.conversation.status = 'idle'
    active.conversation.activeTurnId = null
    active.conversation.lastCompletedMessageId = messageId
    await this.store.updateState(active.conversation)
    this.state(active.conversation.conversationId, active.turnId, 'completed')
    try {
      const callbackResult = this.onTurnCompleted({
        conversation: { ...active.conversation },
        userEvent: active.userEvent,
        userText: active.userText,
        assistantText: active.finalText,
        isFirstUserMessage: active.isFirstUserMessage
      })
      callbackResult?.catch?.(() => {})
    } catch { /* background UX helpers must not break a Turn */ }
  }

  async finishFailed(active, event) {
    if (active.completed) return
    active.completed = true
    active.completedState = 'failed'
    active.conversation.status = 'error'
    active.conversation.activeTurnId = null
    await this.store.appendTranscript(active.conversation, 'turn.failed', active.turnId, null, { code: event.code || 'TURN_FAILED', message: event.message || 'Turn 失败', retryable: Boolean(event.retryable) })
    await this.store.updateState(active.conversation)
    this.emit({ type: 'turn.error', conversationId: active.conversation.conversationId, turnId: active.turnId, code: event.code || 'TURN_FAILED', message: event.message || 'Turn 失败', retryable: Boolean(event.retryable) })
    this.state(active.conversation.conversationId, active.turnId, 'failed')
  }

  async finishCancelled(active, reason) {
    if (active.completed) return
    active.completed = true
    active.completedState = 'cancelled'
    active.controller.abort()
    active.conversation.status = 'idle'
    active.conversation.activeTurnId = null
    await this.store.appendTranscript(active.conversation, 'turn.cancelled', active.turnId, null, { reason: reason || 'cancelled', code: 'TURN_CANCELLED' })
    await this.store.updateState(active.conversation)
    this.state(active.conversation.conversationId, active.turnId, 'cancelled')
  }

  async cancelTurn(conversationId) {
    const active = this.active.get(String(conversationId))
    if (!active) return false
    active.abortReason = 'cancelled'
    active.controller.abort()
    try { await active.runtime.cancelTurn({ conversationId: active.conversation.conversationId, turnId: active.turnId }) } catch { /* local cancellation still wins */ }
    await this.finishCancelled(active, 'user-requested')
    return true
  }
}

export { argsDigest }
export default TurnCoordinator
