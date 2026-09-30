import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import DomainHarnessService from '../src/main/harness/domainHarnessService.js'
import FakeRuntime from '../src/main/harness/runtime/fakeRuntime.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), '51mazi-mode-migration-'))
const book = path.join(root, '甲书')
await fs.mkdir(book)
await fs.mkdir(path.join(root, '乙书'))
const snapshotService = {
  getBooksDir: () => root,
  resolveBookPath: (name) => {
    if (!['甲书', '乙书'].includes(name)) throw new Error('unknown book')
    return path.join(root, name)
  }
}
const service = new DomainHarnessService({
  snapshotService,
  retrievalService: { listBookStructure: () => ({}) },
  chapterWriteService: { sandboxService: null },
  getWindows: () => []
})

try {
  await service.ready
  assert.deepEqual(service.documentTools.listDefinitions().map((tool) => tool.name).sort(), ['create', 'edit', 'list_files', 'read', 'write'])

  const fresh = await service.createConversation({ bookName: '甲书', runtimeId: 'fake' })
  assert.equal(fresh.toolMode, 'book-primitives-v1')
  await assert.rejects(
    service.createConversation({ bookName: '甲书', runtimeId: 'fake', toolMode: 'legacy-readonly' }),
    (error) => error.code === 'TOOL_MODE_INVALID'
  )
  const old = await service.createConversation({ bookName: '甲书', runtimeId: 'fake' })
  delete old.toolMode
  await service.store.writeJson(path.join(service.store.getConversationDir('甲书', old.conversationId), 'state.json'), old)
  assert.equal((await service.readConversation({ bookName: '甲书', conversationId: old.conversationId })).state.toolMode, 'book-primitives-v1')

  await service.store.writeWriteProposals('甲书', old.conversationId, [{
    proposalId: 'old-pending', bookKey: '甲书', conversationId: old.conversationId,
    status: 'pending', target: { volumeName: '第一卷', chapterName: '第一章' },
    summary: '旧提案', createdAt: new Date().toISOString()
  }])
  const scope = service.bookSandbox.bindBook('甲书', { senderId: 1, frameId: 1 })
  const otherScope = service.bookSandbox.bindBook('乙书', { senderId: 2, frameId: 1 })
  await assert.rejects(
    service.startTurn(
      { bookName: '甲书', conversationId: fresh.conversationId, text: '越界' },
      { scope: otherScope, assertScope: () => service.bookSandbox.assertScope(otherScope) }
    ),
    (error) => error.code === 'BOOK_SCOPE_MISMATCH'
  )
  await assert.rejects(
    service.listWriteProposals({ bookName: '甲书', conversationId: old.conversationId }),
    (error) => error.code === 'BOOK_SCOPE_MISMATCH'
  )
  const proposals = await service.listWriteProposals(
    { bookName: '甲书', conversationId: old.conversationId }, { scope }
  )
  assert.equal(proposals[0].requiresRegeneration, true)
  assert.equal(proposals[0].confirmationAllowed, false)
  await assert.rejects(
    service.applyWriteProposal({ bookName: '甲书', conversationId: old.conversationId, proposalId: 'old-pending' }),
    /重新生成/
  )
  assert.equal((await service.store.readWriteProposals('甲书', old.conversationId))[0].status, 'pending')

  await assert.rejects(
    service.startTurn({ bookName: '甲书', conversationId: fresh.conversationId, text: '你好' }),
    (error) => error.code === 'BOOK_SCOPE_MISMATCH'
  )
  const visibleTools = []
  const admittedFake = new FakeRuntime({ script: (input) => {
    visibleTools.push(input.tools.map((tool) => tool.name).sort())
    return [{ type: 'turn.completed', stopReason: 'completed' }]
  } })
  admittedFake.getBookSandboxAdmission = async () => ({
    admitted: true, contractVersion: 1, runtimeId: 'fake', protocolVersion: '2',
    modelExecutableTools: 'registered-functions-only', nativeTools: 'not-present-in-model-protocol',
    localFilesystemAccess: 'none'
  })
  admittedFake.protocolVersion = '2'
  service.runtimes.set('fake', admittedFake)
  await service.startTurn(
    { bookName: '甲书', conversationId: fresh.conversationId, text: '你好' },
    { scope, assertScope: () => service.bookSandbox.assertScope(scope) }
  )
  const runtime = (await service.readConversation({ bookName: '甲书', conversationId: fresh.conversationId })).runtime
  assert.equal(runtime.toolsetId, 'book-primitives-v1')
  assert.equal(admittedFake.calls.length, 1)
  assert.deepEqual(visibleTools[0], ['create', 'edit', 'list_files', 'read', 'write'])
  assert.match(admittedFake.calls[0].instructions.baseInstructions, /read、create、write、edit/)
  await service.startTurn(
    { bookName: '甲书', conversationId: old.conversationId, text: '查找历史' },
    { scope, assertScope: () => service.bookSandbox.assertScope(scope) }
  )
  assert.deepEqual(visibleTools[1], ['create', 'edit', 'list_files', 'read', 'write'])
  assert.match(admittedFake.calls[1].instructions.baseInstructions, /read、create、write、edit/)
  await assert.rejects(
    service.updateConversationSettings({
      bookName: '甲书', conversationId: old.conversationId,
      model: null, effort: null, toolMode: 'legacy-readonly'
    }),
    /不支持的工具模式/
  )
  await service.updateConversationSettings({
    bookName: '甲书', conversationId: old.conversationId,
    model: null, effort: null, toolMode: 'book-primitives-v1'
  })
  assert.equal((await service.readConversation({ bookName: '甲书', conversationId: old.conversationId })).state.toolMode, 'book-primitives-v1')
  await service.startTurn(
    { bookName: '甲书', conversationId: old.conversationId, text: '继续' },
    { scope, assertScope: () => service.bookSandbox.assertScope(scope) }
  )
  assert.deepEqual(visibleTools[2], ['create', 'edit', 'list_files', 'read', 'write'])
} finally {
  await service.dispose()
  await fs.rm(root, { recursive: true, force: true })
}
console.log('Harness mode migration test passed')
