import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import ContextAssembler from '../src/main/harness/context/contextAssembler.js'
import FakeRuntime from '../src/main/harness/runtime/fakeRuntime.js'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import TurnCoordinator from '../src/main/harness/turn/turnCoordinator.js'

const root = await fs.mkdtemp(join(os.tmpdir(), '51mazi-tool-protocol-v2-'))
const store = new HarnessStore({ snapshotService: { resolveBookPath: () => root } })
const registry = new DomainToolRegistry()
registry.register({
  name: 'protocol_probe', version: '2', risk: 'read', description: 'protocol probe',
  inputSchema: { type: 'object', additionalProperties: false, properties: { value: { type: 'string' } }, required: ['value'] },
  execute: async (_context, args) => ({ data: args })
})

const invalidRuntime = new FakeRuntime({ script: [
  { type: 'tool.call', providerCallId: 'invalid-json', roundId: 1, name: 'protocol_probe', argumentsJson: '{"value":', argumentsParseError: 'Unexpected end of JSON input' },
  { type: 'message.completed', text: '参数无效，已结束。' },
  { type: 'turn.completed', stopReason: 'completed' }
] })
const conversation = await store.createConversation({ bookKey: '协议书', runtimeId: 'fake' })
const coordinator = new TurnCoordinator({ store, toolRegistry: registry, contextAssembler: new ContextAssembler(), runtimes: new Map([['fake', invalidRuntime]]) })
const invalidResult = await coordinator.startTurn(conversation.conversationId, '测试非法 JSON', { bookKey: '协议书' })
assert.equal(invalidResult.state, 'completed')
const saved = await store.loadConversation('协议书', conversation.conversationId)
assert.equal(saved.ledger.some((event) => event.errorCode === 'TOOL_ARGUMENT_JSON_INVALID'), true)
assert.equal(saved.runtime.schemaVersion, 2)
assert.equal(saved.runtime.contractVersion, '2')
assert.match(saved.runtime.toolsetHash, /^sha256:[a-f0-9]{64}$/)
assert.equal(saved.ledger.every((event) => event.schemaVersion === 2 && event.runtimeSnapshotDigest), true)

class RejectingAckRuntime extends FakeRuntime {
  async submitToolResult() { return { status: 'turn_closed' } }
}
const rejectRuntime = new RejectingAckRuntime({ script: [
  { type: 'tool.call', providerCallId: 'closed-call', roundId: 1, name: 'protocol_probe', arguments: { value: 'x' } },
  { type: 'turn.completed', stopReason: 'completed' }
] })
const rejectedConversation = await store.createConversation({ bookKey: '协议书', runtimeId: 'fake' })
const rejectedCoordinator = new TurnCoordinator({ store, toolRegistry: registry, contextAssembler: new ContextAssembler(), runtimes: new Map([['fake', rejectRuntime]]) })
const rejected = await rejectedCoordinator.startTurn(rejectedConversation.conversationId, '测试 ack', { bookKey: '协议书' })
assert.equal(rejected.state, 'failed')
const rejectedSaved = await store.loadConversation('协议书', rejectedConversation.conversationId)
assert.equal(rejectedSaved.transcript.some((event) => event.type === 'turn.failed' && event.payload.code === 'TOOL_RESULT_DELIVERY_FAILED'), true)

console.log('Tool protocol v2 JSON/ack/runtime audit checks passed.')
