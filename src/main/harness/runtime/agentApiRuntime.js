import { createId } from '../ids.js'
import {
  chatCompletionsEndpoint,
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
    this.configService = configService
    this.fetchImpl = fetchImpl
    this.active = new Map()
  }

  async getCapabilities() {
    return {
      streaming: true,
      nativeToolCalling: true,
      isolatedTurn: true,
      cancellableTurn: true,
      instructionChannels: true,
      dynamicTools: true,
      usageReporting: true,
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      experimental: []
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
    const execution = {
      controller: new AbortController(),
      waiters: new Map(),
      results: new Map(),
      cancelled: false
    }
    this.active.set(input.turnId, execution)
    const abort = () => execution.controller.abort()
    input.signal?.addEventListener('abort', abort, { once: true })
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
    try {
      const maxToolRounds = Math.max(1, Number(input.runtimeBudget?.maxToolRounds) || 6)
      for (let round = 0; round < maxToolRounds; round += 1) {
        if (execution.cancelled || execution.controller.signal.aborted) {
          yield { type: 'turn.cancelled', reason: 'cancelled' }
          return
        }
        let response
        try {
          response = await requestAgentCompletion({
            provider,
            messages,
            tools,
            toolChoice: round === 0 && requireInitialToolUse ? 'required' : undefined,
            signal: execution.controller.signal,
            fetchImpl: this.fetchImpl
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
        if (response.usage) {
          yield {
            type: 'usage',
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens
          }
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
      const finalResponse = await requestAgentCompletion({
        provider,
        messages: [
          ...messages,
          {
            role: 'system',
            content:
              '工具调用预算已经耗尽。不要再调用或输出任何工具、函数、XML、DSML 或 JSON 调用标签；只用纯文本说明尚未执行的工作。'
          }
        ],
        tools: [],
        signal: execution.controller.signal,
        fetchImpl: this.fetchImpl
      })
      const text = toolLimitFinalText(finalResponse.message)
      if (text) yield { type: 'message.delta', text }
      yield { type: 'message.completed', text, providerItemId: createId('agent-message-final') }
      yield { type: 'turn.completed', stopReason: 'tool_limit_finalization' }
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
