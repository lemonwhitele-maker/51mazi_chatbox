import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  bodyWriteProposalActions,
  mergeHarnessTimeline
} from '../src/renderer/src/components/Agent/bodyWriteProposalUi.js'
import {
  copyMessagePlainText,
  normalizeMessageClipboardText,
  setPlainTextClipboardEvent
} from '../src/renderer/src/components/Agent/messageClipboard.js'

const timeline = mergeHarnessTimeline(
  [
    { id: 'user-1', createdAt: '2026-08-09T10:00:00.000Z' },
    { id: 'assistant-1', createdAt: '2026-08-09T10:00:02.000Z' }
  ],
  [{ proposalId: 'proposal-1', createdAt: '2026-08-09T10:00:01.000Z' }]
)
assert.deepEqual(
  timeline.map((item) => item.key),
  ['message:user-1', 'proposal:proposal-1', 'message:assistant-1']
)
assert.deepEqual(bodyWriteProposalActions({ status: 'pending', proposedText: '文本' }), {
  canConfirm: true,
  canReject: true,
  canCopy: true,
  canUndo: false
})
assert.equal(bodyWriteProposalActions({ status: 'applied', proposedText: '文本' }).canUndo, true)
assert.equal(bodyWriteProposalActions({ status: 'stale', proposedText: '文本' }).canConfirm, false)
assert.equal(
  bodyWriteProposalActions({
    status: 'failed',
    proposedText: '文本',
    failure: { retryable: true }
  }).canConfirm,
  true
)

assert.equal(normalizeMessageClipboardText('第一段\r\n\r\n第二段'), '第一段\n\n第二段')
const clipboardWrites = []
assert.equal(
  await copyMessagePlainText('第一段\r\n第二段', {
    async writeText(value) {
      clipboardWrites.push(value)
    }
  }),
  '第一段\n第二段'
)
assert.deepEqual(clipboardWrites, ['第一段\n第二段'])
const copyEventData = new Map()
let copyPrevented = false
assert.equal(
  setPlainTextClipboardEvent(
    {
      preventDefault() {
        copyPrevented = true
      },
      clipboardData: {
        setData(type, value) {
          copyEventData.set(type, value)
        }
      }
    },
    '选中第一段\r\n\r\n选中第二段'
  ),
  true
)
assert.equal(copyPrevented, true)
assert.equal(copyEventData.get('text/plain'), '选中第一段\n\n选中第二段')

const root = process.cwd()
const sidebar = await fs.readFile(
  join(root, 'src/renderer/src/components/Agent/HarnessChatSidebar.vue'),
  'utf8'
)
const card = await fs.readFile(
  join(root, 'src/renderer/src/components/Agent/BodyWriteProposalCard.vue'),
  'utf8'
)
const preview = await fs.readFile(
  join(root, 'src/renderer/src/extensions/AgentDiffPreview.js'),
  'utf8'
)
const selectionHighlight = await fs.readFile(
  join(root, 'src/renderer/src/extensions/AgentSelectionHighlight.js'),
  'utf8'
)
const chapterEditor = await fs.readFile(
  join(root, 'src/renderer/src/components/Editor/ChapterEditorContent.vue'),
  'utf8'
)
for (const token of [
  'listWriteProposals',
  'write.proposal.created',
  'write.proposal.updated',
  'busyProposalIds',
  'proposal-content-applied'
])
  assert.ok(sidebar.includes(token), `侧栏缺少 ${token}`)
for (const token of [
  'copyMessagePlainText',
  'setPlainTextClipboardEvent',
  '复制纯文本并保留换行'
]) {
  assert.ok(sidebar.includes(token), `普通消息复制缺少 ${token}`)
}
for (const token of ['确认写入', '取消', '复制', '撤销', '应用前不会改变正文']) {
  assert.ok(card.includes(token), `提案卡片缺少 ${token}`)
}
for (const operation of [
  'replace_selection',
  'insert_before_selection',
  'insert_after_selection',
  'append_to_chapter'
])
  assert.ok(preview.includes(operation), `编辑器预览缺少 ${operation}`)
assert.ok(selectionHighlight.includes('agent-selection-highlight'), '缺少失焦后选区 Decoration')
assert.ok(chapterEditor.includes('AgentSelectionHighlight'), '章节编辑器未注册选区高亮扩展')

console.log('harness body-write UI checks passed')
