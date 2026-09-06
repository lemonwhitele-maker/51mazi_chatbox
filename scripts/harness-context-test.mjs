import assert from 'node:assert/strict'
import ContextAssembler from '../src/main/harness/context/contextAssembler.js'
import { baseInstructions } from '../src/main/harness/prompts/baseInstructions.js'
import { developerInstructions } from '../src/main/harness/prompts/developerInstructions.js'
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
assert.equal(result.instructions.base.contentHash, baseInstructions.contentHash)
assert.equal(result.instructions.developer.contentHash, developerInstructions.contentHash)
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
assert.throws(() => assembler.assemble({ conversation: { bookKey: '测试书' }, userText: 'x'.repeat(20000) }), (error) => error.code === 'USER_INPUT_TOO_LARGE')
console.log('harness context test passed')
