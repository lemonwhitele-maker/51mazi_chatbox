import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveModelBudgets,
  resolveToolReadBudget,
  resolveExecutionBudget
} from '../src/main/services/agentBudgets.js'
import AgentModelConfigService from '../src/main/services/agentModelConfigService.js'
import { requestAgentCompletion } from '../src/main/services/agentCompletionClient.js'
import AgentApiRuntime from '../src/main/harness/runtime/agentApiRuntime.js'
import AgentRouterRuntime from '../src/main/harness/runtime/agentRouterRuntime.js'
import ContextAssembler from '../src/main/harness/context/contextAssembler.js'
import { assertRuntimeCapabilities } from '../src/main/harness/runtime/modelRuntime.js'
import BookSandboxService from '../src/main/harness/sandbox/bookSandboxService.js'
import BookDocumentService from '../src/main/harness/documents/bookDocumentService.js'
import { createDocumentTools } from '../src/main/harness/tools/documentTools.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'

const values = new Map()
const config = new AgentModelConfigService({
  store: {
    get: (key, fallback) => values.get(key) ?? fallback,
    set: (key, value) => values.set(key, structuredClone(value))
  }
})
config.saveProvider('local_openai', {
  defaultRuntime: 'agent-api',
  model: 'test-large',
  baseUrl: 'http://localhost:1234/v1',
  modelLimits: { contextWindowTokens: 131072, maxOutputTokens: 16384 },
  generationBudget: { maxOutputTokens: 1024 }
})
config.saveProvider('deepseek', { model: 'deepseek-v4-flash', apiKey: 'test' })
const requests = []
const runtime = new AgentApiRuntime({
  configService: config,
  fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({ choices: [{ message: { content: '回答' } }] }) }
  }
})
const router = new AgentRouterRuntime({ configService: config, agentRuntime: runtime })
const capabilities = await assertRuntimeCapabilities(router, { model: 'agent::local_openai' })
assert.equal(
  capabilities.modelLimits.contextWindowTokens,
  131072,
  'Use selected model, not default provider'
)
assert.equal(capabilities.modelLimits.maxOutputTokens, 16384)
assert.equal(capabilities.generationBudget.maxOutputTokens, 1024)
const policy = new ContextAssembler().getPolicy(capabilities)
assert.equal(policy.maxOutputTokens, 1024, 'Reserve actual request output, not model maximum')
const events = []
for await (const event of router.streamTurn({
  turnId: 'budget-turn',
  model: 'agent::local_openai',
  userText: '你好',
  tools: []
})) {
  events.push(event)
}
assert.equal(events.at(-1).type, 'turn.completed')
assert.equal(requests[0].max_tokens, 1024)
assert.equal(requests[0].modelLimits, undefined, 'Host budgets are not API parameters')
assert.equal(requests[0].generationBudget, undefined)
assert.equal(
  requests[0].messages.some((item) => item.content.includes('131072')),
  false
)
await requestAgentCompletion({
  provider: { ...config.getProvider('local_openai'), id: 'gpt', model: 'gpt-5.2' },
  messages: [],
  maxTokens: 99999,
  fetchImpl: runtime.fetchImpl
})
assert.equal(requests.at(-1).max_completion_tokens, 16384, 'Output is bounded by model capacity')
assert.equal(requests.at(-1).max_tokens, undefined)

config.saveProvider('local_openai', { proxyPort: '1234' })
assert.equal(config.getProvider('local_openai').generationBudget.maxOutputTokens, 1024)
config.saveProvider('local_openai', { generationBudget: { truncationRetryMaxOutputTokens: 8192 } })
config.saveProvider('local_openai', { proxyPort: '1235' })
assert.equal(config.getProvider('local_openai').generationBudget.truncationRetryMaxOutputTokens, 8192)
config.saveProvider('local_openai', { model: 'test-small' })
assert.equal(config.getProvider('local_openai').generationBudget.truncationRetryMaxOutputTokens, 8192)
assert.equal(
  config.getProvider('local_openai').modelLimits.contextWindowTokens,
  32768,
  'Do not inherit old model capacity on model change'
)
assert.throws(() =>
  resolveModelBudgets({ modelLimits: { contextWindowTokens: 4096, maxOutputTokens: 8192 } })
)
assert.throws(() => resolveModelBudgets({ generationBudget: { maxOutputTokens: -1 } }))
assert.throws(() => resolveModelBudgets({ generationBudget: { truncationRetryMaxOutputTokens: 0 } }))
assert.throws(() => resolveToolReadBudget({ defaultPageChars: 20000 }))
assert.throws(() => resolveExecutionBudget({ maxToolRounds: 0 }))
assert.equal(resolveExecutionBudget().maxToolRounds, 24)
assert.equal(resolveToolReadBudget().defaultPageChars, 8000)

const root = fs.mkdtempSync(path.join(os.tmpdir(), '51mazi-budget-test-'))
try {
  const file = path.join(root, 'Book/.51mazi/notes/quick-notes.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '甲'.repeat(20000))
  const sandbox = new BookSandboxService({ booksDirProvider: root })
  const documents = new BookDocumentService({
    sandboxService: sandbox,
    readBudget: { defaultPageChars: 10000, maxPageChars: 16000, maxResultChars: 22000 },
    retrievalService: {
      listBookStructure: () => ({}),
      searchBookKnowledge: () => ({ results: [] })
    }
  })
  const registry = new DomainToolRegistry()
  createDocumentTools({ documentService: documents }).forEach((tool) => registry.register(tool))
  assert.equal(registry.get('read').inputSchema.properties.maxChars.maximum, 16000)
  assert.equal(registry.get('read').resultBudget.maxChars, 22000)
  const context = {
    bookScope: sandbox.bindBook('Book'),
    generationBudget: { maxOutputTokens: 128 }
  }
  const args = { path: 'book/notes/quick-notes.md' }
  const page = await registry.execute('read', context, args)
  assert.equal(page.ok, true, JSON.stringify(page))
  assert.equal(page.data.text.length, 10000, 'Tool read size is independent of model output')
  assert.equal(
    (await registry.execute('read', context, { ...args, maxChars: 16000 })).data.text.length,
    16000
  )
  assert.equal(
    (await registry.execute('read', context, { ...args, maxChars: 16001 })).error.code,
    'TOOL_ARGUMENT_INVALID'
  )
  assert.equal(resolveModelBudgets().generationBudget.maxOutputTokens, 8192)
  assert.equal(resolveExecutionBudget().maxToolCalls, 24)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
console.log('Model, generation, tool-result and execution budget separation passed.')
