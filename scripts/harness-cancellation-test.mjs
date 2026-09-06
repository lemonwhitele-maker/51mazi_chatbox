import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import ContextAssembler from '../src/main/harness/context/contextAssembler.js'
import TurnCoordinator from '../src/main/harness/turn/turnCoordinator.js'

class NeverRuntime {
  async getCapabilities() { return { streaming: true, nativeToolCalling: true, isolatedTurn: true, cancellableTurn: true, instructionChannels: true, contextWindowTokens: 32000, maxOutputTokens: 4096 } }
  async *streamTurn() { await new Promise(() => {}); yield { type: 'turn.completed' } }
  async cancelTurn() {}
  async disposeTurn() {}
}

const root = await fs.mkdtemp(join(os.tmpdir(), '51mazi-cancel-'))
const store = new HarnessStore({ snapshotService: { resolveBookPath: () => root } })
const registry = new DomainToolRegistry()
registry.register({ name: 'slow_read', version: '2', risk: 'read', description: 'slow', inputSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] }, async execute() { return new Promise(() => {}) } })
try {
  const conversation = await store.createConversation({ bookKey: '取消书', runtimeId: 'fake' })
  const runtime = new NeverRuntime()
  const coordinator = new TurnCoordinator({ store, toolRegistry: registry, contextAssembler: new ContextAssembler(), runtimes: new Map([['fake', runtime]]), turnTimeoutMs: 80, toolTimeoutMs: 30 })
  const running = coordinator.startTurn(conversation.conversationId, '请等待', { bookKey: '取消书' })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await store.loadConversation('取消书', conversation.conversationId)
    if (current.state.activeTurnId) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(await coordinator.cancelTurn(conversation.conversationId), true)
  const result = await running
  assert.equal(result.state, 'cancelled')
  const data = await store.loadConversation('取消书', conversation.conversationId)
  assert.equal(data.transcript.filter((item) => item.type === 'turn.cancelled').length, 1)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
console.log('harness cancellation test passed')
