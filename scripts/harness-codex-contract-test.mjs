import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Ajv from 'ajv'
import CodexAppServerBridge from '../src/main/services/codexAppServerBridge.js'
import CodexAppServerRuntime from '../src/main/harness/runtime/codexAppServerRuntime.js'

const testBookRoot = await fs.mkdtemp(join(tmpdir(), '51mazi-codex-contract-book-'))
function runtimeWorkspace(turnId) {
  return {
    bookRootRealPath: testBookRoot,
    runtimeDirectory: join(testBookRoot, '.51mazi', 'harness', 'runtime', turnId)
  }
}

const schemaDir = join(process.cwd(), 'src', 'main', 'harness', 'runtime', 'codex-schema')
const params = JSON.parse(await fs.readFile(join(schemaDir, 'DynamicToolCallParams.json'), 'utf8'))
const response = JSON.parse(await fs.readFile(join(schemaDir, 'DynamicToolCallResponse.json'), 'utf8'))
assert.deepEqual(params.required.sort(), ['arguments', 'callId', 'threadId', 'tool', 'turnId'].sort())
assert.deepEqual(response.required.sort(), ['contentItems', 'success'].sort())

const writes = []
const bridge = new CodexAppServerBridge()
bridge.process = { stdin: { writable: true, write: (line) => writes.push(JSON.parse(line)) } }
bridge.registerServerRequestHandler('item/tool/call', async (value) => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ ok: true, echo: value }) }] }))
bridge.handleLine(JSON.stringify({ id: 17, method: 'item/tool/call', params: { callId: 'c1', threadId: 't1', turnId: 'u1', tool: 'search_book_knowledge', arguments: {} } }))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(writes[0].id, 17)
assert.equal(writes[0].result.success, true)
assert.equal(writes[0].result.contentItems[0].type, 'inputText')

class RuntimeBridge extends EventEmitter {
  constructor() { super(); this.requests = []; this.handlers = new Map() }
  registerServerRequestHandler(method, handler) { this.handlers.set(method, handler); return () => this.handlers.delete(method) }
  async start() { return { phase: 'ready', account: { signedIn: true } } }
  async stop() {}
  async request(method, params) {
    this.requests.push({ method, params })
    if (method === 'thread/start') return { thread: { id: 'provider-thread-test' } }
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit('notification', { method: 'item/completed', params: { threadId: 'provider-thread-test', turnId: 'provider-turn-test', item: { type: 'agentMessage', id: 'item-1', text: '已回答' } } })
        this.emit('notification', { method: 'turn/completed', params: { threadId: 'provider-thread-test', turnId: 'provider-turn-test', turn: { status: 'completed' } } })
      })
      return { turn: { id: 'provider-turn-test' } }
    }
    if (method === 'turn/interrupt') return {}
    return {}
  }
}

const runtimeBridge = new RuntimeBridge()
const runtime = new CodexAppServerRuntime({ bridge: runtimeBridge })
const events = []
for await (const event of runtime.streamTurn({
  turnId: 'local-turn-test',
  ...runtimeWorkspace('local-turn-test'),
  model: null,
  effort: null,
  instructions: { baseInstructions: 'base-v1', developerInstructions: 'developer-v1' },
  contextText: '<trusted-context>no</trusted-context>',
  userText: '当前请求',
  tools: [{ name: 'search_book_knowledge', description: 'search', inputSchema: { type: 'object' } }],
  signal: new AbortController().signal
})) events.push(event)
const threadStart = runtimeBridge.requests.find((request) => request.method === 'thread/start')
const turnStart = runtimeBridge.requests.find((request) => request.method === 'turn/start')
assert.equal(threadStart.params.baseInstructions, 'base-v1')
assert.equal(threadStart.params.developerInstructions, 'developer-v1')
assert.equal(threadStart.params.ephemeral, true)
assert.equal(threadStart.params.dynamicTools[0].name, 'search_book_knowledge')
assert.deepEqual(turnStart.params.input.map((item) => item.text), ['<trusted-context>no</trusted-context>', '当前请求'])
assert.equal('dynamicTools' in turnStart.params, false)
assert.equal(events.at(-1).type, 'turn.completed')

class NotificationBridge extends EventEmitter {
  constructor(notifications) { super(); this.notifications = notifications; this.handlers = new Map() }
  registerServerRequestHandler(method, handler) { this.handlers.set(method, handler); return () => this.handlers.delete(method) }
  async start() {}
  async stop() {}
  async request(method) {
    if (method === 'thread/start') return { thread: { id: 'provider-thread-notifications' } }
    if (method === 'turn/start') {
      queueMicrotask(() => {
        for (const notification of this.notifications) this.emit('notification', notification)
      })
      return { turn: { id: 'provider-turn-notifications' } }
    }
    return {}
  }
}

async function collectEvents(bridge, turnId) {
  const subject = new CodexAppServerRuntime({ bridge })
  const collected = []
  for await (const event of subject.streamTurn({
    turnId,
    ...runtimeWorkspace(turnId),
    instructions: {},
    contextText: '',
    userText: 'test',
    tools: [],
    signal: new AbortController().signal
  })) collected.push(event)
  return collected
}

const failedNotifications = [
  {
    method: 'item/completed',
    params: {
      threadId: 'provider-thread-notifications',
      turnId: 'provider-turn-notifications',
      item: { type: 'agentMessage', id: 'commentary-1', phase: 'commentary', text: '过程说明' }
    }
  },
  {
    method: 'error',
    params: {
      threadId: 'provider-thread-notifications',
      turnId: 'provider-turn-notifications',
      error: { message: '上游明确失败', codexErrorInfo: 'serverOverloaded' },
      willRetry: false
    }
  },
  {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'provider-thread-notifications',
      turnId: 'provider-turn-notifications',
      tokenUsage: {
        last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 },
        total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 },
        modelContextWindow: 32768
      }
    }
  },
  {
    method: 'turn/completed',
    params: {
      threadId: 'provider-thread-notifications',
      turn: { id: 'provider-turn-notifications', status: 'failed', items: [], error: null }
    }
  }
]
const notificationSchemas = new Map([
  ['error', 'ErrorNotification.json'],
  ['thread/tokenUsage/updated', 'ThreadTokenUsageUpdatedNotification.json'],
  ['turn/completed', 'TurnCompletedNotification.json']
])
const ajv = new Ajv({ strict: false, validateFormats: false })
for (const notification of failedNotifications) {
  const schemaFile = notificationSchemas.get(notification.method)
  if (!schemaFile) continue
  const schema = JSON.parse(await fs.readFile(join(schemaDir, 'v2', schemaFile), 'utf8'))
  assert.equal(
    ajv.validate(schema, notification.params),
    true,
    `${notification.method} fixture 必须符合仓库随版本保存的协议 schema：${ajv.errorsText()}`
  )
}
const failedEvents = await collectEvents(
  new NotificationBridge(failedNotifications),
  'local-turn-failed'
)
assert.equal(failedEvents.some((event) => event.type === 'message.completed'), false)
assert.deepEqual(
  failedEvents.find((event) => event.type === 'usage'),
  {
    type: 'usage', inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: undefined,
    outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13,
    modelContextWindow: 32768,
    totalUsage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 }
  }
)
assert.deepEqual(failedEvents.at(-1), {
  type: 'turn.failed',
  code: 'CODEX_SERVER_OVERLOADED',
  message: '上游明确失败',
  retryable: false
})

const interruptedEvents = await collectEvents(new NotificationBridge([
  {
    method: 'turn/completed',
    params: {
      threadId: 'provider-thread-notifications',
      turn: { id: 'provider-turn-notifications', status: 'interrupted', items: [], error: null }
    }
  }
]), 'local-turn-interrupted')
assert.deepEqual(interruptedEvents.at(-1), { type: 'turn.interrupted', reason: 'runtime-interrupted' })

class CausalBridge extends EventEmitter {
  constructor() { super(); this.handlers = new Map() }
  registerServerRequestHandler(method, handler) { this.handlers.set(method, handler); return () => this.handlers.delete(method) }
  async start() {}
  async stop() {}
  async request(method) {
    if (method === 'thread/start') return { thread: { id: 'provider-thread-causal' } }
    if (method === 'turn/start') {
      queueMicrotask(() => void this.run())
      return { turn: { id: 'provider-turn-causal' } }
    }
    return {}
  }
  async run() {
    const handler = this.handlers.get('item/tool/call')
    await handler({ threadId: 'provider-thread-causal', turnId: 'provider-turn-causal', callId: 'read-1', tool: 'read_book_source', arguments: {} })
    await handler({ threadId: 'provider-thread-causal', turnId: 'provider-turn-causal', callId: 'proposal-1', tool: 'proposal_probe', arguments: {} })
    this.emit('notification', { method: 'item/completed', params: { threadId: 'provider-thread-causal', turnId: 'provider-turn-causal', item: { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: '完成' } } })
    this.emit('notification', { method: 'turn/completed', params: { threadId: 'provider-thread-causal', turn: { id: 'provider-turn-causal', status: 'completed', items: [] } } })
  }
}

const causalBridge = new CausalBridge()
const causalRuntime = new CodexAppServerRuntime({ bridge: causalBridge })
const causalEvents = []
for await (const event of causalRuntime.streamTurn({
  turnId: 'local-turn-causal',
  ...runtimeWorkspace('local-turn-causal'),
  instructions: {},
  contextText: '',
  userText: 'test',
  tools: [
    { name: 'read_book_source', description: 'read', inputSchema: { type: 'object' } },
    { name: 'proposal_probe', description: 'write', inputSchema: { type: 'object' } }
  ],
  signal: new AbortController().signal
})) {
  causalEvents.push(event)
  if (event.type === 'tool.call') {
    await causalRuntime.submitToolResult({
      turnId: 'local-turn-causal',
      providerCallId: event.providerCallId,
      result: { data: { accepted: true } }
    })
  }
}
const causalCalls = causalEvents.filter((event) => event.type === 'tool.call')
assert.equal(causalCalls[0].causalMarker, 0)
assert.equal(causalCalls[0].batchId, 'causal:0')
assert.equal(causalCalls[1].causalMarker, 1)
assert.equal(causalCalls[1].batchId, 'causal:1')
await fs.rm(testBookRoot, { recursive: true, force: true })
console.log('Harness Codex protocol contract test passed')
