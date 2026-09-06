import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import CodexAppServerBridge from '../src/main/services/codexAppServerBridge.js'
import CodexAppServerRuntime from '../src/main/harness/runtime/codexAppServerRuntime.js'

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
console.log('Harness Codex protocol contract test passed')
