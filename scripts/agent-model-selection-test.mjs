import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { ref, computed } from 'vue'
import AgentModelConfigService from '../src/main/services/agentModelConfigService.js'
import { agentReasoningCapabilities } from '../src/main/services/agentReasoning.js'
import { requestAgentCompletion } from '../src/main/services/agentCompletionClient.js'
import AgentRouterRuntime from '../src/main/harness/runtime/agentRouterRuntime.js'
import AgentApiRuntime from '../src/main/harness/runtime/agentApiRuntime.js'
import DomainHarnessService from '../src/main/harness/domainHarnessService.js'
import HarnessStore from '../src/main/harness/store/harnessStore.js'

const clone = (value) => JSON.parse(JSON.stringify(value))
const values = new Map()
const config = new AgentModelConfigService({
  store: {
    get: (key, fallback) => values.get(key) ?? fallback,
    set: (key, value) => values.set(key, clone(value))
  }
})
config.setConfig({
  defaultRuntime: 'agent-api',
  selectedProvider: 'deepseek',
  providers: {
    deepseek: {
      baseUrl: 'https://deepseek.example/v1',
      model: 'deepseek-v4-pro',
      apiKey: 'test-deepseek',
      thinkingEnabled: false
    },
    gpt: { baseUrl: 'https://gpt.example/v1', model: 'gpt-5.2', apiKey: 'test-gpt' },
    local_openai: { baseUrl: 'http://localhost:1234/v1', model: 'writer', apiKey: '' }
  }
})
config.setConfig({ providers: { deepseek: { model: 'deepseek-v4-pro' } } })
assert.equal(config.getStoredConfig().defaultRuntime, 'agent-api')
assert.equal(config.getProvider('deepseek').thinkingEnabled, false)
assert.equal(config.listConfiguredProviders().length, 3)
const beforeValidation = clone(config.getStoredConfig())
const candidate = config.prepareProvider('gpt', { model: 'gpt-5', apiKey: 'validation-only' })
assert.equal(candidate.model, 'gpt-5')
assert.deepEqual(
  config.getStoredConfig(),
  beforeValidation,
  'Validation drafts must not persist or change the default'
)
assert.throws(() => config.getProvider('deleted-provider'), /重新选择/)

let codexCalls = 0
const stalledRouter = new AgentRouterRuntime({
  configService: config,
  codexRuntime: {
    listModels: () => {
      codexCalls += 1
      return new Promise(() => {})
    }
  }
})
stalledRouter.catalogTimeoutMs = 15
const local = await stalledRouter.listModels({ includeCodexModels: false })
assert.equal(codexCalls, 0, 'Saved API configurations must load without starting Codex')
assert.equal(local.models.find((model) => model.id === 'agent::deepseek').isDefault, true)
assert.equal(
  JSON.stringify(local).includes('test-deepseek'),
  false,
  'Model catalogue must not contain keys'
)
const partial = await stalledRouter.listModels()
assert.equal(partial.codexModelsUnavailable, true)
assert.equal(partial.models.length, local.models.length)
await stalledRouter.listModels()
assert.equal(codexCalls, 1, 'Timeout retries must share the outstanding catalogue request')
const router = new AgentRouterRuntime({
  configService: config,
  codexRuntime: {
    listModels: async () => ({
      data: [
        {
          id: 'display-id',
          model: 'codex-model',
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
          defaultReasoningEffort: 'high'
        }
      ]
    })
  }
})
const full = await router.listModels()
assert.ok(
  full.models.find((model) => model.id === 'codex::codex-model'),
  'Codex catalogue must also load when API is the default'
)
assert.deepEqual(full.models[0].supportedReasoningEfforts, [{ reasoningEffort: 'high' }])
assert.deepEqual(
  agentReasoningCapabilities({ id: 'gpt', model: 'gpt-4o' }).supportedReasoningEfforts,
  []
)

const requests = []
const fetchImpl = async (url, options) => {
  requests.push({ url, headers: options.headers, body: JSON.parse(options.body) })
  return { ok: true, json: async () => ({ choices: [{ message: { content: '完成' } }] }) }
}
await requestAgentCompletion({
  provider: config.getProvider('gpt'),
  messages: [],
  effort: 'xhigh',
  fetchImpl
})
assert.equal(requests.at(-1).body.reasoning_effort, 'xhigh')
assert.equal(requests.at(-1).body.max_completion_tokens, 8192)
assert.equal(requests.at(-1).body.max_tokens, undefined)
await requestAgentCompletion({
  provider: config.getProvider('deepseek'),
  messages: [],
  effort: 'max',
  fetchImpl
})
assert.deepEqual(requests.at(-1).body.thinking, { type: 'enabled' })
assert.equal(requests.at(-1).body.reasoning_effort, 'max')
await requestAgentCompletion({
  provider: config.getProvider('deepseek'),
  messages: [],
  effort: 'none',
  fetchImpl
})
assert.deepEqual(requests.at(-1).body.thinking, { type: 'disabled' })
assert.equal(requests.at(-1).body.reasoning_effort, undefined)
await requestAgentCompletion({ provider: config.getProvider('deepseek'), messages: [], fetchImpl })
assert.deepEqual(requests.at(-1).body.thinking, { type: 'disabled' })
await requestAgentCompletion({
  provider: config.getProvider('local_openai'),
  messages: [],
  fetchImpl
})
assert.equal(requests.at(-1).body.thinking, undefined)
assert.equal(requests.at(-1).body.reasoning_effort, undefined)
await assert.rejects(
  requestAgentCompletion({
    provider: config.getProvider('local_openai'),
    messages: [],
    effort: 'high',
    fetchImpl
  }),
  /不支持/
)

// Exercise routing through the actual API runtime, including the final tool-budget request.
const selectionTools = [
  { type: 'function', function: { name: 'read', parameters: { type: 'object' } } }
]
for (const [provider, effort, expected] of [
  [{ id: 'deepseek', model: 'deepseek-v4-flash' }, undefined, 'auto'],
  [{ id: 'deepseek', model: 'deepseek-v4-pro', thinkingEnabled: false }, 'max', 'auto'],
  [{ id: 'deepseek', model: 'deepseek-chat' }, 'high', 'auto'],
  [{ id: 'deepseek', model: 'deepseek-reasoner' }, undefined, 'auto'],
  [{ id: 'deepseek', model: 'deepseek-v4-flash' }, 'none', 'required'],
  [{ id: 'deepseek', model: 'deepseek-v4-pro', thinkingEnabled: false }, undefined, 'required'],
  [{ id: 'gpt', model: 'gpt-5.2' }, 'high', 'required'],
  [{ id: 'local_openai', model: 'writer' }, undefined, 'required']
]) {
  await requestAgentCompletion({
    provider: { ...provider, baseUrl: 'https://test.example/v1' },
    effort,
    tools: selectionTools,
    toolChoice: 'required',
    messages: [],
    fetchImpl
  })
  assert.equal(requests.at(-1).body.tool_choice, expected, `${provider.model}/${effort}`)
}

let round = 0
const toolRequests = []
const toolTrace = []
const runtime = new AgentApiRuntime({
  configService: config,
  fetchImpl: async (url, options) => {
    toolRequests.push({ url, headers: options.headers, body: JSON.parse(options.body) })
    const body = toolRequests.at(-1).body
    if (body.thinking?.type === 'enabled' && body.tool_choice === 'required') {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          error: { message: 'Thinking mode does not support this tool_choice' }
        })
      }
    }
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message:
              round++ === 0
                ? {
                    content: null,
                    reasoning_content: 'synthetic reasoning',
                    tool_calls: [{ id: 'read-1', function: { name: 'book_read', arguments: '{}' } }]
                  }
                : { content: '完成' }
          }
        ]
      })
    }
  }
})
router.agentRuntime = runtime
for await (const event of router.streamTurn({
  turnId: 'selection-turn',
  model: 'agent::deepseek',
  effort: 'max',
  userText: '读取正文',
  tools: [{ name: 'book_read' }],
  runtimeBudget: { maxToolRounds: 1 },
  trace: async (type, payload) => toolTrace.push({ type, payload })
})) {
  if (event.type === 'tool.call')
    await router.submitToolResult({
      turnId: 'selection-turn',
      providerCallId: event.providerCallId,
      result: { ok: true }
    })
}
assert.equal(toolRequests.length, 2)
assert.equal(toolRequests[0].body.tool_choice, 'auto')
assert.equal(toolRequests[1].body.tool_choice, undefined)
assert.equal(toolTrace[0].payload.requestedToolChoice, 'required')
assert.equal(toolTrace[0].payload.toolChoice, toolRequests[0].body.tool_choice)
assert.equal(toolRequests[0].url, 'https://deepseek.example/v1/chat/completions')
assert.equal(toolRequests[0].headers.Authorization, 'Bearer test-deepseek')
assert.equal(toolRequests[1].body.reasoning_effort, 'max')
assert.equal(
  toolRequests[1].body.messages.find((item) => item.role === 'assistant').reasoning_content,
  'synthetic reasoning'
)
assert.deepEqual(
  config.getStoredConfig(),
  beforeValidation,
  'Conversation choices must not alter saved provider parameters'
)

// Compatibility must not let a text-only reply masquerade as tool execution.
const textOnlyRuntime = new AgentApiRuntime({ configService: config, fetchImpl })
const textOnlyEvents = []
for await (const event of textOnlyRuntime.streamTurn({
  turnId: 'deepseek-no-tool',
  model: 'agent::deepseek',
  effort: 'max',
  userText: '修改总纲',
  tools: [{ name: 'edit' }]
}))
  textOnlyEvents.push(event)
assert.equal(requests.at(-1).body.tool_choice, 'auto')
assert.equal(textOnlyEvents.at(-1).code, 'AGENT_TOOL_CALL_REQUIRED')
assert.equal(
  textOnlyEvents.some((event) => event.type === 'turn.completed'),
  false
)

const root = await fs.mkdtemp(join(os.tmpdir(), '51mazi-model-selection-'))
try {
  const service = Object.create(DomainHarnessService.prototype)
  service.ready = Promise.resolve()
  service.snapshotService = { resolveBookPath: () => root }
  service.store = new HarnessStore({ snapshotService: service.snapshotService })
  service.coordinator = {
    startTurn: async (id, text, workspace, options) => ({
      ...(await service.store.loadConversation(workspace.bookKey, id)).state,
      options,
      text
    })
  }
  const first = await service.createConversation({
    bookName: '测试',
    title: '旧对话',
    runtimeId: 'codex-app-server'
  })
  const second = await service.createConversation({
    bookName: '测试',
    title: '另一对话',
    runtimeId: 'agent-router',
    model: 'agent::gpt',
    effort: 'low'
  })
  const turn = await service.startTurn(
    {
      bookName: '测试',
      conversationId: first.conversationId,
      text: '测试',
      model: 'agent::deepseek',
      effort: 'max'
    },
    { scope: { bookKey: '测试' }, assertScope: () => {} }
  )
  assert.equal(turn.runtimeId, 'agent-router')
  assert.equal(turn.modelPreference, 'agent::deepseek')
  assert.equal(turn.effortPreference, 'max')
  const unchanged = await service.readConversation({
    bookName: '测试',
    conversationId: second.conversationId
  })
  assert.equal(unchanged.state.modelPreference, 'agent::gpt')
  unchanged.state.status = 'running'
  await service.store.updateState(unchanged.state)
  await assert.rejects(
    service.updateConversationSettings({
      bookName: '测试',
      conversationId: second.conversationId,
      model: 'agent::deepseek'
    }),
    /等待/
  )
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

async function component(file, context, exposed) {
  const source = await fs.readFile(
    new URL(`../src/renderer/src/components/${file}`, import.meta.url),
    'utf8'
  )
  const script = source
    .match(/<script setup>([\s\S]*?)<\/script>/)[1]
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?\n/gm, '')
  return vm.runInNewContext(`${script}\n;({${exposed.join(',')}})`, {
    ref,
    computed,
    watch: () => {},
    onMounted: () => {},
    onBeforeUnmount: () => {},
    defineExpose: () => {},
    defineModel: () => ref(false),
    defineProps: () => ({ bookName: '测试' }),
    defineEmits: () => () => {},
    useI18n: () => ({ t: (key) => key }),
    ElMessage: { error: () => {}, success: () => {}, warning: () => {} },
    window: { electron: {}, dispatchEvent: () => {} },
    CustomEvent: class {},
    setTimeout,
    clearTimeout,
    ...context
  })
}
let savedPayload
const settings = await component(
  'AISettings.vue',
  {
    setAgentApiConfig: async (payload) => {
      savedPayload = payload
    },
    setTongyiwanxiangApiKey: async () => ({ success: true }),
    setGeminiApiKey: async () => ({ success: true }),
    setDoubaoConfig: async () => ({ success: true }),
    setFunctionApiConfig: async () => ({ success: true })
  },
  [
    'agentProviderId',
    'agentDefaultProviderId',
    'agentDefaultRuntime',
    'agentProviderCatalog',
    'agentProviderConfigs',
    'agentBaseUrl',
    'agentModel',
    'agentApiKey',
    'handleAgentProviderChange',
    'applyAgentProvider',
    'handleSave',
    'booksDirReady'
  ]
)
settings.agentProviderCatalog.value = config.getConfig().catalog
settings.agentProviderConfigs.value = config.getConfig().providers
settings.agentDefaultRuntime.value = 'agent-api'
settings.applyAgentProvider('deepseek')
settings.agentModel.value = 'draft-deepseek'
settings.handleAgentProviderChange('gpt')
settings.agentModel.value = 'draft-gpt'
settings.handleAgentProviderChange('deepseek')
assert.equal(settings.agentModel.value, 'draft-deepseek')
assert.equal(settings.agentDefaultProviderId.value, 'deepseek')
settings.booksDirReady.value = true
await settings.handleSave()
await new Promise((resolve) => setTimeout(resolve, 350))
assert.equal(savedPayload.providers.deepseek.model, 'draft-deepseek')
assert.equal(savedPayload.providers.gpt.model, 'draft-gpt')
assert.equal(savedPayload.selectedProvider, 'deepseek')

let finishCatalogue
const remote = new Promise((resolve) => {
  finishCatalogue = resolve
})
const sidebar = await component(
  'Agent/HarnessChatSidebar.vue',
  {
    harnessClient: {
      listModels: async ({ includeCodexModels }) => (includeCodexModels ? remote : local)
    }
  },
  [
    'loadModels',
    'modelCatalog',
    'modelPreference',
    'effortPreference',
    'selectedModel',
    'effortOptions',
    'applyConversationPreferences',
    'handleModelChange',
    'modelsLoading'
  ]
)
sidebar.applyConversationPreferences({
  modelPreference: 'agent::deepseek',
  effortPreference: 'max'
})
const loading = sidebar.loadModels()
await new Promise((resolve) => setImmediate(resolve))
assert.ok(sidebar.modelCatalog.value.some((model) => model.id === 'agent::gpt'))
assert.equal(
  sidebar.modelsLoading.value,
  true,
  'Saved models are available while remote catalogue is pending'
)
assert.equal(
  sidebar.effortPreference.value,
  'max',
  'Async catalogue loading must not erase stored effort'
)
finishCatalogue(partial)
await loading
assert.equal(sidebar.effortPreference.value, 'max')
sidebar.modelPreference.value = 'agent::gpt'
sidebar.handleModelChange()
assert.equal(sidebar.effortPreference.value, 'codex-default')
assert.ok(sidebar.effortOptions.value.includes('xhigh'))
sidebar.applyConversationPreferences({ modelPreference: 'deleted-model', effortPreference: 'high' })
await sidebar.loadModels()
assert.equal(
  sidebar.modelPreference.value,
  'codex::deleted-model',
  'Missing model must not silently switch provider'
)
console.log(
  'Agent model selection, reasoning, conversation persistence and renderer checks passed.'
)
