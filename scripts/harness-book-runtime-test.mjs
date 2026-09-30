import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import AgentApiRuntime from '../src/main/harness/runtime/agentApiRuntime.js'
import AgentRouterRuntime from '../src/main/harness/runtime/agentRouterRuntime.js'
import CodexAppServerRuntime from '../src/main/harness/runtime/codexAppServerRuntime.js'
import { CODEX_RUNTIME_VERSION } from '../src/main/services/codexAppServerBridge.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import {
  assertBookSandboxRuntime,
  BOOK_SANDBOX_RUNTIME_CONTRACT_VERSION,
  BOOK_SANDBOX_TOOL_NAMES
} from '../src/main/harness/runtime/modelRuntime.js'

const tools = BOOK_SANDBOX_TOOL_NAMES.map((name) => ({
  name,
  description: `${name} contract`,
  inputSchema: { type: 'object', additionalProperties: false, properties: {} }
}))

let requestBody = null
const agentRuntime = new AgentApiRuntime({
  configService: {
    getProvider: () => ({
      id: 'openai-compatible',
      baseUrl: 'https://model.invalid/v1',
      model: 'p0-test-model',
      apiKey: 'host-only-secret'
    })
  },
  fetchImpl: async (_url, init) => {
    requestBody = JSON.parse(init.body)
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }
      }
    }
  }
})

const agentAdmission = await assertBookSandboxRuntime(agentRuntime, { tools })
assert.equal(agentAdmission.admitted, true)
assert.equal(agentAdmission.contractVersion, BOOK_SANDBOX_RUNTIME_CONTRACT_VERSION)
assert.equal(agentAdmission.modelExecutableTools, 'registered-functions-only')
assert.equal(agentAdmission.localFilesystemAccess, 'none')

const agentEvents = []
for await (const event of agentRuntime.streamTurn({
  turnId: 'p0-agent-turn',
  instructions: { baseInstructions: 'base', developerInstructions: 'developer' },
  contextText: '<trusted-context>book only</trusted-context>',
  userText: 'answer using registered tools only',
  tools,
  signal: new AbortController().signal
})) agentEvents.push(event)
assert.deepEqual(requestBody.tools.map((tool) => tool.function.name).sort(), [...BOOK_SANDBOX_TOOL_NAMES].sort())
assert.equal(JSON.stringify(requestBody).includes('host-only-secret'), false)
assert.equal('mcp_servers' in requestBody, false)
assert.equal('web_search' in requestBody, false)
assert.equal('shell' in requestBody, false)
assert.equal(agentEvents.at(-1).type, 'turn.completed')

const unknownToolResult = await new DomainToolRegistry().execute('shell', {}, {}, null)
assert.equal(unknownToolResult.ok, false)
assert.equal(unknownToolResult.error.code, 'TOOL_NOT_ALLOWED')

await assert.rejects(
  () => assertBookSandboxRuntime(agentRuntime, { tools: [...tools, { name: 'shell' }] }),
  (error) => error?.code === 'RUNTIME_BOOK_SANDBOX_UNSUPPORTED' && error?.retryable === false
)

class RuntimeBridge extends EventEmitter {
  constructor() { super(); this.handlers = new Map(); this.requests = [] }
  registerServerRequestHandler(method, handler) { this.handlers.set(method, handler); return () => this.handlers.delete(method) }
  async start() { return { phase: 'ready' } }
  async stop() {}
  async request(method, params) {
    this.requests.push({ method, params })
    if (method === 'thread/start') return { thread: { id: 'p0-thread' } }
    if (method === 'turn/start') {
      queueMicrotask(() => this.emit('notification', {
        method: 'turn/completed',
        params: { threadId: 'p0-thread', turnId: 'p0-provider-turn', turn: { status: 'completed' } }
      }))
      return { turn: { id: 'p0-provider-turn' } }
    }
    return {}
  }
}

const bridge = new RuntimeBridge()
const codexRuntime = new CodexAppServerRuntime({ bridge })
const codexAdmission = await codexRuntime.getBookSandboxAdmission()
assert.equal(codexAdmission.admitted, true)
assert.equal(codexAdmission.mode, 'codex-readonly-compatibility')
assert.equal(codexAdmission.protocolVersion, CODEX_RUNTIME_VERSION)
await assertBookSandboxRuntime(codexRuntime, { tools })
assert.equal(bridge.requests.length, 0, '准入检查本身不应启动模型请求')
for (const override of [{ sandbox: 'danger-full-access' }, { networkAccess: true }, { runtimeId: 'unknown' }, { admitted: false }]) {
  await assert.rejects(() => assertBookSandboxRuntime({
    getCapabilities: () => codexRuntime.getCapabilities(),
    getBookSandboxAdmission: async () => ({ ...codexAdmission, ...override })
  }, { tools }), (error) => error?.code === 'RUNTIME_BOOK_SANDBOX_UNSUPPORTED')
}

const router = new AgentRouterRuntime({
  codexRuntime,
  agentRuntime,
  configService: {
    getStoredConfig: () => ({ defaultRuntime: 'codex-app-server', selectedProvider: 'openai-compatible' }),
    listConfiguredProviders: () => []
  }
})
const routedAgent = await assertBookSandboxRuntime(router, { model: 'agent::openai-compatible', tools })
assert.equal(routedAgent.runtimeId, 'agent-api')
assert.equal((await assertBookSandboxRuntime(router, { model: 'codex::default', tools })).mode, 'codex-readonly-compatibility')
const available = await router.listBookSandboxRuntimes()
assert.deepEqual(
  available.map((item) => [item.runtimeId, item.admitted]),
  [['agent-api', true], ['codex-app-server', true]]
)

const bookRoot = await fs.mkdtemp(join(tmpdir(), '51mazi-p0-book-'))
const turnId = 'p0-codex-workspace'
const runtimeDirectory = join(bookRoot, '.51mazi', 'harness', 'runtime', turnId)
const codexEvents = []
for await (const event of codexRuntime.streamTurn({
  turnId,
  bookRootRealPath: bookRoot,
  runtimeDirectory,
  instructions: {},
  contextText: '',
  userText: 'normal-mode contract test',
  tools: [],
  signal: new AbortController().signal
})) codexEvents.push(event)
assert.equal(codexEvents.at(-1).type, 'turn.completed')
const threadStart = bridge.requests.find((request) => request.method === 'thread/start')
assert.equal(threadStart.params.cwd, runtimeDirectory)
assert.equal(threadStart.params.ephemeral, true)
assert.equal(threadStart.params.approvalPolicy, 'never')
assert.equal(threadStart.params.sandbox, 'read-only')
assert.deepEqual(bridge.requests.find((request) => request.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly', networkAccess: false })
assert.equal(await fs.stat(join(bookRoot, '.51mazi', 'harness', 'runtime')).then((stat) => stat.isDirectory()), true)
await assert.rejects(() => fs.stat(runtimeDirectory), { code: 'ENOENT' })

const schema = JSON.parse(await fs.readFile(
  join(process.cwd(), 'src', 'main', 'harness', 'runtime', 'codex-schema', 'v2', 'TurnStartParams.json'),
  'utf8'
))
const readOnly = schema.definitions.SandboxPolicy.oneOf.find((item) =>
  item?.properties?.type?.enum?.includes('readOnly')
)
assert.ok(readOnly)
assert.equal('readableRoots' in readOnly.properties, false)

const packageJson = JSON.parse(await fs.readFile(join(process.cwd(), 'package.json'), 'utf8'))
const packageLock = JSON.parse(await fs.readFile(join(process.cwd(), 'package-lock.json'), 'utf8'))
const installedCodex = JSON.parse(await fs.readFile(
  join(process.cwd(), 'node_modules', '@openai', 'codex', 'package.json'),
  'utf8'
))
assert.equal(packageJson.dependencies['@openai/codex'], CODEX_RUNTIME_VERSION)
assert.equal(packageLock.packages[''].dependencies['@openai/codex'], CODEX_RUNTIME_VERSION)
assert.equal(packageLock.packages['node_modules/@openai/codex'].version, CODEX_RUNTIME_VERSION)
assert.equal(installedCodex.version, CODEX_RUNTIME_VERSION)

await fs.rm(bookRoot, { recursive: true, force: true })
console.log('Harness single-book Runtime admission test passed')
