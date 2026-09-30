import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AgentApiRuntime from '../src/main/harness/runtime/agentApiRuntime.js'
import FakeRuntime from '../src/main/harness/runtime/fakeRuntime.js'
import TurnCoordinator from '../src/main/harness/turn/turnCoordinator.js'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import ContextAssembler from '../src/main/harness/context/contextAssembler.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import { resolveExecutionBudget } from '../src/main/services/agentBudgets.js'

const reply = (content, finishReason = 'stop', toolCalls, promptTokens = 100) => ({
  choices: [
    { message: { role: 'assistant', content, tool_calls: toolCalls }, finish_reason: finishReason }
  ],
  usage: { prompt_tokens: promptTokens, completion_tokens: finishReason === 'length' ? 8192 : 12 }
})
const call = (id, name = 'write', args = '{}') => ({
  id,
  type: 'function',
  function: { name, arguments: args }
})
function api(responses, generationBudget = {}, modelLimits = {}) {
  const requests = []
  const trace = []
  const runtime = new AgentApiRuntime({
    configService: {
      getProvider: () => ({
        id: 'local_openai',
        model: 'test',
        baseUrl: 'http://localhost/v1',
        modelLimits: { contextWindowTokens: 65536, maxOutputTokens: 16384, ...modelLimits },
        generationBudget: { maxOutputTokens: 8192, ...generationBudget }
      })
    },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body))
      const response = responses.shift()
      assert(response, 'Unexpected additional model request')
      if (response instanceof Error) throw response
      return { ok: true, json: async () => response }
    }
  })
  return { runtime, requests, trace }
}
async function collect(fixture, extra = {}) {
  const events = []
  for await (const event of fixture.runtime.streamTurn({
    turnId: 'test',
    userText: '你好',
    tools: [{ name: 'write', description: 'proposal' }],
    trace: async (type, payload) => fixture.trace.push({ type, payload }),
    ...extra
  })) {
    events.push(event)
    if (event.type === 'tool.call')
      await fixture.runtime.submitToolResult({
        turnId: 'test',
        providerCallId: event.providerCallId,
        result: { ok: true, data: { proposalId: 'one-proposal' } }
      })
  }
  return events
}

// Empty reasoning-only truncation takes precedence over required-tool validation.
let fixture = api([reply('', 'length')])
let events = await collect(fixture, { userText: '请修改总纲' })
assert.equal(events.at(-1).code, 'MODEL_OUTPUT_TRUNCATED')
assert.equal(fixture.requests.length, 1, 'No same-budget automatic retry')
assert.equal(
  events.some((e) => e.type === 'turn.completed'),
  false
)

fixture = api([reply('部分回答', 'length', [call('unsafe', 'write', '{"content":')])])
events = await collect(fixture)
assert.equal(
  events.some((e) => e.type === 'tool.call'),
  false
)
assert.match(events.find((e) => e.type === 'message.completed').text, /回答未完成.*\n部分回答/)

fixture = api(
  [reply('', 'tool_calls', [call('already-created')]), reply('', 'length'), reply('完成')],
  { truncationRetryMaxOutputTokens: 16384 }
)
events = await collect(fixture)
assert.equal(events.at(-1).type, 'turn.completed')
assert.equal(
  events.filter((e) => e.type === 'tool.call').length,
  1,
  'Completed proposal is not replayed'
)
assert.deepEqual(
  fixture.requests.map((r) => r.max_tokens),
  [8192, 8192, 16384]
)
assert.deepEqual(fixture.requests[1].messages, fixture.requests[2].messages)
assert.equal(events.filter((e) => e.type === 'usage').length, 3, 'Include failed attempt usage')

fixture = api(
  [
    reply('', 'length', [call('discarded')]),
    reply('', 'tool_calls', [call('accepted')]),
    reply('完成')
  ],
  { truncationRetryMaxOutputTokens: 16384 }
)
events = await collect(fixture)
assert.deepEqual(
  events.filter((e) => e.type === 'tool.call').map((e) => e.providerCallId),
  ['accepted']
)

fixture = api([reply('', 'length'), reply('第二次也未完成', 'length')], {
  truncationRetryMaxOutputTokens: 16384
})
events = await collect(fixture)
assert.equal(fixture.requests.length, 2)
assert.equal(events.at(-1).outputLimit, 16384)

fixture = api([reply('', 'length'), reply('', 'tool_calls', [call('once')]), reply('', 'length')], {
  truncationRetryMaxOutputTokens: 16384
})
events = await collect(fixture)
assert.equal(fixture.requests.length, 3, 'At most one truncation retry across the entire turn')
assert.equal(events.at(-1).code, 'MODEL_OUTPUT_TRUNCATED')

const aborted = new Error('cancelled during retry')
aborted.name = 'AbortError'
fixture = api([reply('', 'length'), aborted], { truncationRetryMaxOutputTokens: 16384 })
events = await collect(fixture)
assert.equal(events.at(-1).type, 'turn.cancelled')

fixture = api([reply('原始片段', 'length'), new Error('recovery unavailable')], {
  truncationRetryMaxOutputTokens: 16384
})
events = await collect(fixture)
assert.equal(events.at(-1).code, 'MODEL_OUTPUT_TRUNCATED')
assert.match(events.find((e) => e.type === 'message.completed').text, /原始片段/)

for (const condition of ['context', 'deadline', 'capacity']) {
  fixture = api(
    [reply('', 'length', undefined, condition === 'context' ? 60000 : 100)],
    { truncationRetryMaxOutputTokens: 16384 },
    condition === 'capacity' ? { maxOutputTokens: 8192 } : {}
  )
  events = await collect(fixture, condition === 'deadline' ? { deadlineAt: Date.now() + 1000 } : {})
  assert.equal(fixture.requests.length, 1, condition)
  assert.equal(events.at(-1).code, 'MODEL_OUTPUT_TRUNCATED')
}

fixture = api([reply('', 'tool_calls', [call('one')]), reply('收尾未完成', 'length')])
events = await collect(fixture, { runtimeBudget: { maxToolRounds: 1 } })
assert.equal(events.at(-1).code, 'MODEL_OUTPUT_TRUNCATED', 'Finalization must also check length')
assert.equal(fixture.requests[1].tools, undefined, 'Finalization omits tool definitions')
assert.equal(fixture.requests[1].tool_choice, undefined, 'Finalization omits tool choice')

assert.equal(resolveExecutionBudget().maxToolCalls, 24)
assert.equal(resolveExecutionBudget().maxToolRounds, 24)
assert.equal(resolveExecutionBudget().maxReadToolCalls, 18)
assert.equal(resolveExecutionBudget({ maxToolCalls: 4, maxToolRounds: 2 }).maxReadToolRounds, 2)
assert.throws(() => resolveExecutionBudget({ maxToolCalls: 4, maxReadToolCalls: 5 }))

const root = await fs.mkdtemp(path.join(os.tmpdir(), '51mazi-truncation-budget-'))
try {
  const store = new HarnessStore({ snapshotService: { resolveBookPath: () => root } })
  const registry = new DomainToolRegistry()
  const executed = []
  for (const [name, risk] of [
    ['read', 'read'],
    ['write', 'proposal']
  ])
    registry.register({
      name,
      risk,
      version: '2',
      description: name,
      inputSchema: {
        type: 'object',
        properties: { n: { type: 'integer' } },
        required: ['n'],
        additionalProperties: false
      },
      execute: async (_context, args) => {
        executed.push({ name, ...args })
        return { data: { n: args.n } }
      }
    })
  class RecordingRuntime extends FakeRuntime {
    results = []
    async submitToolResult(input) {
      this.results.push(input)
      return super.submitToolResult(input)
    }
  }
  const toolEvent = (n, name = 'read', roundId = n) => ({
    type: 'tool.call',
    providerCallId: `call-${n}`,
    name,
    roundId,
    arguments: { n }
  })
  const end = [{ type: 'message.completed', text: '结束' }, { type: 'turn.completed' }]
  async function run(script, budget = {}, selectedRegistry = registry) {
    const runtime = new RecordingRuntime({ script: [...script, ...end] })
    const conversation = await store.createConversation({ bookKey: 'book', runtimeId: 'fake' })
    const coordinator = new TurnCoordinator({
      store,
      toolRegistry: selectedRegistry,
      contextAssembler: new ContextAssembler(),
      runtimes: new Map([['fake', runtime]]),
      ...budget
    })
    const result = await coordinator.startTurn(conversation.conversationId, '处理资料', {
      bookKey: 'book'
    })
    assert.equal(result.state, 'completed')
    return runtime.results.map((r) => r.result)
  }
  let results = await run(Array.from({ length: 7 }, (_, i) => toolEvent(i + 1)))
  assert(
    results.every((r) => r.ok),
    'Seventh sequential call must now succeed'
  )
  const script = Array.from({ length: 19 }, (_, i) => toolEvent(i + 1))
  script.push({ ...toolEvent(20, 'write'), arguments: {} }, toolEvent(21, 'write'))
  results = await run(script)
  assert(results.slice(0, 18).every((r) => r.ok))
  assert.equal(results[17].executionBudget.remainingReadCalls, 0)
  assert.equal(results[17].executionBudget.remainingToolCalls, 6)
  assert.equal(results[18].error.code, 'READ_BUDGET_EXHAUSTED')
  assert.equal(results[19].ok, false, 'Invalid proposal still uses hard budget')
  assert.equal(results[20].ok, true, 'Proposal repair can use reserved budget')
  assert.equal(
    executed.some((e) => e.name === 'read' && e.n === 19),
    false
  )

  results = await run([toolEvent(1), toolEvent(2), toolEvent(3), toolEvent(4, 'write')], {
    maxReadToolCalls: 18,
    maxReadToolRounds: 2
  })
  assert.equal(results[2].error.code, 'READ_BUDGET_EXHAUSTED', 'Reserve rounds, not just calls')
  assert.equal(results[3].ok, true)

  results = await run(Array.from({ length: 25 }, (_, i) => toolEvent(i + 1, 'write', 1)))
  assert(results.slice(0, 24).every((r) => r.ok))
  assert.equal(
    results[24].error.code,
    'TOOL_LIMIT_REACHED',
    'Hard call limit still applies within one round'
  )
  results = await run([toolEvent(1, 'write'), toolEvent(2, 'write'), toolEvent(3, 'write')], {
    maxToolRounds: 2
  })
  assert.equal(results[2].error.code, 'TOOL_LIMIT_REACHED')

  const readOnly = new DomainToolRegistry()
  readOnly.register(registry.get('read'))
  results = await run(
    Array.from({ length: 20 }, (_, i) => toolEvent(i + 1)),
    {},
    readOnly
  )
  assert(
    results.every((r) => r.ok),
    'No proposal reserve for read-only toolsets'
  )

  fixture = api([reply('保留这段回答', 'length')])
  const conversation = await store.createConversation({ bookKey: 'book', runtimeId: 'agent-api' })
  const coordinator = new TurnCoordinator({
    store,
    toolRegistry: registry,
    contextAssembler: new ContextAssembler(),
    runtimes: new Map([['agent-api', fixture.runtime]])
  })
  const result = await coordinator.startTurn(conversation.conversationId, '你好', {
    bookKey: 'book'
  })
  assert.equal(result.state, 'failed')
  const saved = await store.loadConversation('book', conversation.conversationId)
  assert(
    saved.transcript.some(
      (e) =>
        e.type === 'message.assistant' &&
        e.payload.incomplete &&
        e.payload.text.includes('保留这段回答')
    )
  )
  assert(
    saved.transcript.some(
      (e) => e.type === 'turn.failed' && e.payload.code === 'MODEL_OUTPUT_TRUNCATED'
    )
  )
  assert.equal(
    saved.transcript.some((e) => e.type === 'turn.completed'),
    false
  )
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
console.log(
  'Truncation recovery, partial persistence, tool limits and proposal reserve checks passed.'
)
