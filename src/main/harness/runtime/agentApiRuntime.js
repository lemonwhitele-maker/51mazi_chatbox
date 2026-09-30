import { createId } from '../ids.js'
import { DEFAULT_EXECUTION_BUDGET, resolveModelBudgets } from '../../services/agentBudgets.js'
import {
  chatCompletionsEndpoint,
  resolveAgentToolChoice,
  requestAgentCompletion
} from '../../services/agentCompletionClient.js'

export { chatCompletionsEndpoint, requestAgentCompletion }

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function toolArguments(value) {
  if (value && typeof value === 'object') return { arguments: value }
  const argumentsJson = String(value ?? '')
  try {
    return { arguments: JSON.parse(argumentsJson), argumentsJson }
  } catch (error) {
    return { argumentsJson, argumentsParseError: error.message }
  }
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || part?.content || ''))
    .join('')
}

function splitToolMarkup(value) {
  const text = String(value || '')
  const marker = text.search(/<[^>\r\n]*(?:DSML|tool_calls?|invoke)[^>\r\n]*>/i)
  return marker < 0
    ? { text, hasToolMarkup: false }
    : { text: text.slice(0, marker).trim(), hasToolMarkup: true }
}

function toolLimitFinalText(message) {
  const parsed = splitToolMarkup(messageText(message?.content))
  const attemptedToolCall =
    parsed.hasToolMarkup || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
  if (!attemptedToolCall) return parsed.text
  const notice = '本轮工具调用已达到上限，最后的工具请求未执行。请再次发送消息继续。'
  return parsed.text ? `${parsed.text}\n\n${notice}` : notice
}

function* responseUsage(response) {
  for (const usage of response.attemptUsages || []) {
    yield {
      type: 'usage',
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens
    }
  }
}

function* truncatedResponse(response) {
  const partial = splitToolMarkup(messageText(response.message?.content)).text.trim()
  if (partial) {
    const text = `【回答未完成：生成达到长度上限】\n${partial}`
    yield { type: 'message.delta', text }
    yield {
      type: 'message.completed',
      text,
      incomplete: true,
      providerItemId: createId('agent-partial')
    }
  }
  yield {
    type: 'turn.failed',
    code: 'MODEL_OUTPUT_TRUNCATED',
    retryable: false,
    message: `本次生成达到 ${response.outputLimit} tokens 上限，回答未完成；被截断响应中的工具请求均未执行。请核对模型输出能力与生成预算后重试。`,
    finishReason: response.finishReason,
    outputLimit: response.outputLimit
  }
}

export function shouldRequireToolUse(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (/(?:不要|不用|无需|别|禁止).{0,8}(?:调用|使用|执行|创建|提交|写入|修改|更新|读取)/.test(text))
    return false
  if (/(?:能不能|能否|可以吗|会不会).{0,12}(?:调用|使用|编辑)?工具/.test(text)) return false
  if (/(?:没法|不能).{0,12}(?:调用|使用|编辑)?工具/.test(text)) return true
  if (
    /^(?:是的|可以|好(?:的)?|对|继续)[\s，,。！!]*(?:请你?)?(?:再次|重新|继续)?(?:尝试|执行|提交|调用|创建|写入|更新|修改)/.test(
      text
    )
  )
    return true
  const hasToolSubject = /工具|提案|总纲|大纲|正文|人物|设定|速记|资料|章节|第.{0,6}章/.test(text)
  const hasToolAction = /调用|使用|创建|提交|写入|更新|修改|读取|编辑|应用/.test(text)
  if (hasToolSubject && hasToolAction) return true
  return /(?:再次|重新|继续).{0,6}(?:尝试|执行|提交|调用|创建|写入|更新|修改)/.test(text)
}

export class AgentApiRuntime {
  constructor({ configService, fetchImpl = globalThis.fetch } = {}) {
    this.id = 'agent-api'
    this.protocolVersion = 'agent-api-function-tools-v1'
    this.configService = configService
    this.fetchImpl = fetchImpl
    this.active = new Map()
  }

  async getCapabilities({ model } = {}) {
    const budgets = resolveModelBudgets(this.resolveProvider(model))
    return {
      streaming: true,
      nativeToolCalling: true,
      isolatedTurn: true,
      cancellableTurn: true,
      instructionChannels: true,
      dynamicTools: true,
      usageReporting: true,
      ...budgets,
      contextWindowTokens: budgets.modelLimits.contextWindowTokens,
      maxOutputTokens: budgets.generationBudget.maxOutputTokens,
      experimental: []
    }
  }

  async getBookSandboxAdmission() {
    return {
      admitted: true,
      contractVersion: 1,
      runtimeId: this.id,
      protocolVersion: this.protocolVersion,
      modelExecutableTools: 'registered-functions-only',
      nativeTools: 'not-present-in-model-protocol',
      localFilesystemAccess: 'none',
      runtimeWorkingDirectory: 'not-applicable',
      hostNetworkPurpose: 'configured-model-api-only',
      evidence: [
        'requestAgentCompletion constructs the request body from host-owned messages and registered function tools',
        'the remote model API has no local process, filesystem, MCP, browser, or shell execution channel'
      ]
    }
  }

  resolveProvider(model) {
    const explicit = String(model || '')
      .replace(/^agent::/, '')
      .trim()
    return this.configService.getProvider(explicit || undefined)
  }

  async *streamTurn(input) {
    const provider = this.resolveProvider(input.model)
    const budgets = resolveModelBudgets(provider)
    const execution = {
      controller: new AbortController(),
      waiters: new Map(),
      results: new Map(),
      cancelled: false,
      truncationRetried: false
    }
    this.active.set(input.turnId, execution)
    const abort = () => execution.controller.abort()
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) abort()
    const deadlineAt = input.deadlineAt ?? Date.now() + DEFAULT_EXECUTION_BUDGET.turnTimeoutMs
    const tools = (input.tools || []).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema || { type: 'object', properties: {} }
      }
    }))
    const messages = [
      {
        role: 'system',
        content: [input.instructions?.baseInstructions, input.instructions?.developerInstructions]
          .filter(Boolean)
          .join('\n\n')
      },
      ...(input.contextText ? [{ role: 'system', content: input.contextText }] : []),
      { role: 'user', content: input.userText || input.inputText || '' }
    ]
    const requireInitialToolUse =
      tools.length > 0 && shouldRequireToolUse(input.userText || input.inputText)
    const requestOnce = async ({ round, toolChoice, availableTools, maxTokens, attempt }) => {
      const request = {
        round,
        attempt,
        model: provider.model,
        effort: input.effort,
        generationBudget: { maxOutputTokens: maxTokens },
        messages: messages.map((message) =>
          Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'reasoning_content'))
        ),
        tools: availableTools,
        requestedToolChoice: toolChoice || (availableTools.length ? 'auto' : undefined),
        toolChoice: resolveAgentToolChoice({
          provider,
          effort: input.effort,
          tools: availableTools,
          toolChoice
        })
      }
      await input.trace?.('model.request', request)
      try {
        const response = await requestAgentCompletion({
          provider,
          effort: input.effort,
          messages,
          tools: availableTools,
          toolChoice,
          signal: execution.controller.signal,
          fetchImpl: this.fetchImpl,
          maxTokens
        })
        await input.trace?.('model.response', {
          round,
          attempt,
          outputLimit: maxTokens,
          message: {
            role: response.message?.role,
            content: response.message?.content,
            tool_calls: response.message?.tool_calls
          },
          usage: response.usage,
          finishReason: response.finishReason
        })
        return { ...response, outputLimit: maxTokens }
      } catch (error) {
        await input.trace?.('model.error', { round, message: error?.message || String(error) })
        throw error
      }
    }
    const complete = async (options) => {
      const startedAt = Date.now()
      let response = await requestOnce({
        ...options,
        maxTokens: budgets.generationBudget.maxOutputTokens,
        attempt: 1
      })
      const attemptUsages = response.usage ? [response.usage] : []
      if (response.finishReason === 'length') {
        const retryLimit = budgets.generationBudget.truncationRetryMaxOutputTokens
        const promptTokens =
          Number.isFinite(response.usage?.prompt_tokens) && response.usage.prompt_tokens > 0
            ? response.usage.prompt_tokens
            : new TextEncoder().encode(JSON.stringify({ messages, tools: options.availableTools }))
                .length
        const hasRoom = promptTokens + retryLimit + 2048 <= budgets.modelLimits.contextWindowTokens
        const hasTime = deadlineAt - Date.now() >= Math.max(30000, (Date.now() - startedAt) * 1.5)
        const canRetry =
          !execution.truncationRetried &&
          retryLimit > response.outputLimit &&
          hasRoom &&
          hasTime &&
          !execution.controller.signal.aborted
        await input.trace?.('model.truncated', {
          round: options.round,
          outputLimit: response.outputLimit,
          retryLimit,
          hasRoom,
          hasTime,
          willRetry: canRetry
        })
        if (canRetry) {
          execution.truncationRetried = true
          // Replay only this request. No partial assistant message or tool call is committed.
          try {
            const retried = await requestOnce({ ...options, maxTokens: retryLimit, attempt: 2 })
            if (retried.usage) attemptUsages.push(retried.usage)
            response = retried
          } catch (error) {
            if (error?.name === 'AbortError' || execution.controller.signal.aborted) throw error
            // Keep the original truncation and partial text if recovery itself fails.
            await input.trace?.('model.truncation_retry_failed', {
              round: options.round,
              message: error.message
            })
          }
        }
      }
      return { ...response, attemptUsages }
    }
    try {
      const maxToolRounds = Math.max(
        1,
        Number(input.runtimeBudget?.maxToolRounds) || DEFAULT_EXECUTION_BUDGET.maxToolRounds
      )
      for (let round = 0; round < maxToolRounds; round += 1) {
        if (execution.cancelled || execution.controller.signal.aborted) {
          yield { type: 'turn.cancelled', reason: 'cancelled' }
          return
        }
        let response
        try {
          response = await complete({
            round: round + 1,
            toolChoice: round === 0 && requireInitialToolUse ? 'required' : undefined,
            availableTools: tools
          })
        } catch (error) {
          if (error?.name === 'AbortError' || execution.cancelled) {
            yield { type: 'turn.cancelled', reason: 'cancelled' }
            return
          }
          yield {
            type: 'turn.failed',
            code: 'AGENT_API_REQUEST_FAILED',
            message: error?.message || 'Agent API 请求失败',
            retryable: true
          }
          return
        }
        yield* responseUsage(response)
        if (response.finishReason === 'length') {
          yield* truncatedResponse(response)
          return
        }
        const toolCalls = Array.isArray(response.message.tool_calls)
          ? response.message.tool_calls
          : []
        if (!toolCalls.length) {
          if (round === 0 && requireInitialToolUse) {
            yield {
              type: 'turn.failed',
              code: 'AGENT_TOOL_CALL_REQUIRED',
              message:
                '本轮请求要求使用工具，但模型未返回标准工具调用。请重试；系统不会把这次纯文本回复当作工具执行结果。',
              retryable: true
            }
            return
          }
          const parsed = splitToolMarkup(messageText(response.message.content))
          if (parsed.hasToolMarkup) {
            yield {
              type: 'turn.failed',
              code: 'AGENT_TOOL_PROTOCOL_INVALID',
              message: 'Agent API 返回了未采用标准 tool_calls 协议的工具请求，已阻止执行。',
              retryable: true
            }
            return
          }
          const text = parsed.text
          if (text) yield { type: 'message.delta', text }
          yield { type: 'message.completed', text, providerItemId: createId('agent-message') }
          yield { type: 'turn.completed', stopReason: response.finishReason || 'completed' }
          return
        }
        messages.push({
          role: 'assistant',
          content: response.message.content || null,
          ...(typeof response.message.reasoning_content === 'string'
            ? { reasoning_content: response.message.reasoning_content }
            : {}),
          tool_calls: toolCalls
        })
        const pending = toolCalls.map((call) => {
          const callId = String(call.id || createId('agent-call'))
          const wait = deferred()
          execution.waiters.set(callId, wait)
          return { call, callId, wait }
        })
        for (const { call, callId } of pending) {
          yield {
            type: 'tool.call',
            providerCallId: callId,
            roundId: round + 1,
            // UTF-8 bytes are a conservative token upper estimate; expansion is
            // optional. Divide room among calls so parallel reads cannot each use it.
            fullReadBudgetBytes: Math.max(
              0,
              Math.floor(
                (budgets.modelLimits.contextWindowTokens -
                  budgets.generationBudget.maxOutputTokens -
                  2048 -
                  new TextEncoder().encode(JSON.stringify({ messages, tools })).length) /
                  pending.length
              )
            ),
            name: String(call.function?.name || call.name || ''),
            ...toolArguments(call.function?.arguments ?? call.arguments)
          }
        }
        const results = await Promise.all(
          pending.map(async ({ callId, wait }) => {
            const existing = execution.results.get(callId)
            return { callId, result: existing || (await wait.promise) }
          })
        )
        for (const { callId, result } of results) {
          messages.push({
            role: 'tool',
            tool_call_id: callId,
            content: JSON.stringify(result || {})
          })
          execution.waiters.delete(callId)
        }
      }
      messages.push({
        role: 'system',
        content:
          '工具调用预算已经耗尽。不要再调用或输出任何工具、函数、XML、DSML 或 JSON 调用标签；只用纯文本说明尚未执行的工作。'
      })
      const finalResponse = await complete({ round: maxToolRounds + 1, availableTools: [] })
      yield* responseUsage(finalResponse)
      if (finalResponse.finishReason === 'length') {
        yield* truncatedResponse(finalResponse)
        return
      }
      const text = toolLimitFinalText(finalResponse.message)
      if (text) yield { type: 'message.delta', text }
      yield { type: 'message.completed', text, providerItemId: createId('agent-message-final') }
      yield { type: 'turn.completed', stopReason: 'tool_limit_finalization' }
    } catch (error) {
      if (error?.name === 'AbortError' || execution.controller.signal.aborted) {
        yield { type: 'turn.cancelled', reason: 'cancelled' }
      } else {
        yield {
          type: 'turn.failed',
          code: 'AGENT_API_REQUEST_FAILED',
          message: error?.message || 'Agent API 请求失败',
          retryable: true
        }
      }
    } finally {
      input.signal?.removeEventListener('abort', abort)
      this.active.delete(input.turnId)
    }
  }

  async submitToolResult({ turnId, providerCallId, result }) {
    const execution = this.active.get(turnId)
    if (!execution) return { status: 'turn_missing' }
    const id = String(providerCallId || '')
    if (!execution.waiters.has(id) && !execution.results.has(id)) return { status: 'call_missing' }
    execution.results.set(id, result)
    execution.waiters.get(id)?.resolve(result)
    return { status: 'accepted' }
  }

  async cancelTurn({ turnId }) {
    const execution = this.active.get(turnId)
    if (!execution) return
    execution.cancelled = true
    execution.controller.abort()
    for (const wait of execution.waiters.values()) wait.resolve({ ok: false, cancelled: true })
    execution.waiters.clear()
  }

  async disposeTurn({ turnId }) {
    await this.cancelTurn({ turnId })
  }

  async dispose() {
    for (const turnId of this.active.keys()) await this.cancelTurn({ turnId })
    this.active.clear()
  }
}

export default AgentApiRuntime
