import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import BookSandboxService from '../src/main/harness/sandbox/bookSandboxService.js'
import BookDocumentService from '../src/main/harness/documents/bookDocumentService.js'
import ReadSnapshotLedger from '../src/main/harness/documents/readSnapshotLedger.js'
import { createDocumentTools } from '../src/main/harness/tools/documentTools.js'
import { createWholeDocumentTask } from '../src/main/harness/documents/wholeDocumentTask.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import { TurnCoordinator } from '../src/main/harness/turn/turnCoordinator.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), '51mazi-whole-read-'))
try {
  const book = path.join(root, 'Novel')
  const notes = path.join(book, '.51mazi/notes/quick-notes.md')
  fs.mkdirSync(path.dirname(notes), { recursive: true })
  const original = '甲'.repeat(17390) + '结尾：主角终于回家了。'
  fs.writeFileSync(notes, original)
  const sandbox = new BookSandboxService({ booksDirProvider: root })
  const documents = new BookDocumentService({
    sandboxService: sandbox,
    retrievalService: {
      listBookStructure: () => ({}),
      searchBookKnowledge: () => ({ results: [] })
    }
  })
  const ledger = new ReadSnapshotLedger()
  let proposals = 0
  const registry = new DomainToolRegistry()
  createDocumentTools({
    documentService: documents,
    proposalService: {
      readSnapshotLedger: ledger,
      create: async () => {
        proposals++
        return { data: { accepted: true } }
      }
    }
  }).forEach((tool) => registry.register(tool))
  const context = {
    conversationId: 'c',
    turnId: 't',
    bookScope: sandbox.bindBook('Novel', { conversationId: 'c', turnId: 't' }),
    wholeDocumentTask: createWholeDocumentTask('基于速记给一份总纲提案')
  }
  const notePath = 'book/notes/quick-notes.md'
  const create = { directory: 'book/knowledge/outlines/', content: '提案', basis: 'creative' }
  const read = async (args) => {
    const result = await registry.execute('read', context, { path: notePath, ...args })
    assert.equal(result.ok, true, JSON.stringify(result))
    ledger.recordDelivery(context, result)
    return result
  }
  assert.equal(
    (await registry.execute('create', context, create)).error.code,
    'TASK_READ_INCOMPLETE'
  )
  const first = await read({})
  assert.equal(first.data.text.length, 8000)
  assert.equal(first.data.returnedCoverage.totalChars, original.length)
  assert.equal(first.data.pageReachedEnd, false)
  assert.match(first.data.readingNotice, /尚余/)
  assert(JSON.stringify(first).indexOf('readingNotice') < JSON.stringify(first).indexOf('"text"'))
  assert.equal(
    (await registry.execute('create', context, create)).error.code,
    'TASK_READ_INCOMPLETE'
  )
  assert.equal(proposals, 0, 'creative and omitted sources cannot bypass task coverage')
  const coordinator = Object.create(TurnCoordinator.prototype)
  coordinator.readSnapshotLedger = ledger
  coordinator.log = async () => {}
  const displayed = []
  coordinator.emit = (event) => displayed.push(event)
  const active = {
    wholeDocumentTask: context.wholeDocumentTask,
    bookScope: context.bookScope,
    conversation: { conversationId: 'c' },
    turnId: 't',
    references: [],
    finalText: ''
  }
  await coordinator.handleEvent(active, { type: 'message.completed', text: '总纲分析。' })
  assert.match(displayed.at(-1).message.text, /阅读范围未完成/)
  const second = await read({ cursor: first.data.nextCursor })
  const last = await read({ cursor: second.data.nextCursor })
  assert.equal(first.data.text + second.data.text + last.data.text, original)
  assert(last.data.text.includes('主角终于回家'))
  assert.equal(last.data.pageReachedEnd, true)
  assert.equal(last.data.returnedWholeDocument, false)
  assert.equal((await registry.execute('create', context, create)).ok, true)
  await coordinator.handleEvent(active, { type: 'message.completed', text: '完整分析。' })
  assert.equal(displayed.at(-1).message.text, '完整分析。')
  fs.appendFileSync(notes, '新增后记')
  assert.equal(
    (await registry.execute('create', context, create)).error.code,
    'TASK_READ_INCOMPLETE'
  )
  await coordinator.handleEvent(active, { type: 'message.completed', text: '分析。' })
  assert.match(displayed.at(-1).message.text, /阅读范围未完成/)
  const stale = await registry.execute('read', context, {
    path: notePath,
    cursor: first.data.nextCursor
  })
  assert.equal(stale.error.code, 'READ_VERSION_CHANGED')

  context.fullReadBudgetBytes = 100000
  const full = await read({})
  assert.equal(full.data.returnedWholeDocument, true)
  assert.equal(full.data.text, original + '新增后记')
  assert.equal(full.data.nextCursor, null)
  const explicit = await read({ maxChars: 512 })
  assert.equal(explicit.data.text.length, 512, 'Explicit paging must be honored')
  context.fullReadBudgetBytes = 100
  assert.equal((await read({})).data.text.length, 8000, 'Low expansion budget retains paging')

  context.wholeDocumentTask = createWholeDocumentTask('只看速记开头给一个局部提案')
  assert.equal(context.wholeDocumentTask, null)
  assert.equal((await registry.execute('create', context, create)).ok, true)
  assert(createWholeDocumentTask('再次尝试', '基于速记划分章节').paths.has(notePath))
  assert.equal(createWholeDocumentTask('解释一下分页机制'), null)
  console.log('Whole-document coverage, tail delivery, version changes and budgeted reads passed.')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
