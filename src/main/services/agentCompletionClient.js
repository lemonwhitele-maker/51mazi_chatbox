import { agentReasoningCapabilities, agentReasoningParameters } from './agentReasoning.js'
import { resolveModelBudgets } from './agentBudgets.js'
import { validateCloudAiBaseUrl } from '../../shared/cloudAiProviders.js'

// Keep the application's requirement to execute tools separate from the wire
// parameter: DeepSeek rejects `required` while thinking is enabled.
export function resolveAgentToolChoice({ provider, effort, tools = [], toolChoice }) {
  if (!tools.length) return undefined
  const requested = toolChoice || 'auto'
  if (
    requested === 'required' &&
    agentReasoningCapabilities(provider).protocol === 'deepseek' &&
    agentReasoningParameters(provider, effort).thinking?.type === 'enabled'
  )
    return 'auto'
  return requested
}

function cleanBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
}

export function chatCompletionsEndpoint(provider = {}) {
  const baseUrl = cleanBaseUrl(provider.baseUrl)
  if (!baseUrl) throw new Error('Agent API Base URL 不能为空')
  validateCloudAiBaseUrl(provider.id, baseUrl)
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('Agent API Base URL 格式无效')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Agent API 仅支持 HTTP/HTTPS')
  if (/\/chat\/completions$/i.test(parsed.pathname)) return baseUrl
  return `${baseUrl}/chat/completions`
}

function errorMessage(status, payload, fallback) {
  const remote = payload?.error?.message || payload?.message || fallback
  if (status === 401) return 'Agent API Key 无效或已过期'
  if (status === 403) return 'Agent API Key 无权访问当前模型'
  if (status === 404) return 'Agent API 地址或模型不存在'
  if (status === 429) return 'Agent API 请求过于频繁，请稍后重试'
  if (status >= 500) return `Agent API 服务暂时不可用${remote ? `：${remote}` : ''}`
  return remote || `Agent API 请求失败（${status}）`
}

function requestHeaders(provider) {
  const headers = { 'Content-Type': 'application/json' }
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`
    if (provider.id === 'anthropic') {
      headers['x-api-key'] = provider.apiKey
      headers['anthropic-version'] = '2023-06-01'
    }
  }
  return headers
}

export async function requestAgentCompletion({
  provider,
  messages,
  tools = [],
  toolChoice,
  signal,
  fetchImpl = globalThis.fetch,
  maxTokens,
  temperature,
  effort
}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持 Agent API 网络请求')
  const outputTokens = resolveModelBudgets(provider, maxTokens).generationBudget.maxOutputTokens
  const body = {
    model: provider.model,
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: resolveAgentToolChoice({ provider, effort, tools, toolChoice }),
    max_tokens: outputTokens,
    temperature: Number.isFinite(temperature) ? temperature : undefined,
    stream: false
  }
  Object.assign(body, agentReasoningParameters(provider, effort))
  if (agentReasoningCapabilities(provider).protocol === 'openai') {
    body.max_completion_tokens = outputTokens
    delete body.max_tokens
    delete body.temperature
  }
  if (body.thinking?.type === 'enabled') delete body.temperature
  const response = await fetchImpl(chatCompletionsEndpoint(provider), {
    method: 'POST',
    headers: requestHeaders(provider),
    body: JSON.stringify(body),
    signal
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(errorMessage(response.status, payload, response.statusText))
  const message = payload?.choices?.[0]?.message
  if (!message) throw new Error('Agent API 未返回有效消息')
  return {
    message,
    usage: payload.usage || null,
    finishReason: payload?.choices?.[0]?.finish_reason || null
  }
}
