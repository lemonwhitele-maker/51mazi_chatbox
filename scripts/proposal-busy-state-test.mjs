import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { parse, compileScript } from '@vue/compiler-sfc'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'

const source = await fs.readFile(new URL('../src/renderer/src/components/Agent/BodyWriteProposalCard.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: 'proposal-busy-test', inlineTemplate: true })
const code = compiled.content
  .replace(/from (["'])vue\1/g, `from '${import.meta.resolve('vue')}'`)
  .replace("'./bodyWriteProposalUi.js'", JSON.stringify(new URL('../src/renderer/src/components/Agent/bodyWriteProposalUi.js', import.meta.url).href))
  .replace("'./editProposalPreview.js'", JSON.stringify(new URL('../src/renderer/src/components/Agent/editProposalPreview.js', import.meta.url).href))
const { default: Card } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const proposal = { status: 'applied', operation: 'write', target: {}, proposedText: 'test' }
for (const status of ['pending', 'applied']) {
  const html = await renderToString(createSSRApp(Card, { proposal: { ...proposal, status }, busy: false, turnRunning: true }))
  assert.ok(!html.includes('处理中'), '新一轮对话不得让历史提案显示处理中')
  assert.ok(html.includes('对话生成中'))
  assert.match(html, /class="primary"[^>]*disabled/, '对话生成时仍应禁用写入和撤销')
  assert.match(html, /<button type="button">复制<\/button>/, '对话生成中仍可复制')
}
const active = await renderToString(createSSRApp(Card, { proposal, busy: true, turnRunning: false }))
assert.ok(active.includes('处理中'))
const idle = await renderToString(createSSRApp(Card, { proposal, busy: false, turnRunning: false }))
assert.ok(idle.includes('已写入'))
assert.match(idle, /class="primary" type="button">撤销/)
const sidebar = await fs.readFile(new URL('../src/renderer/src/components/Agent/HarnessChatSidebar.vue', import.meta.url), 'utf8')
assert.ok(sidebar.includes(':busy="busyProposalIds.has(item.value.proposalId)"'))
assert.ok(sidebar.includes(':turn-running="turnRunning"'))
console.log('proposal busy state rendering checks passed')

const original = '不应默认展示的章节开头。\n'.repeat(100) + '最后一句。'
const edited = await renderToString(createSSRApp(Card, {
  proposal: { ...proposal, proposedText: undefined, operation: 'edit', preview: { before: original, after: original + '\n续写内容。', complete: true } }
}))
const compact = edited.split('<details')[0]
assert.ok(!compact.includes('不应默认展示的章节开头。\n'.repeat(5)))
assert.ok(compact.includes('〔插入位置〕'))
assert.ok(compact.includes('续写内容。'))
assert.ok(edited.includes('查看全文对照'))
assert.ok(!/<details[^>]*\bopen\b/.test(edited), '全文对照默认折叠')
assert.ok(edited.includes('复制完整建议文本'))
const escaped = await renderToString(createSSRApp(Card, {
  proposal: { ...proposal, proposedText: undefined, operation: 'edit', preview: { before: '原文', after: '<script>alert(1)</script>', complete: true } }
}))
assert.ok(!escaped.includes('<script>'))
assert.ok(escaped.includes('&lt;script&gt;'))
console.log('compact edit card rendering checks passed')
const selectionCard = await renderToString(createSSRApp(Card, { proposal: {
  ...proposal, proposedText: undefined, operation: 'edit', preview: {
    before: '全文前缀。选中句。全文后缀。', after: '全文前缀。选中句。续写。全文后缀。', complete: true,
    selection: { before: '选中句。', after: '选中句。续写。' }
  }
} }))
const selectionOnly = selectionCard.split('<details')[0]
assert.ok(selectionOnly.includes('选中原文'))
assert.ok(selectionOnly.includes('选中句。续写。'))
assert.ok(!selectionOnly.includes('全文前缀'))
assert.ok(!selectionOnly.includes('插入位置'))
console.log('whole selection replacement rendering checks passed')
