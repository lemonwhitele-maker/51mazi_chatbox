import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import HarnessStore from '../src/main/harness/store/harnessStore.js'

const tempRoot = await fs.mkdtemp(join(os.tmpdir(), '51mazi-recovery-'))
const store = new HarnessStore({ snapshotService: { resolveBookPath: () => tempRoot } })
try {
  const created = await store.createConversation({ bookKey: '恢复书', runtimeId: 'fake' })
  const data = await store.loadConversation('恢复书', created.conversationId)
  data.state.status = 'running'
  data.state.activeTurnId = 'turn-crashed'
  await store.updateState(data.state)
  const before = await store.loadConversation('恢复书', created.conversationId)
  assert.equal(before.state.activeTurnId, 'turn-crashed')
  const first = await store.recoverInterruptedTurns('恢复书')
  const second = await store.recoverInterruptedTurns('恢复书')
  assert.equal(first.length, 1)
  assert.equal(second.length, 0)
  const after = await store.loadConversation('恢复书', created.conversationId)
  assert.equal(after.state.status, 'idle')
  assert.equal(after.transcript.filter((item) => item.type === 'turn.interrupted').length, 1)

  const concurrent = await store.createConversation({ bookKey: '恢复书', runtimeId: 'fake' })
  concurrent.status = 'running'
  concurrent.activeTurnId = 'turn-concurrent'
  await store.updateState(concurrent)
  const staleSnapshots = Array.from({ length: 40 }, () => ({
    ...concurrent,
    status: 'idle',
    activeTurnId: null
  }))
  await Promise.all(
    staleSnapshots.map((snapshot, index) =>
      store.appendTranscript(snapshot, 'diagnostic.test', 'turn-concurrent', null, { index })
    )
  )
  const concurrentAfter = await store.loadConversation('恢复书', concurrent.conversationId)
  const diagnosticEvents = concurrentAfter.transcript.filter((item) => item.type === 'diagnostic.test')
  assert.equal(diagnosticEvents.length, 40)
  assert.equal(new Set(diagnosticEvents.map((item) => item.seq)).size, 40)
  assert.deepEqual(
    diagnosticEvents.map((item) => item.seq),
    Array.from({ length: 40 }, (_, index) => index + 1)
  )
  assert.equal(concurrentAfter.state.nextEventSeq, 41)
  assert.equal(concurrentAfter.state.status, 'running')
  assert.equal(concurrentAfter.state.activeTurnId, 'turn-concurrent')

  const currentState = structuredClone(concurrentAfter.state)
  const staleState = structuredClone(concurrentAfter.state)
  currentState.title = '新状态标题'
  await store.updateState(currentState)
  staleState.status = 'idle'
  staleState.activeTurnId = null
  await assert.rejects(
    store.updateState(staleState),
    (error) => error?.code === 'CONVERSATION_STATE_VERSION_CONFLICT'
  )
  const afterStaleUpdate = await store.loadConversation('恢复书', concurrent.conversationId)
  assert.equal(afterStaleUpdate.state.title, '新状态标题')
  assert.equal(afterStaleUpdate.state.status, 'running')
  assert.equal(afterStaleUpdate.state.activeTurnId, 'turn-concurrent')
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true })
}
console.log('harness store recovery test passed')
