import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import DomainHarnessService from '../src/main/harness/domainHarnessService.js'
import FakeRuntime from '../src/main/harness/runtime/fakeRuntime.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), '51mazi-four-tool-turn-'))
await fs.mkdir(path.join(root, '测试书'))
await fs.mkdir(path.join(root, '测试书', 'knowledge', 'outlines'), { recursive: true })
const service = new DomainHarnessService({
  snapshotService: {
    getBooksDir: () => root,
    resolveBookPath: (name) => path.join(root, name)
  },
  retrievalService: { listBookStructure: () => ({}) },
  chapterWriteService: { sandboxService: null },
  getWindows: () => []
})
try {
  await service.ready
  const visible = []
  const fake = new FakeRuntime({ script: (input) => {
    visible.push(input.tools.map((tool) => tool.name).sort())
    return [
      { type: 'tool.call', providerCallId: 'same-read', name: 'read', arguments: { path: 'help/index.md' } },
      { type: 'tool.call', providerCallId: 'same-read', name: 'read', arguments: { path: 'help/index.md' } },
      { type: 'tool.call', providerCallId: 'unknown-tool', name: 'list_book_structure', arguments: {} },
      { type: 'tool.call', providerCallId: 'bad-create', name: 'create', arguments: {
        directory: 'book/knowledge/outlines/', content: '没有 YAML 头部的总纲'
      } },
      { type: 'message.completed', text: '已读取格式说明。' },
      { type: 'turn.completed', stopReason: 'completed' }
    ]
  } })
  fake.getBookSandboxAdmission = async () => ({
    admitted: true, contractVersion: 1, runtimeId: 'fake', protocolVersion: '2',
    modelExecutableTools: 'registered-functions-only', nativeTools: 'not-present-in-model-protocol',
    localFilesystemAccess: 'none'
  })
  fake.protocolVersion = '2'
  service.runtimes.set('fake', fake)
  const state = await service.createConversation({ bookName: '测试书', runtimeId: 'fake' })
  const scope = service.bookSandbox.bindBook('测试书')
  const result = await service.startTurn(
    { bookName: '测试书', conversationId: state.conversationId, text: '读取格式说明' },
    { scope, assertScope: () => service.bookSandbox.assertScope(scope) }
  )
  assert.equal(result.state, 'completed')
  assert.deepEqual(visible[0], ['create', 'edit', 'list_files', 'read', 'write'])
  const saved = await service.readConversation({ bookName: '测试书', conversationId: state.conversationId })
  assert.equal(saved.ledger.filter((item) => item.state === 'completed' && item.toolName === 'read').length, 1)
  assert.equal(saved.ledger.some((item) => item.toolName === 'list_book_structure' && item.errorCode === 'TOOL_NOT_ALLOWED'), true)
  assert.equal(JSON.stringify(saved.ledger).includes('providerCallId'), false)
  assert.equal(saved.runtime.toolsetId, 'book-primitives-v1')
  const diagnosticPath = path.join(
    root, '测试书', '.51mazi', 'harness', 'v1', 'conversations',
    state.conversationId, 'diagnostic-log.jsonl'
  )
  const diagnostic = (await fs.readFile(diagnosticPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert(diagnostic.some((entry) => entry.type === 'turn.input' && entry.payload.userText === '读取格式说明'))
  assert(diagnostic.some((entry) => entry.type === 'tool.call' && entry.payload.arguments.path === 'help/index.md'))
  assert(diagnostic.some((entry) => entry.type === 'tool.result' && entry.payload.result.ok === true))
  assert(diagnostic.some((entry) => entry.type === 'tool.result' && entry.payload.result.error?.code === 'TOOL_NOT_ALLOWED'))
  assert(diagnostic.some((entry) => entry.type === 'tool.call' && entry.payload.arguments.content === '没有 YAML 头部的总纲'))
  assert(diagnostic.some((entry) => entry.type === 'tool.result' && entry.payload.result.error?.code === 'EVIDENCE_BASIS_REQUIRED'))
  assert(diagnostic.some((entry) => entry.type === 'turn.ended' && entry.payload.state === 'completed'))
  const documentPath = path.join(root, '测试书', 'knowledge', 'outlines', 'reuse.md')
  await fs.writeFile(documentPath, '---\nid: reuse\ntype: outline\ntitle: 复用大纲\n---\n完整的旧计划原文')
  const inputs = []
  const reuseRuntime = new FakeRuntime({ script: (input) => {
    inputs.push(input)
    return [
      ...(inputs.length === 1 ? [{ type: 'tool.call', providerCallId: 'batch', name: 'read', arguments: { paths: ['book/knowledge/outlines/reuse.md'] } }] : []),
      { type: 'message.completed', text: '已处理' }, { type: 'turn.completed', stopReason: 'completed' }
    ]
  } })
  reuseRuntime.getBookSandboxAdmission = fake.getBookSandboxAdmission
  reuseRuntime.protocolVersion = '2'
  service.runtimes.set('fake', reuseRuntime)
  const run = () => service.startTurn({ bookName: '测试书', conversationId: state.conversationId, text: '继续处理大纲' }, { scope, assertScope: () => service.bookSandbox.assertScope(scope) })
  await run()
  await run()
  assert(inputs[1].contextText.includes('<verified_previous_reads>'))
  assert(inputs[1].contextText.includes('完整的旧计划原文'))
  await fs.writeFile(documentPath, '---\nid: reuse\ntype: outline\ntitle: 复用大纲\n---\n已变化的计划')
  await run()
  assert.equal(inputs[2].contextText.includes('<verified_previous_reads>'), false)
  const another = await service.createConversation({ bookName: '测试书', runtimeId: 'fake' })
  await service.startTurn({ bookName: '测试书', conversationId: another.conversationId, text: '读取大纲' }, { scope, assertScope: () => service.bookSandbox.assertScope(scope) })
  assert.equal(inputs[3].contextText.includes('<verified_previous_reads>'), false)
  console.log('Four-tool turn boundary test passed')
} finally {
  await service.dispose()
  await fs.rm(root, { recursive: true, force: true })
}
