import assert from 'node:assert/strict'
import ContextAssembler from '../src/main/harness/context/contextAssembler.js'
import { safeWorkspace } from '../src/main/harness/context/workspaceContext.js'

const assembler = new ContextAssembler({ maxInputTokens: 2400, memoryTokens: 400, recentConversationTokens: 500, workspaceTokens: 300, selectionMaxChars: 500 })
const transcript = Array.from({ length: 8 }, (_, index) => [
  { type: 'message.user', turnId: `turn-${index}`, messageId: `user-${index}`, payload: { text: `用户消息 ${index} ${'长文本 '.repeat(200)}` } },
  { type: 'message.assistant', turnId: `turn-${index}`, messageId: `assistant-${index}`, payload: { text: `助手消息 ${index} ${'长文本 '.repeat(200)}` } }
]).flat()
const result = assembler.assemble({
  conversation: { bookKey: '测试书' },
  transcript,
  memory: { schemaVersion: 2, objective: '目标', confirmedDecisions: [{ text: '决定' }], sourceReferences: [{ reference: 'chapter:x' }] },
  workspace: { currentModule: 'editor', currentDocumentId: 'chapter-1', selectionText: '选区'.repeat(1000), hasUnsavedChanges: true },
  userText: '请回答当前问题'
})
assert.ok(result.estimatedInputTokens <= result.budget.maxInputTokens)
assert.equal(result.inputText.includes('<product_rules>'), false)
assert.match(result.instructions.base.text, /read、create、write、edit/)
assert.match(result.instructions.base.text, /list_files/)
assert.match(result.instructions.base.text, /内置帮助使用 help\/\.\.\.，不可加 book\//)
assert.match(result.instructions.developer.text, /read\/create\/write\/edit/)
assert.equal(result.layers.selectionTruncated, true)
assert.equal(result.inputText.includes('当前模块=unknown'), false)
const rangedWorkspace = safeWorkspace({
  currentModule: 'editor',
  selectionRange: { from: 4, to: 9 },
  editorRange: { from: 4, to: 9 },
  textRange: { start: 2, end: 7 }
})
assert.deepEqual(rangedWorkspace.editorRange, { from: 4, to: 9 })
assert.deepEqual(rangedWorkspace.textRange, { start: 2, end: 7 })
assert.equal(safeWorkspace({ editorRange: { from: 'bad', to: 2 } }).editorRange, null)
const pathAssembler = new ContextAssembler()
const outlineWorkspace = safeWorkspace({
  currentModule: 'outlines-knowledge-v2',
  currentDocumentId: 'outline_1789652860373_a3cd63dc',
  metadata: {
    knowledge_scope: 'outlines',
    knowledge_document_id: 'outline_1789652860373_a3cd63dc',
    source_file: 'knowledge/outlines/outline_1789652860373_a3cd63dc.md'
  }
})
const outlineContext = pathAssembler.assemble({ workspace: outlineWorkspace, userText: '修改当前总纲' })
assert.match(outlineContext.layers.currentWorkspace, /^toolPath=book\/knowledge\/outlines\/outline_1789652860373_a3cd63dc.md/m)
assert.equal(outlineContext.layers.currentWorkspace.includes('source_file'), false)
assert.equal(outlineWorkspace.metadata.source_file, 'knowledge/outlines/outline_1789652860373_a3cd63dc.md')
for (const [workspace, expected] of [
  [{ currentModule: 'editor', metadata: { volume_name: '第一卷', chapter_name: '开端', file_type: 'chapter' } }, 'book/chapters/第一卷/开端.txt'],
  [{ currentModule: 'quick-notes', metadata: { source_file: '.51mazi/notes/quick-notes.md' } }, 'book/notes/quick-notes.md']
]) {
  const assembled = pathAssembler.assemble({ workspace, userText: '读取当前文档' })
  assert(assembled.layers.currentWorkspace.startsWith(`toolPath=${expected}\n`))
  assert.equal(assembled.layers.currentWorkspace.includes('source_file'), false)
}
for (const workspace of [
  { toolPath: 'book/knowledge/outlines/forged.md', metadata: { source_file: 'D:/other-book/secret.md' } },
  { metadata: { knowledge_scope: 'outlines', knowledge_document_id: '..' } }
]) {
  const assembled = pathAssembler.assemble({ workspace, userText: '读取当前文档' })
  assert(assembled.layers.currentWorkspace.startsWith('toolPath=未提供；请 list_files 查找目标\n'))
  assert.equal(assembled.layers.currentWorkspace.includes('D:/other-book'), false)
}
assert.throws(() => assembler.assemble({ conversation: { bookKey: '测试书' }, userText: 'x'.repeat(20000) }), (error) => error.code === 'USER_INPUT_TOO_LARGE')
console.log('harness context test passed')
