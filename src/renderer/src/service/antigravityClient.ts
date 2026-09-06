export type AgentTransport = 'auto' | 'http' | 'websocket'

export interface AgentClientConfig {
  endpoint: string
  transport: AgentTransport
  apiKey: string
  customHeaders: string
}

export interface AgentRequestPayload {
  prompt: string
  selection: string
  full_text: string
  cursor_position: number
  metadata: Record<string, unknown>
}

export interface AgentDiffPayload {
  type: 'diff'
  originalText: string
  replacementText: string
  raw?: unknown
}

export interface AgentResponse {
  text: string
  diff: AgentDiffPayload | null
  raw?: unknown
}

export interface AgentStreamCallbacks {
  onText?: (delta: string, accumulated: string) => void
  onDiff?: (diff: AgentDiffPayload) => void
  onEvent?: (event: unknown) => void
}

const CONFIG_STORE_KEY = 'antigravity.agent.config'

export const DEFAULT_AGENT_CONFIG: AgentClientConfig = {
  endpoint: 'http://127.0.0.1:8000/v1/chat/agent',
  transport: 'auto',
  apiKey: '',
  customHeaders: ''
}

function normalizeConfig(value: Partial<AgentClientConfig> | null | undefined): AgentClientConfig {
  const transport = ['auto', 'http', 'websocket'].includes(String(value?.transport))
    ? (value?.transport as AgentTransport)
    : DEFAULT_AGENT_CONFIG.transport

  return {
    endpoint: String(value?.endpoint || DEFAULT_AGENT_CONFIG.endpoint).trim(),
    transport,
    apiKey: String(value?.apiKey || ''),
    customHeaders: String(value?.customHeaders || '')
  }
}

export async function loadAgentConfig(): Promise<AgentClientConfig> {
  if (!window.electronStore?.get) return { ...DEFAULT_AGENT_CONFIG }
  const stored = await window.electronStore.get(CONFIG_STORE_KEY)
  return normalizeConfig(stored)
}

export async function saveAgentConfig(config: AgentClientConfig): Promise<AgentClientConfig> {
  const normalized = normalizeConfig(config)
  if (window.electronStore?.set) {
    await window.electronStore.set(CONFIG_STORE_KEY, normalized)
  }
  return normalized
}

export function parseCustomHeaders(value: string): Record<string, string> {
  if (!value.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Custom Headers 必须是有效的 JSON 对象')
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Custom Headers 必须是 JSON 对象')
  }

  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, headerValue]) => [
      key,
      String(headerValue)
    ])
  )
}

function buildHeaders(config: AgentClientConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    ...parseCustomHeaders(config.customHeaders)
  }
  const hasAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
  if (config.apiKey && !hasAuthorization) {
    headers.Authorization = `Bearer ${config.apiKey}`
  }
  return headers
}

function extractText(event: any): string {
  if (typeof event === 'string') return event
  if (!event || typeof event !== 'object') return ''
  if (typeof event.delta === 'string') return event.delta
  if (typeof event.content === 'string') return event.content
  if (typeof event.text === 'string') return event.text
  if (typeof event.response === 'string') return event.response
  if (typeof event.answer === 'string') return event.answer
  if (typeof event.output === 'string') return event.output
  if (typeof event.data?.content === 'string') return event.data.content
  if (typeof event.data?.text === 'string') return event.data.text
  if (typeof event.message?.content === 'string') return event.message.content
  if (typeof event.choices?.[0]?.delta?.content === 'string') {
    return event.choices[0].delta.content
  }
  if (typeof event.choices?.[0]?.message?.content === 'string') {
    return event.choices[0].message.content
  }
  return ''
}

function extractDiff(event: any): AgentDiffPayload | null {
  if (!event || typeof event !== 'object') return null
  const candidate =
    event.type === 'diff'
      ? event
      : event.diff || (event.data?.type === 'diff' ? event.data : event.data?.diff)
  if (!candidate || typeof candidate !== 'object') return null

  const replacementText = String(
    candidate.replacement_text ??
      candidate.replacementText ??
      candidate.rewritten_text ??
      candidate.rewrittenText ??
      candidate.new_text ??
      candidate.newText ??
      ''
  )
  if (!replacementText) return null

  return {
    type: 'diff',
    originalText: String(
      candidate.original_text ??
        candidate.originalText ??
        candidate.old_text ??
        candidate.oldText ??
        ''
    ),
    replacementText,
    raw: event
  }
}

function normalizeEvent(event: unknown): AgentResponse {
  return {
    text: extractText(event),
    diff: extractDiff(event),
    raw: event
  }
}

function parseEventData(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '[DONE]') return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

function dispatchEvent(
  event: unknown,
  callbacks: AgentStreamCallbacks,
  state: { text: string; diff: AgentDiffPayload | null; raw: unknown }
) {
  if (event == null) return
  callbacks.onEvent?.(event)
  const normalized = normalizeEvent(event)
  if (normalized.text) {
    state.text += normalized.text
    callbacks.onText?.(normalized.text, state.text)
  }
  if (normalized.diff) {
    state.diff = normalized.diff
    callbacks.onDiff?.(normalized.diff)
  }
  state.raw = event
}

async function requestViaHttp(
  payload: AgentRequestPayload,
  config: AgentClientConfig,
  callbacks: AgentStreamCallbacks,
  signal?: AbortSignal
): Promise<AgentResponse> {
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(payload),
    signal
  })

  if (!response.ok) {
    const detail = (await response.text()).trim()
    throw new Error(`Agent 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`)
  }

  const state = { text: '', diff: null as AgentDiffPayload | null, raw: null as unknown }
  const contentType = response.headers.get('content-type') || ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    const rawText = await response.text()
    const event = parseEventData(rawText)
    dispatchEvent(event, callbacks, state)
    return state
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() || ''

    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      dispatchEvent(parseEventData(data), callbacks, state)
    }
    if (done) break
  }

  if (buffer.trim()) {
    const data = buffer
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    dispatchEvent(parseEventData(data || buffer), callbacks, state)
  }

  return state
}

function requestViaWebSocket(
  payload: AgentRequestPayload,
  config: AgentClientConfig,
  callbacks: AgentStreamCallbacks,
  signal?: AbortSignal
): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const state = { text: '', diff: null as AgentDiffPayload | null, raw: null as unknown }
    const socket = new WebSocket(config.endpoint)
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      resolve(state)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const abort = () => {
      socket.close(1000, 'aborted')
      fail(new DOMException('Agent 请求已取消', 'AbortError'))
    }

    signal?.addEventListener('abort', abort, { once: true })
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          ...payload,
          headers: buildHeaders(config)
        })
      )
    })
    socket.addEventListener('message', (message) => {
      const event = parseEventData(String(message.data || ''))
      if (event == null) {
        socket.close(1000, 'done')
        return
      }
      dispatchEvent(event, callbacks, state)
      if ((event as any)?.done === true || (event as any)?.type === 'done') {
        socket.close(1000, 'done')
      }
    })
    socket.addEventListener('error', () => fail(new Error('Agent WebSocket 连接失败')))
    socket.addEventListener('close', (event) => {
      signal?.removeEventListener('abort', abort)
      if (event.code === 1000 || state.text || state.diff) finish()
      else fail(new Error(`Agent WebSocket 已断开（${event.code}）`))
    })
  })
}

export async function requestAgent(
  payload: AgentRequestPayload,
  rawConfig: AgentClientConfig,
  callbacks: AgentStreamCallbacks = {},
  signal?: AbortSignal
): Promise<AgentResponse> {
  const config = normalizeConfig(rawConfig)
  if (!config.endpoint) throw new Error('请先配置 Agent 接口地址')

  const useWebSocket =
    config.transport === 'websocket' ||
    (config.transport === 'auto' && /^wss?:\/\//i.test(config.endpoint))

  return useWebSocket
    ? requestViaWebSocket(payload, config, callbacks, signal)
    : requestViaHttp(payload, config, callbacks, signal)
}
