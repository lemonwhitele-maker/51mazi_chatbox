import assert from 'node:assert/strict'
import { MemoryCompactor, validateMemoryV2 } from '../src/main/harness/context/memoryCompactor.js'

const compactor = new MemoryCompactor({ maxInputTokens: 100 })
const transcript = Array.from({ length: 22 }, (_, index) => ({ type: index % 2 ? 'message.assistant' : 'message.user', turnId: `turn-${index}`, messageId: `message-${index}`, payload: { text: index % 2 ? `建议 ${index}` : `用户确认决定 ${index}` } }))
const first = compactor.compact({ conversationId: 'conv-1', transcript, previous: {} })
assert.equal(validateMemoryV2(first).ok, true)
assert.ok(first.coveredThroughMessageId)
assert.ok(Array.isArray(first.modelSuggestions))
assert.ok(Array.isArray(first.sourceReferences))
const second = compactor.compact({ conversationId: 'conv-1', transcript, previous: first })
assert.equal(second.coveredThroughMessageId, first.coveredThroughMessageId)
assert.equal(second.summaryVersion, first.summaryVersion)
assert.throws(() => validateMemoryV2({ schemaVersion: 1 }).ok || (() => { throw new Error('bad') })(), /bad/)
console.log('harness memory compaction test passed')
