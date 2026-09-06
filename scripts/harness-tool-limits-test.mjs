import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import ContextAssembler from '../src/main/harness/context/contextAssembler.js'
import FakeRuntime from '../src/main/harness/runtime/fakeRuntime.js'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import { createBookReadTools } from '../src/main/harness/tools/bookReadTools.js'
import TurnCoordinator from '../src/main/harness/turn/turnCoordinator.js'

const root = await fs.mkdtemp(join(os.tmpdir(), '51mazi-tool-limits-'))
const snapshotService = { resolveBookPath: () => root }
const store = new HarnessStore({ snapshotService })
const registry = new DomainToolRegistry()
let listCount = 0
const readMaxChars = []
let proposalCount = 0

createBookReadTools({
  retrievalService: {
    listBookStructure: () => {
      listCount += 1
      return {
        chapters: [
          {
            targetId: 'vol/chapter.txt',
            title: '第一章',
            reference: 'chapter:vol%2Fchapter.txt@sha256:abc',
            rawHash: 'abc'
          }
        ]
      }
    },
    searchBookKnowledge: () => ({ results: [], truncated: false }),
    readBookSource: (_bookKey, reference, options) => {
      readMaxChars.push(options.maxChars)
      const sourceType = String(reference).split(':')[0]
      return {
        source: {
          sourceType,
          targetId: reference,
          reference,
          contentHash: 'abc',
          authorityStatus: 'authoritative_saved'
        },
        content: '正式内容',
        location: { startLine: 1, endLine: 1 }
      }
    }
  }
}).forEach((tool) => registry.register(tool))

let probeCount = 0
registry.register({
  name: 'probe_read',
  version: '2',
  risk: 'read',
  description: '测试无 Provider 轮次 ID 时的调用计数。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'integer', minimum: 1, maximum: 20 } },
    required: ['id']
  },
  execute(_context, args) {
    probeCount += 1
    return { data: { id: args.id } }
  }
})

registry.register({
  name: 'proposal_probe',
  version: '2',
  risk: 'proposal',
  description: '测试多份素材读取完成后仍可创建提案。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { summary: { type: 'string', minLength: 1, maxLength: 120 } },
    required: ['summary']
  },
  execute() {
    proposalCount += 1
    return { data: { status: 'pending' } }
  }
})

function coordinatorFor(runtime) {
  return new TurnCoordinator({
    store,
    toolRegistry: registry,
    contextAssembler: new ContextAssembler(),
    runtimes: new Map([['fake', runtime]])
  })
}

try {
  const dedupeRuntime = new FakeRuntime({
    script: [
      {
        type: 'tool.call',
        providerCallId: 'structure-1',
        name: 'list_book_structure',
        arguments: { scopes: ['outlines', 'characters', 'chapters'] }
      },
      {
        type: 'tool.call',
        providerCallId: 'structure-2',
        name: 'list_book_structure',
        arguments: { scopes: ['outlines', 'characters', 'chapters'] }
      },
      {
        type: 'tool.call',
        providerCallId: 'read-outline',
        name: 'read_book_source',
        arguments: {
          source: { type: 'reference', reference: 'outline:outline-root@sha256:abc' },
          maxChars: 30000
        }
      },
      ...[
        'character:character-1#document@sha256:abc',
        'character:character-2#document@sha256:abc',
        'chapter:vol%2Fchapter-1.txt@sha256:abc',
        'chapter:vol%2Fchapter-2.txt@sha256:abc'
      ].map((reference, index) => ({
        type: 'tool.call',
        providerCallId: `read-source-${index + 1}`,
        name: 'read_book_source',
        arguments: { source: { type: 'reference', reference }, maxChars: 30000 }
      })),
      {
        type: 'tool.call',
        providerCallId: 'proposal-after-reading',
        name: 'proposal_probe',
        arguments: { summary: '撰写第三章初稿' }
      },
      { type: 'message.completed', text: '已读取素材。' },
      { type: 'turn.completed', stopReason: 'completed' }
    ]
  })
  const dedupeConversation = await store.createConversation({
    bookKey: '测试书',
    title: '去重与参数收口',
    runtimeId: 'fake'
  })
  const dedupeResult = await coordinatorFor(dedupeRuntime).startTurn(
    dedupeConversation.conversationId,
    '读取资料',
    { bookKey: '测试书' }
  )
  assert.equal(dedupeResult.state, 'completed')
  assert.equal(listCount, 1, '相同工具和参数的不同 Provider call ID 应复用首次结果')
  assert.deepEqual(
    readMaxChars,
    [20000, 20000, 20000, 20000, 20000],
    '所有 read_book_source.maxChars 均应安全收口到 20000'
  )
  assert.equal(proposalCount, 1, '读取五份素材后仍应有额度创建第三章提案')
  assert.equal(
    JSON.stringify(registry.listDefinitions()).includes('normalizeArguments'),
    false,
    '内部参数规范化函数不应暴露给 Runtime'
  )
  const dedupeSaved = await store.loadConversation('测试书', dedupeConversation.conversationId)
  assert.equal(
    dedupeSaved.ledger.some((event) => event.validation === 'deduplicated'),
    true,
    '账本应记录结果复用'
  )
  assert.equal(
    dedupeSaved.ledger.some((event) => event.errorCode === 'TOOL_LIMIT_REACHED'),
    false,
    '完整第三章素材读取链路不应误触发轮次上限'
  )

  const callsWithoutRoundIds = Array.from({ length: 7 }, (_, index) => ({
    type: 'tool.call',
    providerCallId: `probe-${index + 1}`,
    name: 'probe_read',
    arguments: { id: index + 1 }
  }))
  const roundRuntime = new FakeRuntime({
    script: [
      ...callsWithoutRoundIds,
      { type: 'message.completed', text: '七次读取均已完成。' },
      { type: 'turn.completed', stopReason: 'completed' }
    ]
  })
  const roundConversation = await store.createConversation({
    bookKey: '测试书',
    title: '无轮次 ID',
    runtimeId: 'fake'
  })
  const roundResult = await coordinatorFor(roundRuntime).startTurn(
    roundConversation.conversationId,
    '执行七次不同读取',
    { bookKey: '测试书' }
  )
  assert.equal(roundResult.state, 'completed')
  assert.equal(probeCount, 7, '缺少 Provider 轮次 ID 时不应把每个调用误算为新轮次')
  const roundSaved = await store.loadConversation('测试书', roundConversation.conversationId)
  assert.equal(
    roundSaved.ledger.some((event) => event.errorCode === 'TOOL_LIMIT_REACHED'),
    false
  )

  probeCount = 0
  const callsPastTotalLimit = Array.from({ length: 13 }, (_, index) => ({
    type: 'tool.call',
    providerCallId: `total-limit-${index + 1}`,
    name: 'probe_read',
    arguments: { id: index + 1 }
  }))
  const totalLimitRuntime = new FakeRuntime({
    script: [
      ...callsPastTotalLimit,
      { type: 'message.completed', text: '总调用上限仍然生效。' },
      { type: 'turn.completed', stopReason: 'completed' }
    ]
  })
  const totalLimitConversation = await store.createConversation({
    bookKey: '测试书',
    title: '总调用上限',
    runtimeId: 'fake'
  })
  await coordinatorFor(totalLimitRuntime).startTurn(
    totalLimitConversation.conversationId,
    '执行十三次不同读取',
    { bookKey: '测试书' }
  )
  assert.equal(probeCount, 12, '取消误判轮次后仍必须保留每轮 12 次总调用上限')
  const totalLimitSaved = await store.loadConversation(
    '测试书',
    totalLimitConversation.conversationId
  )
  assert.equal(
    totalLimitSaved.ledger.some((event) => event.errorCode === 'TOOL_LIMIT_REACHED'),
    true
  )

  const invalidRuntime = new FakeRuntime({
    script: [
      {
        type: 'tool.call',
        providerCallId: 'invalid-search',
        name: 'search_book_knowledge',
        arguments: { query: '证据', scopes: ['chapters'], limit: 99 }
      },
      { type: 'message.completed', text: '参数错误已记录。' },
      { type: 'turn.completed', stopReason: 'completed' }
    ]
  })
  const invalidConversation = await store.createConversation({
    bookKey: '测试书',
    title: '参数诊断',
    runtimeId: 'fake'
  })
  await coordinatorFor(invalidRuntime).startTurn(
    invalidConversation.conversationId,
    '触发参数错误',
    { bookKey: '测试书' }
  )
  const invalidSaved = await store.loadConversation('测试书', invalidConversation.conversationId)
  const invalidLedger = invalidSaved.ledger.find(
    (event) => event.errorCode === 'TOOL_ARGUMENT_INVALID'
  )
  assert.match(invalidLedger?.errorMessage || '', /limit/)

  console.log('Harness tool limit regression checks passed')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
