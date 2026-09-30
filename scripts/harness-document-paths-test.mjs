import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import BookSandboxService from '../src/main/harness/sandbox/bookSandboxService.js'
import BookDocumentService from '../src/main/harness/documents/bookDocumentService.js'
import ReadSnapshotLedger from '../src/main/harness/documents/readSnapshotLedger.js'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import DocumentWriteProposalService from '../src/main/harness/write/documentWriteProposalService.js'
import { parseKnowledgeMarkdown } from '../src/main/services/knowledgeMarkdownParser.js'
import { makeSourceReference } from '../src/main/services/bookSavedSnapshotService.js'
import { normalizeVirtualPath } from '../src/main/harness/documents/virtualDocumentPaths.js'
import EditorDirtyStateRegistry from '../src/main/harness/documents/editorDirtyStateRegistry.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), '51mazi-paths-'))
try {
  const book = path.join(temp, 'A')
  for (const directory of ['knowledge/characters', 'knowledge/outlines', '正文/第一卷Volume', '.51mazi/notes'])
    fs.mkdirSync(path.join(book, directory), { recursive: true })
  fs.mkdirSync(path.join(temp, 'B'))
  const sourcePath = 'book/knowledge/characters/char_source.md'
  const outlinePath = 'book/knowledge/outlines/outline_main.md'
  const chapterPath = 'book/chapters/第一卷Volume/Start.TXT'
  const character = (id) => `---\nid: ${id}\ntype: character\ntitle: 林舟\nstatus: confirmed\naliases: []\ntags: []\n---\n\n### 核心定位 <!-- 51:section=summary -->\n渡船人。\n\n### 当前状态 <!-- 51:section=current-state -->\n等待。\n\n### 已确认事实 <!-- 51:section=facts -->\n${'潮'.repeat(900)}\n`
  const outline = '---\r\nid: outline_main\r\ntype: outline\r\ntitle: 总纲\r\nstatus: planned\r\ntags: []\r\norder: null\r\nrelatedOutlines: []\r\nchapterRefs: [] # preserve comment\r\ncharacterRefs: []\r\nsettingRefs: []\r\ncustom: "keep exact"\r\n---\r\n\r\n### 核心内容 <!-- 51:section=summary -->\r\n原内容。\r\n\r\n### 展开说明 <!-- 51:section=details -->\r\n说明。\r\n\r\n### 约束与结果 <!-- 51:section=constraints -->\r\n约束。\r\n'
  fs.writeFileSync(path.join(book, 'knowledge/characters/char_source.md'), character('char_source'))
  fs.writeFileSync(path.join(book, 'knowledge/characters/char_Mixed.MD'), character('char_Mixed'))
  fs.writeFileSync(path.join(book, 'knowledge/outlines/outline_main.md'), outline)
  fs.writeFileSync(path.join(book, '正文/第一卷Volume/Start.TXT'), '第一句。')
  fs.writeFileSync(path.join(book, '.51mazi/notes/quick-notes.md'), '# 速记\n待补充')
  const sandbox = new BookSandboxService({ booksDirProvider: temp })
  const documents = new BookDocumentService({ sandboxService: sandbox, retrievalService: {
    listBookStructure: () => ({ characters: ['char_source.md', 'char_Mixed.MD'].map((name) => ({ path: `knowledge/characters/${name}`, targetId: name.replace(/\.md$/i, '') })) }),
    searchBookKnowledge: () => ({ results: [] })
  } })
  const ledger = new ReadSnapshotLedger()
  const store = new HarnessStore({ sandboxService: sandbox, snapshotService: { resolveBookPath: (name) => path.join(temp, name) } })
  const state = await store.createConversation({ bookKey: 'A', title: 'paths' })
  const scope = sandbox.bindBook('A', { conversationId: state.conversationId })
  const context = { bookScope: scope, conversationId: state.conversationId, turnId: 't1' }
  const dirty = new EditorDirtyStateRegistry({ canonicalizePath: (scope, value) => documents.canonicalPath(scope, value) })
  const proposals = new DocumentWriteProposalService({ store, documentService: documents, readSnapshotLedger: ledger,
    isDocumentDirty: (target) => dirty.isDirty(target) })
  const read = async (value, args = {}) => {
    const result = await documents.read(context, { path: value, ...args })
    ledger.recordDelivery(context, { ok: true, ...result }, { deliverySequence: 1 })
    return result
  }
  const frozen = async (proposal) => (await proposals.readFrozenCandidate(context, proposal.data.proposalId)).bytes.toString('utf8')

  for (const directory of ['book', 'book/knowledge', 'book/knowledge/characters', 'book/chapters', 'book/chapters/第一卷Volume', 'book/notes', 'help', 'view']) {
    const first = await read(directory)
    const second = await read(`${directory}/`)
    assert.equal(first.data.path, `${directory}/`)
    assert.deepEqual(first.data.items, second.data.items)
  }
  const helpPage = await read('HELP', { maxChars: 512 })
  assert(helpPage.data.nextCursor)
  assert.equal((await read('help/', { maxChars: 512, cursor: helpPage.data.nextCursor })).data.path, 'help/')
  assert.equal((await read('BOOK/KNOWLEDGE/CHARACTERS/CHAR_MIXED.md')).data.path, 'book/knowledge/characters/char_Mixed.MD')
  assert.equal(documents.describeWritablePath(context, 'BOOK/KNOWLEDGE/CHARACTERS/CHAR_MIXED.md').documentId, 'char_Mixed')
  assert.equal((await read('BOOK/CHAPTERS/第一卷volume/start.txt')).data.path, chapterPath)
  assert.equal((await read('book/chapters/第一卷volume')).data.items[0].path, chapterPath)
  dirty.update({ senderId: 1, bookIdentity: scope.bookIdentity, bookKey: 'A', bookScope: scope,
    workspace: { hasUnsavedChanges: true, metadata: { knowledge_scope: 'characters', knowledge_document_id: 'char_Mixed' } } })
  const mixedEdit = await proposals.edit(context, {
    path: 'book/knowledge/characters/CHAR_MIXED.md', edits: [{ oldText: '渡船人。', newText: '谨慎的渡船人。' }], basis: 'creative'
  })
  const mixedRecord = (await proposals.readFrozenCandidate(context, mixedEdit.data.proposalId)).record
  await assert.rejects(proposals.apply(context, {
    proposalId: mixedRecord.proposalId, revision: mixedRecord.revision, candidateHash: mixedRecord.candidateHash
  }), { code: 'EDITOR_DIRTY' })
  dirty.revokeSender(1)
  for (const value of ['../B/secret', 'book/chapters/../B', 'book//notes', 'D:/secret', 'book\\notes', '/book/notes'])
    assert.throws(() => normalizeVirtualPath(value), { code: 'PATH_OUTSIDE_BOOK' })
  for (const value of ['book/chapters/第一卷Volume/nested/file.txt', 'book/knowledge/characters/nested/file.md']) {
    await assert.rejects(read(value), { code: 'DOCUMENT_NOT_FOUND' })
    assert.throws(() => documents.describeWritablePath(context, value), { code: 'RESOURCE_NOT_SUPPORTED' })
  }

  // Case and trailing-slash aliases must share the same cursor and read baseline.
  let page = await read('BOOK/KNOWLEDGE/CHARACTERS/CHAR_SOURCE.MD', { maxChars: 512 })
  while (page.data.nextCursor) page = await read(`${sourcePath}/`, { maxChars: 512, cursor: page.data.nextCursor })
  const sourceReference = page.references[0]
  await read(outlinePath)
  const changed = outline.replace('原内容。', '新内容。')
  const write = await proposals.write(context, {
    path: 'BOOK/KNOWLEDGE/OUTLINES/OUTLINE_MAIN.MD', content: changed,
    basis: 'source_grounded', sources: ['BOOK/KNOWLEDGE/CHARACTERS/CHAR_SOURCE.MD']
  })
  assert.equal(await frozen(write), changed)
  assert.deepEqual((await proposals.readFrozenCandidate(context, write.data.proposalId)).record.sources, [sourceReference])
  const edit = await proposals.edit(context, {
    path: `${outlinePath}/`, edits: [{ oldText: '原内容。', newText: `人物：[[${sourcePath}|林舟]]。` }],
    basis: 'source_grounded', sources: [sourcePath]
  })
  assert.equal(await frozen(edit), outline.replace('原内容。', '人物：[[character:char_source|林舟]]。'))
  const chapterReference = makeSourceReference({ sourceType: 'chapter', targetId: '第一卷Volume/Start.TXT' })
  const metadataEdit = await proposals.edit(context, {
    path: outlinePath,
    edits: [{ oldText: 'chapterRefs: []', newText: `chapterRefs: ["${chapterPath}"]` }],
    basis: 'creative'
  })
  assert.equal(await frozen(metadataEdit), outline.replace('chapterRefs: []', `chapterRefs: ["${chapterReference}"]`))
  const blockEdit = await proposals.edit(context, {
    path: outlinePath,
    edits: [{ oldText: 'characterRefs: []', newText: `characterRefs:\r\n  - ${sourcePath}` }], basis: 'creative'
  })
  assert.equal(await frozen(blockEdit), outline.replace('characterRefs: []', 'characterRefs:\r\n  - "character:char_source"'))

  const created = await proposals.create(context, {
    directory: 'BOOK/KNOWLEDGE/OUTLINES', content: outline.replace('characterRefs: []', `characterRefs: ["${sourcePath}"]`).replace('原内容。', `[[${sourcePath}|林舟]]`),
    basis: 'source_grounded', sources: [sourcePath]
  })
  assert.deepEqual(parseKnowledgeMarkdown(await frozen(created)).metadata.characterRefs, ['character:char_source'])
  assert.equal(fs.readdirSync(path.join(book, 'knowledge/outlines')).length, 1)
  const createdChapter = await proposals.create(context, { directory: 'BOOK/CHAPTERS/第一卷volume', content: '下一章。' })
  assert.equal(createdChapter.data.target.path, 'book/chapters/第一卷Volume/新章节-1.txt')
  const notePath = 'book/notes/quick-notes.md'
  await read('BOOK/NOTES/QUICK-NOTES.MD')
  const noteEdit = await proposals.edit(context, { path: notePath, edits: [{ oldText: '待补充', newText: `[[${sourcePath}|林舟]]` }] })
  assert.equal(await frozen(noteEdit), '# 速记\n[[character:char_source|林舟]]')

  const count = (await proposals.list(context)).length
  await assert.rejects(proposals.create({ ...context, turnId: 'unread' }, {
    directory: 'book/knowledge/outlines', content: outline, basis: 'source_grounded', sources: [chapterPath]
  }), { code: 'KNOWLEDGE_EVIDENCE_NOT_READ' })
  for (const evidencePath of ['book/knowledge/characters', 'help/index.md', 'view/backlinks'])
    await assert.rejects(proposals.create(context, {
      directory: 'book/knowledge/outlines', content: outline, basis: 'source_grounded', sources: [evidencePath]
    }), { code: 'KNOWLEDGE_EVIDENCE_NOT_READ' })
  await assert.rejects(proposals.edit(context, {
    path: outlinePath, edits: [{ oldText: 'characterRefs: []', newText: `characterRefs: ["${chapterPath}"]` }], basis: 'creative'
  }), { code: 'DOCUMENT_FORMAT_INVALID' })
  await assert.rejects(proposals.edit(context, {
    path: outlinePath, edits: [{ oldText: '原内容。', newText: '[[book/knowledge/characters/missing.md|不存在]]' }], basis: 'creative'
  }), { code: 'DOCUMENT_NOT_FOUND' })
  assert.equal((await proposals.list(context)).length, count)

  fs.mkdirSync(path.join(temp, 'B/knowledge/characters'), { recursive: true })
  fs.writeFileSync(path.join(temp, 'B/knowledge/characters/char_source.md'), 'OTHER_BOOK_MARKER')
  const foreignContext = { ...context, turnId: 'foreign', bookScope: sandbox.bindBook('B') }
  const foreignRead = await documents.read(foreignContext, { path: sourcePath })
  ledger.recordDelivery(foreignContext, { ok: true, ...foreignRead })
  await assert.rejects(proposals.create({ ...context, turnId: 'foreign' }, {
    directory: 'book/knowledge/outlines', content: outline, basis: 'source_grounded', sources: [sourcePath]
  }), { code: 'KNOWLEDGE_EVIDENCE_NOT_READ' })

  const sourceFile = path.join(book, 'knowledge/characters/char_source.md')
  fs.appendFileSync(sourceFile, '\n版本变化。')
  await assert.rejects(proposals.create(context, {
    directory: 'book/knowledge/outlines', content: outline, basis: 'source_grounded', sources: [sourcePath]
  }), { code: 'READ_VERSION_CHANGED' })
  const refreshed = await read(sourcePath)
  const afterRefresh = await proposals.create(context, {
    directory: 'book/knowledge/outlines', content: outline, basis: 'source_grounded', sources: [sourcePath]
  })
  assert.deepEqual((await proposals.readFrozenCandidate(context, afterRefresh.data.proposalId)).record.sources, refreshed.references)
  assert.notEqual(refreshed.references[0], sourceReference)

  const record = (await proposals.readFrozenCandidate(context, created.data.proposalId)).record
  await proposals.apply(context, { proposalId: record.proposalId, revision: record.revision, candidateHash: record.candidateHash })
  const linkedRead = await read(record.target.path)
  assert(linkedRead.data.links.some((item) => item.reference === 'character:char_source' && item.path === sourcePath))
  await proposals.undo(context, record.proposalId)
  assert.equal(fs.readFileSync(path.join(book, 'knowledge/outlines/outline_main.md'), 'utf8'), outline)
  console.log('harness-document-paths-test: ok')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
