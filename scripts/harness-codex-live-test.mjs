import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import ConversationRetrievalService from '../src/main/harness/retrieval/conversationRetrievalService.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import { createBookReadTools } from '../src/main/harness/tools/bookReadTools.js'
import ContextAssembler from '../src/main/harness/context/contextAssembler.js'
import TurnCoordinator from '../src/main/harness/turn/turnCoordinator.js'
import CodexAppServerRuntime from '../src/main/harness/runtime/codexAppServerRuntime.js'

if (process.env.MAZI_RUN_CODEX_INTEGRATION !== '1') {
  console.log(
    'harness Codex live test skipped: set MAZI_RUN_CODEX_INTEGRATION=1 on an authenticated test machine'
  )
  process.exit(0)
}

const root = await fs.mkdtemp(join(os.tmpdir(), '51mazi-codex-live-'))
const bookName = 'live-fixture'
const reference = 'chapter:vol%2F01%2Fchapter-1.txt@sha256:1a2b3c4d'
const toolCalls = []
const retrievalService = {
  listBookStructure(book, scopes) {
    toolCalls.push({ name: 'list_book_structure', book, scopes })
    return {
      chapters: [
        {
          targetId: 'vol/01/chapter-1.txt',
          title: '第一章',
          reference,
          contentHash: 'sha256:live-fixture'
        }
      ],
      characters: [],
      outlines: [],
      notes: []
    }
  },
  searchBookKnowledge(book, query) {
    toolCalls.push({ name: 'search_book_knowledge', book, query })
    return {
      results: [
        {
          sourceType: 'chapter',
          targetId: 'vol/01/chapter-1.txt',
          title: '第一章',
          snippet: '林默在雨夜打开了旧信封。',
          reference,
          contentHash: 'sha256:live-fixture',
          authorityStatus: 'authoritative_saved'
        }
      ],
      truncated: false,
      builtAt: new Date().toISOString()
    }
  },
  readBookSource(book, sourceReference) {
    toolCalls.push({ name: 'read_book_source', book, reference: sourceReference })
    return {
      versionChanged: false,
      content: '林默在雨夜打开了旧信封，发现落款是已经失踪多年的姐姐。',
      location: { startLine: 1, endLine: 1 },
      truncated: false,
      source: {
        sourceType: 'chapter',
        targetId: 'vol/01/chapter-1.txt',
        reference,
        contentHash: 'sha256:live-fixture',
        authorityStatus: 'authoritative_saved',
        metadata: { chapterName: '第一章' }
      }
    }
  }
}

const snapshotService = { resolveBookPath: () => root }
const store = new HarnessStore({ snapshotService })
const conversationRetrievalService = new ConversationRetrievalService({ store })
const registry = new DomainToolRegistry()
createBookReadTools({ retrievalService, conversationRetrievalService }).forEach((tool) =>
  registry.register(tool)
)
const runtime = new CodexAppServerRuntime()
runtime.bridge.on('status', (status) => console.log('harness live runtime: ' + status.phase))
runtime.bridge.on('protocol-warning', (warning) =>
  console.log('harness live protocol warning: ' + warning.message)
)
runtime.bridge.on('server-request-rejected', (event) =>
  console.log('harness live rejected server request: ' + event.method)
)
const coordinator = new TurnCoordinator({
  store,
  toolRegistry: registry,
  contextAssembler: new ContextAssembler(),
  runtimes: new Map([[runtime.id, runtime]]),
  turnTimeoutMs: 120000,
  toolTimeoutMs: 20000,
  eventSink: (event) => {
    if (event.type === 'turn.state') console.log('harness live turn state: ' + event.state)
    if (event.type === 'tool.state')
      console.log(
        `harness live tool: ${event.toolName} ${event.state}${event.displayText ? ` (${event.displayText})` : ''}`
      )
    if (event.type === 'diagnostic')
      console.log(`harness live diagnostic: ${event.code} ${event.message || ''}`)
  }
})

try {
  const conversation = await store.createConversation({
    bookKey: bookName,
    title: 'Codex live fixture',
    runtimeId: runtime.id
  })
  const outcome = await coordinator.startTurn(
    conversation.conversationId,
    '请完成一次只读资料核验：必须先调用 search_book_knowledge 搜索“旧信封”，再使用搜索结果中的 reference 调用 read_book_source，最后用一句话回答姐姐留下了什么线索。不要猜测，也不要修改任何内容。',
    { bookKey: bookName, currentModule: 'editor', currentDocumentId: 'chapter-1' }
  )
  assert.equal(outcome.state, 'completed', JSON.stringify(outcome))
  assert.ok(
    toolCalls.some((call) => call.name === 'search_book_knowledge'),
    'live flow 未调用 search_book_knowledge'
  )
  assert.ok(
    toolCalls.some((call) => call.name === 'read_book_source'),
    'live flow 未调用 read_book_source'
  )
  const data = await store.loadConversation(bookName, conversation.conversationId)
  assert.ok(
    data.transcript.some((item) => item.type === 'message.assistant'),
    'live flow 未持久化最终回答'
  )

  const previousConversation = await store.createConversation({
    bookKey: bookName,
    title: '前次人物讨论',
    runtimeId: runtime.id
  })
  const previousTurnId = 'turn-live-history'
  await store.appendTranscript(
    previousConversation,
    'message.user',
    previousTurnId,
    'msg-live-history-user',
    { text: '请记住：姐姐留下的第二条线索是一把蓝玻璃钥匙。' }
  )
  await store.appendTranscript(
    previousConversation,
    'message.assistant',
    previousTurnId,
    'msg-live-history-assistant',
    { text: '已在本次讨论中记录蓝玻璃钥匙。' }
  )
  await store.appendTranscript(
    previousConversation,
    'turn.completed',
    previousTurnId,
    'msg-live-history-assistant',
    { stopReason: 'completed' }
  )
  previousConversation.lastCompletedMessageId = 'msg-live-history-assistant'
  await store.updateState(previousConversation)

  const recallConversation = await store.createConversation({
    bookKey: bookName,
    title: '跨对话回忆',
    runtimeId: runtime.id
  })
  const recallOutcome = await coordinator.startTurn(
    recallConversation.conversationId,
    '请回忆其他历史对话里姐姐留下的第二条线索。必须使用 search_book_knowledge 的 conversations scope 搜索“第二条线索”，再用命中的 conversation reference 调用 read_book_source，最后只回答线索内容。',
    { bookKey: bookName, currentModule: 'editor', currentDocumentId: 'chapter-1' }
  )
  assert.equal(recallOutcome.state, 'completed', JSON.stringify(recallOutcome))
  const recallData = await store.loadConversation(bookName, recallConversation.conversationId)
  assert.ok(
    recallData.ledger.some(
      (item) => item.toolName === 'search_book_knowledge' && item.state === 'completed'
    ),
    '跨对话 live flow 未搜索历史 Conversation'
  )
  assert.ok(
    recallData.ledger.some(
      (item) =>
        item.toolName === 'read_book_source' &&
        item.state === 'completed' &&
        item.references?.some((item) => item.startsWith('conversation:'))
    ),
    '跨对话 live flow 未读取 Conversation reference'
  )
  assert.match(
    recallData.transcript.findLast((item) => item.type === 'message.assistant')?.payload?.text ||
      '',
    /蓝玻璃钥匙/
  )

  console.log(
    'harness Codex live test passed: ' +
      JSON.stringify({
        state: outcome.state,
        recallState: recallOutcome.state,
        toolCalls: toolCalls.map((call) => call.name)
      })
  )
} catch (error) {
  console.error('harness Codex live test failed: ' + (error?.message || error))
  process.exitCode = 1
} finally {
  await runtime.dispose().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
}
