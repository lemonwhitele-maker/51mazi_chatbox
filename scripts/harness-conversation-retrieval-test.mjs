import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import ConversationRetrievalService from '../src/main/harness/retrieval/conversationRetrievalService.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import { createBookReadTools } from '../src/main/harness/tools/bookReadTools.js'

const root = await fs.mkdtemp(join(os.tmpdir(), '51mazi-conversation-retrieval-'))
const books = ['本书', '另一本书']
for (const book of books) await fs.mkdir(join(root, book), { recursive: true })

const snapshotService = {
  resolveBookPath: (bookKey) => join(root, bookKey),
  getBooksDir: () => root
}

const bookCalls = []
const retrievalService = {
  listBookStructure(bookKey, scopes) {
    bookCalls.push({ name: 'list', bookKey, scopes })
    return { bookName: bookKey, outlines: [] }
  },
  searchBookKnowledge(bookKey, query, options) {
    bookCalls.push({ name: 'search', bookKey, query, options })
    return {
      results: [
        {
          sourceType: 'outline',
          targetId: 'root',
          title: '正式大纲',
          snippet: '文科候选',
          reference: 'outline:root@sha256:abcd',
          contentHash: 'sha256:abcd',
          authorityStatus: 'authoritative_saved',
          score: 0.65
        }
      ],
      truncated: false
    }
  },
  readBookSource() {
    throw new Error('本测试不读取正式资料')
  }
}

async function appendCompletedTurn(store, state, { turnId, userText, assistantText }) {
  const userMessageId = `${turnId}-user`
  const assistantMessageId = `${turnId}-assistant`
  await store.appendTranscript(state, 'message.user', turnId, userMessageId, { text: userText })
  await store.appendTranscript(state, 'message.assistant', turnId, assistantMessageId, {
    text: assistantText
  })
  await store.appendTranscript(state, 'turn.completed', turnId, assistantMessageId, {
    stopReason: 'completed'
  })
  state.lastCompletedMessageId = assistantMessageId
  state.status = 'idle'
  await store.updateState(state)
}

try {
  const store = new HarnessStore({ snapshotService })
  const conversationRetrievalService = new ConversationRetrievalService({ store })
  const registry = new DomainToolRegistry()
  createBookReadTools({ retrievalService, conversationRetrievalService }).forEach((tool) =>
    registry.register(tool)
  )

  const previous = await store.createConversation({
    bookKey: '本书',
    title: '主角设定讨论',
    runtimeId: 'fake'
  })
  await appendCompletedTurn(store, previous, {
    turnId: 'turn-previous',
    userText: '主角设定为在985学习文科专业，是一名女性。',
    assistantText: '已记录这项人物设定讨论。'
  })
  await store.archiveConversation(previous)

  await store.importLegacyConversation({
    bookKey: '本书',
    conversationId: 'conv-legacy-search-fixture',
    title: '旧版导入讨论',
    archived: false,
    threadDigest: 'legacy-search-fixture',
    messages: [
      { role: 'user', content: '旧版对话里提到紫色纽扣。' },
      { role: 'assistant', content: '已记录紫色纽扣这条旧讨论。' }
    ]
  })

  const incomplete = await store.createConversation({
    bookKey: '本书',
    title: '未完成对话',
    runtimeId: 'fake'
  })
  await store.appendTranscript(incomplete, 'message.user', 'turn-incomplete', 'msg-incomplete', {
    text: '未完成秘密关键词'
  })

  const otherBook = await store.createConversation({
    bookKey: '另一本书',
    title: '跨书隔离',
    runtimeId: 'fake'
  })
  await appendCompletedTurn(store, otherBook, {
    turnId: 'turn-other-book',
    userText: '另一本书包含跨书秘密关键词。',
    assistantText: '这条内容不得被本书检索。'
  })

  const search = await registry.execute(
    'search_book_knowledge',
    { bookKey: '本书' },
    {
      query: '985 文科 女性',
      scopes: ['conversations'],
      limit: 8
    }
  )
  assert.equal(search.ok, true, JSON.stringify(search))
  assert.equal(bookCalls.length, 0, '仅搜索 conversations 时不应回退读取正式资料')
  assert.equal(search.data.hits.length, 1)
  assert.equal(search.data.hits[0].scope, 'conversation')
  assert.equal(search.data.hits[0].authorityStatus, 'unconfirmed_conversation')
  assert.match(search.data.hits[0].snippet, /985/)

  const read = await registry.execute(
    'read_book_source',
    { bookKey: '本书' },
    {
      source: { type: 'reference', reference: search.data.hits[0].reference },
      context: { before: 0, after: 0 },
      maxChars: 4000
    }
  )
  assert.equal(read.ok, true, JSON.stringify(read))
  assert.match(read.data.text, /985学习文科专业/)
  assert.equal(read.data.authorityStatus, 'unconfirmed_conversation')
  assert.equal(read.data.metadata.archived, true, '归档对话应保留可检索能力')

  const legacySearch = await registry.execute(
    'search_book_knowledge',
    { bookKey: '本书' },
    {
      query: '紫色纽扣',
      scopes: ['conversations'],
      limit: 8
    }
  )
  assert.equal(legacySearch.ok, true)
  assert.equal(
    legacySearch.data.hits.some((hit) => hit.objectId === 'conv-legacy-search-fixture'),
    true,
    '迁移进 Harness 的旧对话应可检索'
  )

  const incompleteSearch = await registry.execute(
    'search_book_knowledge',
    { bookKey: '本书' },
    {
      query: '未完成秘密关键词',
      scopes: ['conversations'],
      limit: 8
    }
  )
  assert.equal(incompleteSearch.data.hits.length, 0, '未完成 Turn 不得进入历史对话索引')

  const crossBookSearch = await registry.execute(
    'search_book_knowledge',
    { bookKey: '本书' },
    {
      query: '跨书秘密关键词',
      scopes: ['conversations'],
      limit: 8
    }
  )
  assert.equal(crossBookSearch.data.hits.length, 0, '历史对话检索不得跨书')

  const crossBookRead = await registry.execute(
    'read_book_source',
    { bookKey: '另一本书' },
    {
      source: { type: 'reference', reference: search.data.hits[0].reference },
      maxChars: 4000
    }
  )
  assert.equal(crossBookRead.ok, false, 'conversation reference 不得跨书读取')

  const combined = await registry.execute(
    'search_book_knowledge',
    { bookKey: '本书' },
    {
      query: '文科',
      scopes: ['outlines', 'conversations'],
      limit: 8
    }
  )
  assert.equal(combined.ok, true)
  assert.equal(
    combined.data.hits.some((hit) => hit.scope === 'outline'),
    true
  )
  assert.equal(
    combined.data.hits.some((hit) => hit.scope === 'conversation'),
    true
  )
  assert.equal(
    combined.data.hits.every((hit) => hit.authorityStatus),
    true
  )
  assert.equal(
    combined.data.hits[0].scope,
    'outline',
    '正式资料应在混合检索中优先于未确认历史对话'
  )

  const excludesCurrentConversation = await registry.execute(
    'search_book_knowledge',
    { bookKey: '本书', conversationId: previous.conversationId },
    {
      query: '985 文科 女性',
      scopes: ['conversations'],
      limit: 8
    }
  )
  assert.equal(
    excludesCurrentConversation.data.hits.some((hit) => hit.objectId === previous.conversationId),
    false,
    '当前对话不得作为自身纠错时的历史证据回流'
  )

  const structure = await registry.execute(
    'list_book_structure',
    { bookKey: '本书' },
    {
      scopes: ['conversations']
    }
  )
  assert.equal(structure.ok, true)
  assert.equal(structure.data.sections[0].scope, 'conversations')
  assert.equal(
    structure.data.sections[0].items.some((item) => item.id === previous.conversationId),
    true
  )

  console.log('Harness cross-conversation retrieval checks passed')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
