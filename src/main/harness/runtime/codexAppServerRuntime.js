import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import CodexAppServerBridge from '../../services/codexAppServerBridge.js'

function queue() {
  const items = []
  const waiters = []
  let closed = false
  return {
    push(item) { if (closed) return; const waiter = waiters.shift(); if (waiter) waiter(item); else items.push(item) },
    close() { closed = true; while (waiters.length) waiters.shift()(null) },
    next() { if (items.length) return Promise.resolve(items.shift()); if (closed) return Promise.resolve(null); return new Promise((resolve) => waiters.push(resolve)) }
  }
}

function deferred() { let resolve; const promise = new Promise((res) => { resolve = res }); return { promise, resolve } }
function toolArguments(value) {
  if (value && typeof value === 'object') return { arguments: value }
  const argumentsJson = String(value ?? '')
  try { return { arguments: JSON.parse(argumentsJson), argumentsJson } }
  catch (error) { return { argumentsJson, argumentsParseError: error.message } }
}
function providerKey(threadId, turnId) { return `${String(threadId || '')}:${String(turnId || '')}` }
function resultResponse(result) { return { success: result?.ok !== false, contentItems: [{ type: 'inputText', text: JSON.stringify(result || {}) }] } }

export class CodexAppServerRuntime {
  constructor({ clientVersion = '0.0.0', bridge = null } = {}) {
    this.id = 'codex-app-server'
    this.bridge = bridge || new CodexAppServerBridge({ clientVersion, experimentalApi: true })
    this.active = new Map()
    this.providerIndex = new Map()
    this.protocolVersion = '0.145.0'
    this.capabilities = { streaming: true, nativeToolCalling: true, isolatedTurn: true, cancellableTurn: true, instructionChannels: true, dynamicTools: true, usageReporting: true, contextWindowTokens: 32768, maxOutputTokens: 4096, experimental: ['dynamicTools'] }
    this.unregisterToolRouter = this.bridge.registerServerRequestHandler('item/tool/call', (params) => this.routeToolCall(params))
  }

  async getCapabilities() { return this.capabilities }

  async listModels() {
    await this.bridge.start()
    return this.bridge.listModels()
  }

  async routeToolCall(params = {}) {
    const threadId = String(params.threadId || '').trim()
    const turnId = String(params.turnId || '').trim()
    const providerCallId = String(params.callId || '').trim()
    const execution = this.providerIndex.get(providerKey(threadId, turnId)) || this.providerIndex.get(providerKey(threadId, ''))
    if (!execution || !providerCallId) return resultResponse({ ok: false, error: { code: 'UNKNOWN_PROVIDER_EXECUTION', message: '未知的 Runtime 工具执行，已拒绝请求', retryable: false } })
    if (execution.toolResults.has(providerCallId)) return execution.toolResults.get(providerCallId)
    const existing = execution.toolWaiters.get(providerCallId)
    if (existing) return existing.promise
    const wait = deferred()
    execution.toolWaiters.set(providerCallId, wait)
    execution.events.push({ type: 'tool.call', providerCallId, providerThreadId: threadId, providerTurnId: turnId, name: String(params.tool || ''), ...toolArguments(params.arguments) })
    return wait.promise
  }

  async *streamTurn(input) {
    const cwd = await fs.mkdtemp(join(tmpdir(), '51mazi-harness-codex-'))
    const events = queue()
    const execution = { input, events, toolWaiters: new Map(), toolResults: new Map(), cwd, threadId: null, turnId: null, done: false }
    this.active.set(input.turnId, execution)
    const onNotification = (message) => {
      const params = message?.params || {}
      if (params.threadId && execution.threadId && String(params.threadId) !== execution.threadId) return
      if (params.turnId && execution.turnId && String(params.turnId) !== execution.turnId) return
      if (message.method === 'item/agentMessage/delta') events.push({ type: 'message.delta', text: params.delta || params.text || '' })
      else if (message.method === 'item/completed' && params.item?.type === 'agentMessage') events.push({ type: 'message.completed', text: params.item.text || params.item.content || '', providerItemId: params.item.id, references: params.item.references || [] })
      else if (message.method === 'turn/completed') { events.push({ type: 'turn.completed', stopReason: params.turn?.status || 'completed' }); events.close() }
      else if (message.method === 'turn/failed') { events.push({ type: 'turn.failed', code: params.error?.code || 'RUNTIME_FAILED', message: params.error?.message || 'Runtime Turn 失败', retryable: false }); events.close() }
      else if (message.method === 'tokenCount/updated') events.push({ type: 'usage', inputTokens: params.inputTokens, outputTokens: params.outputTokens, totalTokens: params.totalTokens })
    }
    const onFatal = (error) => { if (!execution.done) { events.push({ type: 'turn.failed', code: 'RUNTIME_EXITED', message: error?.message || 'Codex Runtime 已退出', retryable: true }); events.close() } }
    this.bridge.on('notification', onNotification)
    this.bridge.on('fatal-error', onFatal)
    try {
      await this.bridge.start()
      const dynamicTools = input.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
      const threadResult = await this.bridge.request('thread/start', {
        cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        serviceName: '51mazi-harness',
        baseInstructions: input.instructions?.baseInstructions || null,
        developerInstructions: input.instructions?.developerInstructions || null,
        dynamicTools
      })
      execution.threadId = String(threadResult?.thread?.id || threadResult?.id || '')
      if (!execution.threadId) throw Object.assign(new Error('Codex Runtime 未返回临时执行 ID'), { code: 'RUNTIME_PROTOCOL_INVALID' })
      this.providerIndex.set(providerKey(execution.threadId, ''), execution)
      const turnParams = {
        threadId: execution.threadId,
        input: [{ type: 'text', text: input.contextText || '' }, { type: 'text', text: input.userText || '' }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      }
      if (input.model) turnParams.model = input.model
      if (input.effort) turnParams.effort = input.effort
      const turnResult = await this.bridge.request('turn/start', turnParams)
      execution.turnId = String(turnResult?.turn?.id || turnResult?.id || '')
      if (!execution.turnId) throw Object.assign(new Error('Codex Runtime 未返回临时 Turn ID'), { code: 'RUNTIME_PROTOCOL_INVALID' })
      this.providerIndex.delete(providerKey(execution.threadId, ''))
      this.providerIndex.set(providerKey(execution.threadId, execution.turnId), execution)
      while (true) {
        const next = await Promise.race([events.next(), new Promise((resolve) => {
          if (input.signal.aborted) return resolve({ type: 'turn.cancelled', reason: 'cancelled' })
          input.signal.addEventListener('abort', () => resolve({ type: 'turn.cancelled', reason: 'cancelled' }), { once: true })
        })])
        if (!next) break
        yield next
        if (next.type === 'turn.completed' || next.type === 'turn.failed' || next.type === 'turn.cancelled') break
      }
    } finally {
      execution.done = true
      for (const waiter of execution.toolWaiters.values()) waiter.resolve(resultResponse({ ok: false, error: { code: 'TURN_CANCELLED', message: 'Turn 已结束', retryable: false } }))
      execution.toolWaiters.clear()
      if (execution.threadId) {
        this.providerIndex.delete(providerKey(execution.threadId, ''))
        if (execution.turnId) this.providerIndex.delete(providerKey(execution.threadId, execution.turnId))
      }
      this.bridge.removeListener('notification', onNotification)
      this.bridge.removeListener('fatal-error', onFatal)
      events.close()
      this.active.delete(input.turnId)
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
    }
  }

  async submitToolResult({ turnId, providerCallId, result }) {
    const execution = this.active.get(turnId)
    if (!execution) return { status: 'turn_missing' }
    if (execution.done) return { status: 'turn_closed' }
    if (!execution.toolWaiters.has(String(providerCallId)) && !execution.toolResults.has(String(providerCallId))) return { status: 'call_missing' }
    const response = resultResponse(result)
    execution.toolResults.set(String(providerCallId), response)
    const wait = execution.toolWaiters.get(String(providerCallId))
    if (wait) { execution.toolWaiters.delete(String(providerCallId)); wait.resolve(response) }
    return { status: 'accepted' }
  }

  async cancelTurn({ turnId }) {
    const execution = this.active.get(turnId)
    if (!execution) return
    const result = resultResponse({ ok: false, error: { code: 'TURN_CANCELLED', message: 'Turn 已取消', retryable: false } })
    for (const [callId, wait] of execution.toolWaiters.entries()) { execution.toolResults.set(callId, result); wait.resolve(result) }
    execution.toolWaiters.clear()
    execution.events.push({ type: 'turn.cancelled', reason: 'cancelled' })
    execution.events.close()
    if (execution.threadId && execution.turnId) await this.bridge.request('turn/interrupt', { threadId: execution.threadId, turnId: execution.turnId }).catch(() => {})
  }

  async disposeTurn({ turnId }) { await this.cancelTurn({ turnId }).catch(() => {}) }

  async dispose() {
    this.unregisterToolRouter?.()
    for (const turnId of this.active.keys()) await this.cancelTurn({ turnId })
    this.active.clear()
    this.providerIndex.clear()
    await this.bridge.stop()
  }
}

export default CodexAppServerRuntime
