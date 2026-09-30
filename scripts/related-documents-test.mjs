import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import BookSandboxService from '../src/main/harness/sandbox/bookSandboxService.js'
import BookDocumentService from '../src/main/harness/documents/bookDocumentService.js'
import { matchRelatedDocuments } from '../src/main/harness/documents/relatedDocuments.js'

const structure = {
  characters: [
    { targetId: 'a', title: '沈青', aliases: ['阿青', '共同称呼', ''] },
    { targetId: 'b', title: '陆离', aliases: ['共同称呼'] }
  ],
  settings: [
    { targetId: 'a', title: '天机阁', aliases: ['天阁', 'A+B'] },
    { targetId: 'later', title: '后页设定', aliases: [] }
  ]
}
const matches = matchRelatedDocuments(structure, ['沈青、阿青、沈青、共同称呼、天阁、A+B'])
assert.equal(matches.length, 3)
assert.deepEqual(matches[0].matchedNames, ['沈青', '阿青', '共同称呼'])
assert.equal(matches[1].title, '陆离', 'ambiguous aliases retain both documents')
assert.notEqual(matches[0].path, matches[2].path, 'same IDs across types are distinct documents')
assert.equal(matchRelatedDocuments(structure, ['天机', '阁']).length, 0)

const temp = fs.mkdtempSync(path.join(os.tmpdir(), '51mazi-related-documents-'))
try {
  const book = path.join(temp, '测试书')
  fs.mkdirSync(path.join(book, '正文', '卷一'), { recursive: true })
  const first = '沈青、阿青、天阁。' + '甲'.repeat(600) + '后页设定'
  fs.writeFileSync(path.join(book, '正文', '卷一', '一.txt'), first)
  fs.writeFileSync(path.join(book, '正文', '卷一', '二.txt'), '阿青、天机阁、A+B')
  const sandbox = new BookSandboxService({ booksDirProvider: temp })
  const service = new BookDocumentService({
    sandboxService: sandbox,
    retrievalService: { listBookStructure(bookKey, scopes) {
      assert.equal(bookKey, '测试书')
      assert.deepEqual(scopes, ['characters', 'settings'])
      return structure
    } }
  })
  const context = { bookScope: sandbox.bindBook('测试书'), conversationId: 'c', turnId: 't' }
  const file = 'book/chapters/卷一/一.txt'
  const page = await service.read(context, { path: file, maxChars: 512 })
  assert.equal(page.data.text, first.slice(0, 512))
  assert.deepEqual(page.data.relatedDocuments.items.map((item) => item.title), ['沈青', '天机阁'])
  assert(page.references.every((ref) => ref.startsWith('chapter:')))
  const next = await service.read(context, { cursor: page.data.nextCursor })
  assert.deepEqual(next.data.relatedDocuments.items.map((item) => item.title), ['后页设定'])
  const batch = await service.read(context, { paths: [file, 'book/chapters/卷一/二.txt'], maxChars: 512 })
  assert.equal(batch.data.relatedDocuments.items.length, 2)
  assert.deepEqual(batch.data.relatedDocuments.items[1].matchedNames, ['天机阁', '天阁', 'A+B'])
  assert(batch.data.items.every((item) => !item.data.relatedDocuments))
  const help = await service.read(context, { path: 'help/index.md' })
  assert.equal(help.data.relatedDocuments, undefined)
  const pending = await service.read(context, { paths: ['book/chapters/卷一/不存在.txt', file] })
  assert.equal(pending.data.items[0].ok, false)
  assert.equal(pending.data.relatedDocuments.items.length, 3)

  fs.writeFileSync(path.join(book, '正文', '卷一', '长文.txt'), '沈青' + '甲'.repeat(6000))
  const smallBatchService = new BookDocumentService({
    sandboxService: sandbox,
    retrievalService: service.retrievalService,
    readBudget: { batchResultChars: 4000 }
  })
  const smallBatch = await smallBatchService.read(context, {
    paths: ['book/chapters/卷一/长文.txt', 'book/chapters/卷一/二.txt']
  })
  assert.deepEqual(smallBatch.data.pendingPaths, ['book/chapters/卷一/二.txt'])
  assert.deepEqual(smallBatch.data.relatedDocuments.items.map((item) => item.title), ['沈青'])

  for (let i = 0; i < 300; i++) structure.settings.push({ targetId: `many_${i}`, title: '甲' })
  const limited = await service.read(context, { path: file })
  assert.equal(limited.data.relatedDocuments.truncated, true)
  assert(limited.data.relatedDocuments.total > limited.data.relatedDocuments.items.length)
  assert(JSON.stringify(limited).length + 512 <= service.readBudget.maxResultChars)
  assert.equal(limited.data.text, first)
  console.log('PASS: related documents, aliases, ambiguity, pagination, batch deduplication, failed reads, evidence and budgets')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
