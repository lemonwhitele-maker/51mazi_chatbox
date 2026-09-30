import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import BookSandboxService from '../src/main/harness/sandbox/bookSandboxService.js'
import BookDocumentService from '../src/main/harness/documents/bookDocumentService.js'
import EditorDirtyStateRegistry from '../src/main/harness/documents/editorDirtyStateRegistry.js'
import ReadSnapshotLedger from '../src/main/harness/documents/readSnapshotLedger.js'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import DocumentWriteProposalService from '../src/main/harness/write/documentWriteProposalService.js'
import ChapterWriteService from '../src/main/services/chapterWriteService.js'
import BookWordStatsService from '../src/main/services/bookWordStatsService.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import { createDocumentTools } from '../src/main/harness/tools/documentTools.js'

const digest = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
const root = fs.mkdtempSync(path.join(os.tmpdir(), '51mazi-p5-'))

try {
  const bookName = '甲书'
  const book = path.join(root, bookName)
  const volume = path.join(book, '正文', '第一卷')
  const noteDir = path.join(book, '.51mazi', 'notes')
  fs.mkdirSync(volume, { recursive: true })
  fs.mkdirSync(noteDir, { recursive: true })
  const chapterPath = path.join(volume, '开端.txt')
  const notePath = path.join(noteDir, 'quick-notes.md')
  const chapterOriginal = '潮声从门外涌来。\r\n林舟握紧了船绳。\n他没有回头。'
  const noteOriginal = '# 速记\n\n- 核对水门开启时间\n'
  fs.writeFileSync(chapterPath, chapterOriginal)
  fs.writeFileSync(notePath, noteOriginal)
  const rootStats = path.join(root, 'word_stats.json')
  fs.writeFileSync(rootStats, 'ROOT_STATS_MUST_NOT_CHANGE')

  const snapshotService = {
    getBooksDir: () => root,
    resolveBookPath: (name) => path.join(root, name),
    resolveInside(base, relative) {
      const target = path.resolve(base, relative)
      if (!target.startsWith(`${path.resolve(base)}${path.sep}`)) throw new Error('outside')
      return target
    },
    readChapterSnapshot(name, targetId) {
      const filePath = path.join(root, name, '正文', ...targetId.split('/'))
      const raw = fs.readFileSync(filePath)
      return {
        content: raw.toString('utf8'),
        rawHash: digest(raw),
        savedAt: new Date().toISOString(),
        metadata: { filePath }
      }
    }
  }
  const retrievalService = {
    listBookStructure(_book, scopes) {
      return {
        characters: [], settings: [], outlines: [], notes: [],
        chapters: scopes.includes('chapters')
          ? [{ targetId: '第一卷/开端.txt', relativePath: '第一卷/开端.txt', title: '开端' }]
          : []
      }
    },
    searchBookKnowledge: () => ({ results: [] })
  }
  const sandbox = new BookSandboxService({ booksDirProvider: root })
  const stats = new BookWordStatsService({ snapshotService })
  const chapterWriter = new ChapterWriteService({
    snapshotService,
    onCommitted: ({ bookName: name, volumeName, chapterName, previousContent, content }) =>
      stats.updateChapter(name, volumeName, chapterName, previousContent, content)
  })
  chapterWriter.sandboxService = sandbox
  const documents = new BookDocumentService({ sandboxService: sandbox, retrievalService })
  const ledger = new ReadSnapshotLedger()
  const store = new HarnessStore({ snapshotService, sandboxService: sandbox })
  const state = await store.createConversation({ bookKey: bookName, title: 'P5' })
  const scope = sandbox.bindBook(bookName, { conversationId: state.conversationId, turnId: 'turn_p5' })
  const dirty = new EditorDirtyStateRegistry()
  const context = { conversationId: state.conversationId, turnId: 'turn_p5', bookScope: scope }
  const service = new DocumentWriteProposalService({
    store, documentService: documents, readSnapshotLedger: ledger,
    chapterWriteService: chapterWriter,
    isDocumentDirty: (target) => dirty.isDirty(target)
  })

  async function readFully(pathValue) {
    let page = await documents.read(context, { path: pathValue, maxChars: 512 })
    let sequence = 1
    ledger.recordDelivery(context, { ok: true, ...page }, { deliverySequence: sequence++ })
    while (page.data.nextCursor) {
      page = await documents.read(context, { path: pathValue, cursor: page.data.nextCursor, maxChars: 512 })
      ledger.recordDelivery(context, { ok: true, ...page }, { deliverySequence: sequence++ })
    }
  }

  const chapterVirtual = 'book/chapters/第一卷/开端.txt'
  await readFully(chapterVirtual)
  const chapterProposal = await service.edit(context, {
    path: chapterVirtual,
    edits: [{ oldText: '林舟握紧了船绳。', newText: '林舟慢慢松开了船绳。' }]
  })
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), chapterOriginal)
  assert.equal(fs.readFileSync(rootStats, 'utf8'), 'ROOT_STATS_MUST_NOT_CHANGE')
  assert.equal(fs.existsSync(path.join(book, '.51mazi', 'stats', 'word-stats.json')), false)

  dirty.update({
    senderId: 1, frameId: 0, bookIdentity: scope.bookIdentity, bookKey: bookName,
    workspace: {
      currentModule: 'editor', hasUnsavedChanges: true,
      metadata: { file_type: 'chapter', volume_name: '第一卷', chapter_name: '开端' }
    }
  })
  const chapterRecord = (await service.list(context)).find((item) => item.proposalId === chapterProposal.data.proposalId)
  await assert.rejects(service.apply(context, {
    proposalId: chapterRecord.proposalId,
    revision: chapterRecord.revision,
    candidateHash: chapterRecord.candidateHash
  }), { code: 'EDITOR_DIRTY' })
  dirty.revokeSender(1)
  const appliedChapter = await service.apply(context, {
    proposalId: chapterRecord.proposalId,
    revision: chapterRecord.revision,
    candidateHash: chapterRecord.candidateHash
  })
  assert.match(appliedChapter.content, /慢慢松开/)
  assert.equal(fs.readFileSync(rootStats, 'utf8'), 'ROOT_STATS_MUST_NOT_CHANGE')
  assert(stats.readBook(bookName).chapterStats['第一卷/开端'])
  dirty.update({ senderId: 1, bookIdentity: scope.bookIdentity, bookKey: bookName,
    workspace: { currentModule: 'editor', hasUnsavedChanges: true,
      metadata: { file_type: 'chapter', volume_name: '第一卷', chapter_name: '开端' } } })
  await assert.rejects(service.undo(context, chapterRecord.proposalId), { code: 'EDITOR_DIRTY' })
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), appliedChapter.content)
  dirty.revokeSender(1)
  const undoneChapter = await service.undo(context, chapterRecord.proposalId)
  assert.equal(undoneChapter.contentHash, digest(Buffer.from(chapterOriginal)))
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), chapterOriginal)

  // Selection replacement is frozen to the turn, including repeated text.
  const duplicateSource = '开头。\r\n相同句。\r\n中间。\r\n相同句。\r\n结尾。'
  fs.writeFileSync(chapterPath, duplicateSource)
  await readFully(chapterVirtual)
  const normalized = duplicateSource.replace(/\r\n/g, '\n')
  const selectedStart = normalized.lastIndexOf('相同句。')
  const selectedContext = { ...context, workspace: {
    currentModule: 'editor', selectionText: '相同句。',
    textRange: { start: selectedStart, end: selectedStart + 4 },
    currentDocumentSavedHash: digest(Buffer.from(duplicateSource)), hasUnsavedChanges: false,
    metadata: { file_type: 'chapter', volume_name: '第一卷', chapter_name: '开端' }
  } }
  const selectedArgs = { path: chapterVirtual, edits: [{ newText: '相同句。\n续写。' }] }
  await assert.rejects(service.edit(selectedContext, { ...selectedArgs,
    edits: [{ oldText: '中间。', newText: '越界' }] }), { code: 'SELECTION_SCOPE_REQUIRED' })
  await assert.rejects(service.edit(selectedContext, { ...selectedArgs,
    edits: [...selectedArgs.edits, { oldText: '结尾。', newText: '越界' }] }), { code: 'SELECTION_SCOPE_REQUIRED' })
  await assert.rejects(service.write(selectedContext, { path: chapterVirtual, content: '覆盖整章' }), { code: 'SELECTION_SCOPE_REQUIRED' })
  await assert.rejects(service.create(selectedContext, { directory: 'book/chapters/第一卷/', content: '新章节' }), { code: 'SELECTION_SCOPE_REQUIRED' })
  await assert.rejects(service.edit({ ...selectedContext, workspace: { ...selectedContext.workspace, currentDocumentSavedHash: 'old' } }, selectedArgs), { code: 'SELECTION_BASE_CHANGED' })
  await assert.rejects(service.edit({ ...selectedContext, workspace: { ...selectedContext.workspace, hasUnsavedChanges: true } }, selectedArgs), { code: 'SELECTION_BASE_CHANGED' })
  const registry = new DomainToolRegistry()
  createDocumentTools({ documentService: documents, proposalService: service }).forEach((tool) => registry.register(tool))
  const withoutSelection = await registry.execute('edit', context, selectedArgs)
  assert.equal(withoutSelection.error.code, 'EDIT_OLD_TEXT_REQUIRED', '无选区不能省略 oldText')
  const movedRange = await registry.execute('edit', { ...selectedContext,
    workspace: { ...selectedContext.workspace, textRange: { start: 0, end: 4 } }
  }, selectedArgs)
  assert.equal(movedRange.error.code, 'SELECTION_BASE_CHANGED', '不能使用与快照不符的位置')
  const deletedSelection = await registry.execute('edit', selectedContext, { ...selectedArgs, edits: [{ newText: '' }] })
  assert.equal(deletedSelection.ok, true, JSON.stringify(deletedSelection.error))
  const selected = await registry.execute('edit', selectedContext, selectedArgs)
  assert.equal(selected.ok, true, JSON.stringify(selected.error))
  const selectedRecord = (await service.list(context)).find((item) => item.proposalId === selected.data.proposalId)
  assert.deepEqual(selectedRecord.preview.selection, { before: '相同句。', after: '相同句。\n续写。' })
  const selectedResult = await service.apply(context, selectedRecord)
  assert.equal(selectedResult.content, '开头。\r\n相同句。\r\n中间。\r\n相同句。\n续写。\r\n结尾。')
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), selectedResult.content, '确认即保存，无需再次点击保存')
  const selectedUndo = await service.undo(context, selectedRecord.proposalId)
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), duplicateSource, '撤销即保存')
  assert.equal(selectedUndo.contentHash, digest(Buffer.from(duplicateSource)))
  fs.writeFileSync(chapterPath, chapterOriginal)
  await readFully(chapterVirtual)

  const noteVirtual = 'book/notes/quick-notes.md'
  await readFully(noteVirtual)
  const noteProposal = await service.edit(context, {
    path: noteVirtual,
    edits: [{ oldText: '核对水门开启时间', newText: '已核对水门开启时间' }]
  })
  const noteRecord = (await service.list(context)).find((item) => item.proposalId === noteProposal.data.proposalId)
  assert.equal(fs.readFileSync(notePath, 'utf8'), noteOriginal)
  await service.apply(context, {
    proposalId: noteRecord.proposalId,
    revision: noteRecord.revision,
    candidateHash: noteRecord.candidateHash
  })
  assert.match(fs.readFileSync(notePath, 'utf8'), /已核对/)
  await service.undo(context, noteRecord.proposalId)
  assert.equal(fs.readFileSync(notePath, 'utf8'), noteOriginal)

  fs.unlinkSync(notePath)
  const createNote = await service.create(context, {
    directory: 'book/notes/',
    content: '# 速记\n\n## 活跃\n\n新想法。\n\n## 归档\n'
  })
  const createNoteRecord = (await service.list(context)).find(
    (item) => item.proposalId === createNote.data.proposalId
  )
  assert.equal(fs.existsSync(notePath), false)
  await service.apply(context, {
    proposalId: createNoteRecord.proposalId,
    revision: createNoteRecord.revision,
    candidateHash: createNoteRecord.candidateHash
  })
  assert.match(fs.readFileSync(notePath, 'utf8'), /## 归档/)
  await service.undo(context, createNoteRecord.proposalId)
  assert.equal(fs.existsSync(notePath), false)

  const fieldError = await service.edit(context, {
    path: chapterVirtual,
    edits: [{ oldText: '潮声从门外涌来。', newText: '潮声涌来。' }],
    basis: 'creative'
  }).catch((error) => error)
  assert.equal(fieldError.code, 'FIELD_NOT_APPLICABLE')

  // A newly created, empty volume must be discoverable and usable without
  // guessing its path. Confirmation remains the only operation that writes it.
  const emptyVolume = path.join(book, '正文', '第二卷')
  fs.mkdirSync(emptyVolume)
  const volumeList = await documents.read(context, { path: 'book/chapters/' })
  const emptyVolumePath = volumeList.data.items.find((item) => item.name === '第二卷').path
  const emptyCreate = await service.create(context, {
    directory: emptyVolumePath, content: '空卷的第一章。'
  })
  const emptyCreatedPath = path.join(emptyVolume, '新章节-1.txt')
  assert.equal(fs.existsSync(emptyCreatedPath), false)
  const emptyRecord = (await service.list(context)).find((item) => item.proposalId === emptyCreate.data.proposalId)
  await service.apply(context, {
    proposalId: emptyRecord.proposalId, revision: emptyRecord.revision, candidateHash: emptyRecord.candidateHash
  })
  const emptyChapters = await documents.read(context, { path: emptyVolumePath })
  assert.equal(emptyChapters.data.items.length, 1)
  assert.equal((await documents.read(context, { path: emptyChapters.data.items[0].path })).data.text, '空卷的第一章。')
  await service.undo(context, emptyRecord.proposalId)
  assert.equal(fs.existsSync(emptyVolume), true)
  assert.deepEqual((await documents.read(context, { path: emptyVolumePath })).data.items, [])
  await assert.rejects(service.create(context, { directory: 'book/chapters/不存在/', content: '不能创建' }), { code: 'DOCUMENT_NOT_FOUND' })

  const createChapter = await service.create(context, {
    directory: 'book/chapters/第一卷/', content: '新章节的第一句。'
  })
  const createRecord = (await service.list(context)).find((item) => item.proposalId === createChapter.data.proposalId)
  assert.equal(createRecord.target.documentId, '第一卷/新章节-1.txt')
  const secondCreateChapter = await service.create(context, {
    directory: 'book/chapters/第一卷/', content: '第二个冻结候选。'
  })
  const secondCreateRecord = (await service.list(context)).find(
    (item) => item.proposalId === secondCreateChapter.data.proposalId
  )
  assert.equal(secondCreateRecord.target.documentId, '第一卷/新章节-2.txt')
  await service.reject(context, secondCreateRecord.proposalId, secondCreateRecord.revision)
  const createdPath = path.join(volume, '新章节-1.txt')
  assert.equal(fs.existsSync(createdPath), false)
  await service.apply(context, {
    proposalId: createRecord.proposalId,
    revision: createRecord.revision,
    candidateHash: createRecord.candidateHash
  })
  assert.equal(fs.readFileSync(createdPath, 'utf8'), '新章节的第一句。')
  await service.undo(context, createRecord.proposalId)
  assert.equal(fs.existsSync(createdPath), false)
  assert.equal(fs.existsSync(volume), true)
  assert.equal(fs.readFileSync(rootStats, 'utf8'), 'ROOT_STATS_MUST_NOT_CHANGE')

  const legacyBook = path.join(root, '乙书')
  fs.mkdirSync(path.join(legacyBook, '正文', '旧卷'), { recursive: true })
  const legacyStats = JSON.stringify({
    dailyStats: { '2026-09-01': 12 },
    chapterStats: {
      '乙书/旧卷/旧章': {
        totalWords: 12,
        lastUpdate: '2026-09-01',
        wordChange: 12,
        lastContentLength: 0
      }
    },
    bookDailyStats: {
      乙书: {
        '2026-09-01': { netWords: 12, addWords: 12, deleteWords: 0, totalWords: 12 }
      }
    }
  })
  fs.writeFileSync(rootStats, legacyStats)
  const migrated = await stats.migrateLegacyRootStats()
  assert.equal(migrated.migrated, 1)
  assert.equal(fs.readFileSync(rootStats, 'utf8'), legacyStats, '迁移不得改写旧根统计')
  assert.equal(stats.readBook('乙书').chapterStats['旧卷/旧章'].totalWords, 12)
  assert.equal(stats.readAggregate().bookDailyStats['乙书']['2026-09-01'].netWords, 12)

  console.log('harness-document-content-test: ok')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
