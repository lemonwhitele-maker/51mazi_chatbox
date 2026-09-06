import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import ContextAssembler from '../src/main/harness/context/contextAssembler.js'
import TurnCoordinator from '../src/main/harness/turn/turnCoordinator.js'
import FakeRuntime from '../src/main/harness/runtime/fakeRuntime.js'
import FunctionApiService, {
  createLocalConversationTitle
} from '../src/main/services/functionApiService.js'
import { shouldSendOnComposerKeydown } from '../src/renderer/src/components/Agent/chatComposer.js'

class MemorySettingsStore {
  constructor() { this.values = new Map() }
  get(key, fallback) { return this.values.has(key) ? this.values.get(key) : fallback }
  set(key, value) { this.values.set(key, value) }
}

const tempRoot = await fs.mkdtemp(join(os.tmpdir(), '51mazi-chat-ux-'))
try {
  const store = new HarnessStore({ snapshotService: { resolveBookPath: () => tempRoot } })
  const created = await store.createConversation({
    bookKey: '体验测试书',
    title: '讨论主角身世',
    runtimeId: 'fake',
    modelPreference: 'gpt-test',
    effortPreference: 'high',
    autoTitle: true
  })
  assert.equal(created.modelPreference, 'gpt-test')
  assert.equal(created.effortPreference, 'high')
  assert.equal(created.titleSource, 'local')
  assert.equal(created.autoTitleStatus, 'pending')

  const unavailableRuntime = {
    async getCapabilities() { throw new Error('runtime unavailable') }
  }
  const coordinator = new TurnCoordinator({
    store,
    toolRegistry: new DomainToolRegistry(),
    contextAssembler: new ContextAssembler(),
    runtimes: new Map([['fake', unavailableRuntime]])
  })
  await assert.rejects(
    coordinator.startTurn(created.conversationId, '这条 Prompt 必须保留', { bookKey: '体验测试书' }),
    /runtime unavailable/
  )
  const failedTurn = await store.loadConversation('体验测试书', created.conversationId)
  assert.equal(
    failedTurn.transcript.some(
      (event) => event.type === 'message.user' && event.payload?.text === '这条 Prompt 必须保留'
    ),
    true,
    'Runtime 失败不得丢失已提交 Prompt'
  )
  assert.equal(failedTurn.state.status, 'error')
  assert.equal(failedTurn.state.activeTurnId, null)

  const completedCallbackEvents = []
  const completedConversation = await store.createConversation({
    bookKey: '体验测试书',
    title: '检查自动命名',
    runtimeId: 'fake',
    autoTitle: true
  })
  const completedCoordinator = new TurnCoordinator({
    store,
    toolRegistry: new DomainToolRegistry(),
    contextAssembler: new ContextAssembler(),
    runtimes: new Map([['fake', new FakeRuntime()]]),
    onTurnCompleted: (event) => completedCallbackEvents.push(event)
  })
  await completedCoordinator.startTurn(
    completedConversation.conversationId,
    '修复人物管理删除功能',
    { bookKey: '体验测试书' }
  )
  assert.equal(completedCallbackEvents.length, 1)
  assert.equal(completedCallbackEvents[0].isFirstUserMessage, true)
  assert.equal(completedCallbackEvents[0].userText, '修复人物管理删除功能')
  assert.equal(completedCallbackEvents[0].assistantText, 'Fake Runtime 已接收本轮请求。')

  const titled = await store.completeAutoTitle({
    bookKey: '体验测试书',
    conversationId: created.conversationId,
    title: '王族身世伏笔',
    generated: true
  })
  assert.equal(titled.title, '王族身世伏笔')
  assert.equal(titled.titleSource, 'automatic')
  assert.equal(titled.autoTitleStatus, 'completed')

  const settingsStore = new MemorySettingsStore()
  const requests = []
  const functionApi = new FunctionApiService({
    store: settingsStore,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) })
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: '主角身世与王族伏笔' } }] }
        }
      }
    }
  })
  functionApi.setConfig({
    enabled: true,
    provider: 'custom',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1/',
    model: 'title-model'
  })
  const validation = await functionApi.validateConfig(functionApi.getConfig())
  assert.equal(validation.isValid, true)
  assert.equal(validation.config.lastValidationStatus, 'success')
  assert.ok(validation.config.lastValidatedAt)
  const generated = await functionApi.generateConversationTitle({
    userMessage: '讨论主角真实身世与王族关系',
    assistantMessage: '已经补充王族关系设定与三处伏笔。'
  })
  assert.deepEqual(generated, {
    title: '主角身世与王族伏笔',
    generated: true,
    reason: null
  })
  assert.equal(requests[1].url, 'https://example.test/v1/chat/completions')
  assert.equal(requests[1].body.messages.length, 2)
  assert.match(requests[1].body.messages[1].content, /用户请求：\n讨论主角真实身世与王族关系/)
  assert.match(requests[1].body.messages[1].content, /助手最终回答：\n已经补充王族关系设定与三处伏笔。/)

  functionApi.setConfig({ enabled: false, provider: 'deepseek', apiKey: '', model: 'deepseek-chat' })
  const fallback = await functionApi.generateConversationTitle('讨论主角真实身世与王族关系，以及后续伏笔')
  assert.equal(fallback.generated, false)
  assert.equal(fallback.title, createLocalConversationTitle('讨论主角真实身世与王族关系，以及后续伏笔'))

  const sidebar = await fs.readFile(
    new URL('../src/renderer/src/components/Agent/HarnessChatSidebar.vue', import.meta.url),
    'utf8'
  )
  const beginNewBody = sidebar.slice(
    sidebar.indexOf('function beginNewConversation()'),
    sidebar.indexOf('function handleConversationSelection')
  )
  assert.equal(beginNewBody.includes('createConversation('), false, '点击新对话不得立即落盘')
  assert.match(sidebar, /messages\.value = \[\.\.\.messages\.value, \{ id: localMessageId/)
  assert.ok(
    sidebar.indexOf('messages.value = [...messages.value, { id: localMessageId') <
      sidebar.indexOf('await harnessClient.startTurn'),
    'Prompt 必须在等待 API 前先显示'
  )
  assert.equal(
    shouldSendOnComposerKeydown(
      { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 },
      { draft: '发送这条消息', loading: false, composing: false }
    ),
    true
  )
  assert.equal(
    shouldSendOnComposerKeydown(
      { key: 'Enter', shiftKey: true, isComposing: false, keyCode: 13 },
      { draft: '需要换行', loading: false, composing: false }
    ),
    false
  )
  assert.equal(
    shouldSendOnComposerKeydown(
      { key: 'Enter', shiftKey: false, isComposing: true, keyCode: 229 },
      { draft: '输入法组词', loading: false, composing: true }
    ),
    false
  )
  assert.equal(
    shouldSendOnComposerKeydown(
      { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 },
      { draft: '   ', loading: false, composing: false }
    ),
    false
  )
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true })
}

console.log('Harness chat UX focused test passed')
