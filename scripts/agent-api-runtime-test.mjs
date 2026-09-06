import assert from 'node:assert/strict'
import AgentModelConfigService from '../src/main/services/agentModelConfigService.js'
import AgentApiRuntime, {
  chatCompletionsEndpoint,
  shouldRequireToolUse
} from '../src/main/harness/runtime/agentApiRuntime.js'
import AgentRouterRuntime from '../src/main/harness/runtime/agentRouterRuntime.js'
import { DeepSeekService } from '../src/main/services/deepseek.js'

class MemoryStore {
  constructor() {
    this.values = new Map()
  }
  get(key, fallback) {
    return this.values.has(key) ? this.values.get(key) : fallback
  }
  set(key, value) {
    this.values.set(key, structuredClone(value))
  }
}

const configService = new AgentModelConfigService({ store: new MemoryStore() })
configService.saveProvider('local_openai', {
  defaultRuntime: 'agent-api',
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'local-writer',
  apiKey: ''
})
assert.equal(
  chatCompletionsEndpoint({ baseUrl: 'http://127.0.0.1:1234/v1/' }),
  'http://127.0.0.1:1234/v1/chat/completions'
)
assert.equal(shouldRequireToolUse('阅读分章节大纲并写入总纲'), true)
assert.equal(shouldRequireToolUse('是的，请你尝试'), true)
assert.equal(shouldRequireToolUse('理论上代码已经修改了，请你再次尝试'), true)
assert.equal(shouldRequireToolUse('你没法调用编辑工具？'), true)
assert.equal(shouldRequireToolUse('你会不会使用工具？'), false)
assert.equal(shouldRequireToolUse('不要调用工具，只解释规则'), false)

const requests = []
const responses = [
  {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'book_read', arguments: '{"chapter":"1"}' }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
  },
  {
    choices: [
      { message: { role: 'assistant', content: '已读取并完成回答。' }, finish_reason: 'stop' }
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
  }
]
const fetchImpl = async (_url, options) => {
  requests.push(JSON.parse(options.body))
  return { ok: true, json: async () => responses.shift() }
}
const runtime = new AgentApiRuntime({ configService, fetchImpl })
const events = []
const controller = new AbortController()
for await (const event of runtime.streamTurn({
  conversationId: 'conversation-1',
  turnId: 'turn-1',
  model: 'agent::local_openai',
  instructions: { baseInstructions: 'base', developerInstructions: 'developer' },
  contextText: 'context',
  userText: '请读取第一章',
  tools: [
    {
      name: 'book_read',
      description: '读取章节',
      inputSchema: { type: 'object', properties: { chapter: { type: 'string' } } }
    }
  ],
  signal: controller.signal
})) {
  events.push(event)
  if (event.type === 'tool.call') {
    await runtime.submitToolResult({
      turnId: 'turn-1',
      providerCallId: event.providerCallId,
      result: { ok: true, text: '第一章内容' }
    })
  }
}
assert.equal(
  events.some((event) => event.type === 'tool.call'),
  true
)
assert.equal(events.find((event) => event.type === 'message.completed')?.text, '已读取并完成回答。')
assert.equal(events.at(-1)?.type, 'turn.completed')
assert.equal(requests[1].messages.at(-1).role, 'tool')
assert.equal(requests[0].tool_choice, 'required')
assert.equal(requests[1].tool_choice, 'auto')

const ignoredRequiredRuntime = new AgentApiRuntime({
  configService,
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      choices: [
        { message: { role: 'assistant', content: '我无法调用工具。' }, finish_reason: 'stop' }
      ]
    })
  })
})
const ignoredRequiredEvents = []
for await (const event of ignoredRequiredRuntime.streamTurn({
  conversationId: 'conversation-required',
  turnId: 'turn-required',
  model: 'agent::local_openai',
  instructions: { baseInstructions: 'base', developerInstructions: 'developer' },
  userText: '你没法调用编辑工具？',
  tools: [
    {
      name: 'book_read',
      description: '读取章节',
      inputSchema: { type: 'object', properties: { chapter: { type: 'string' } } }
    }
  ]
})) {
  ignoredRequiredEvents.push(event)
}
assert.equal(ignoredRequiredEvents.at(-1)?.type, 'turn.failed')
assert.equal(ignoredRequiredEvents.at(-1)?.code, 'AGENT_TOOL_CALL_REQUIRED')
assert.equal(
  ignoredRequiredEvents.some((event) => event.type === 'message.completed'),
  false
)

const finalizationResponses = [
  {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'limit-call',
              type: 'function',
              function: { name: 'book_read', arguments: '{"chapter":"1"}' }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  },
  {
    choices: [
      {
        message: {
          role: 'assistant',
          content:
            '我还需要创建提案。<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="propose_outline_edit">未执行调用</｜｜DSML｜｜invoke>'
        },
        finish_reason: 'stop'
      }
    ]
  }
]
const finalizationRuntime = new AgentApiRuntime({
  configService,
  fetchImpl: async () => ({ ok: true, json: async () => finalizationResponses.shift() })
})
const finalizationEvents = []
for await (const event of finalizationRuntime.streamTurn({
  conversationId: 'conversation-limit',
  turnId: 'turn-limit',
  model: 'agent::local_openai',
  instructions: { baseInstructions: 'base', developerInstructions: 'developer' },
  userText: '创建提案',
  tools: [
    {
      name: 'book_read',
      description: '读取章节',
      inputSchema: { type: 'object', properties: { chapter: { type: 'string' } } }
    }
  ],
  runtimeBudget: { maxToolRounds: 1 }
})) {
  finalizationEvents.push(event)
  if (event.type === 'tool.call') {
    await finalizationRuntime.submitToolResult({
      turnId: 'turn-limit',
      providerCallId: event.providerCallId,
      result: { ok: true, text: '第一章内容' }
    })
  }
}
const finalizationMessage = finalizationEvents.find(
  (event) => event.type === 'message.completed'
)?.text
assert.doesNotMatch(finalizationMessage, /DSML|propose_outline_edit/)
assert.match(finalizationMessage, /最后的工具请求未执行/)
assert.equal(finalizationEvents.at(-1)?.stopReason, 'tool_limit_finalization')

const router = new AgentRouterRuntime({
  configService,
  agentRuntime: runtime,
  codexRuntime: {
    listModels: async () => ({ models: [{ id: 'codex-model', displayName: 'Codex Model' }] })
  }
})
assert.equal(router.resolve(null).runtime, runtime)
configService.saveProvider('local_openai', {
  defaultRuntime: 'codex-app-server',
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'local-writer',
  apiKey: ''
})
const catalog = await router.listModels()
assert.equal(
  catalog.models.some((model) => model.id === 'codex::default'),
  true
)
assert.equal(
  catalog.models.some((model) => model.id === 'codex::codex-model'),
  true
)
assert.equal(
  catalog.models.some((model) => model.id === 'agent::local_openai'),
  true
)

const previousFetch = globalThis.fetch
let legacyRequest
globalThis.fetch = async (_url, options) => {
  legacyRequest = JSON.parse(options.body)
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: '辅助写作结果' } }] })
  }
}
try {
  const legacyWritingService = new DeepSeekService()
  legacyWritingService.setAgentConfigService(configService)
  const result = await legacyWritingService.chat({
    model: 'deprecated-deepseek-model',
    messages: [{ role: 'user', content: '完善设定' }]
  })
  assert.equal(result.content, '辅助写作结果')
  assert.equal(legacyRequest.model, 'local-writer')
} finally {
  globalThis.fetch = previousFetch
}

console.log('Agent API runtime contract passed.')
