import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import { createBookReadTools } from '../src/main/harness/tools/bookReadTools.js'
import ContextAssembler from '../src/main/harness/context/contextAssembler.js'
import TurnCoordinator from '../src/main/harness/turn/turnCoordinator.js'
import FakeRuntime from '../src/main/harness/runtime/fakeRuntime.js'

const root = await fs.mkdtemp(join(os.tmpdir(), '51mazi-harness-test-'))
let searchCount = 0
const retrievalService = {
  listBookStructure: () => ({ chapters: [{ targetId: 'vol/chapter.txt', title: '第一章', reference: 'chapter:vol%2Fchapter.txt@sha256:abc', rawHash: 'abc' }] }),
  searchBookKnowledge: () => { searchCount += 1; return { results: [{ sourceType: 'chapter', targetId: 'vol/chapter.txt', title: '第一章', snippet: '证据', reference: 'chapter:vol%2Fchapter.txt@sha256:abc', contentHash: 'abc' }] } },
  readBookSource: () => ({ source: { sourceType: 'chapter', targetId: 'vol/chapter.txt', reference: 'chapter:vol%2Fchapter.txt@sha256:abc', contentHash: 'abc', authorityStatus: 'authoritative_saved' }, content: '正式内容', location: { startLine: 1, endLine: 1 } })
}
const snapshotService = { resolveBookPath: () => root }
const store = new HarnessStore({ snapshotService })
const registry = new DomainToolRegistry()
createBookReadTools({ retrievalService }).forEach((tool) => registry.register(tool))
const runtime = new FakeRuntime({ script: [
  { type: 'tool.call', providerCallId: 'search-1', name: 'search_book_knowledge', arguments: { query: '证据', scopes: ['chapters'], limit: 1 } },
  { type: 'tool.call', providerCallId: 'search-1', name: 'search_book_knowledge', arguments: { query: '证据', scopes: ['chapters'], limit: 1 } },
  { type: 'tool.call', providerCallId: 'read-1', name: 'read_book_source', arguments: { source: { type: 'reference', reference: 'chapter:vol%2Fchapter.txt@sha256:abc' }, maxChars: 200 } },
  { type: 'message.completed', text: '根据正式资料，第一章包含正式内容。' },
  { type: 'turn.completed', stopReason: 'completed' }
] })
const conversation = await store.createConversation({ bookKey: '测试书', title: 'Harness 测试', runtimeId: 'fake' })
const coordinator = new TurnCoordinator({ store, toolRegistry: registry, contextAssembler: new ContextAssembler(), runtimes: new Map([['fake', runtime]]) })
const first = await coordinator.startTurn(conversation.conversationId, '请查找证据', { bookKey: '测试书' })
assert.equal(first.state, 'completed')
assert.equal(searchCount, 1, '重复 provider call id 不应重复执行工具')
const saved = await store.loadConversation('测试书', conversation.conversationId)
assert.equal(saved.transcript.some((event) => event.type === 'message.assistant'), true)
assert.equal(saved.ledger.filter((event) => event.state === 'completed').length, 2)
assert.equal(JSON.stringify(saved.ledger).includes('providerCallId'), false)
assert.equal(JSON.stringify(saved.ledger).includes('providerThreadId'), false)
assert.equal(JSON.stringify(saved.ledger).includes('providerTurnId'), false)
assert.equal(JSON.stringify(saved.runtime).includes('threadId'), false)
assert.equal(JSON.stringify(saved.runtime).includes('previous_response_id'), false)
console.log('Harness Fake Runtime smoke test passed')
