import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import BookSavedSnapshotService from '../src/main/services/bookSavedSnapshotService.js'
import BookKnowledgeCatalogService from '../src/main/services/bookKnowledgeCatalogService.js'
import BookReferenceIndexService from '../src/main/services/bookReferenceIndexService.js'
import KnowledgeDocumentService from '../src/main/services/knowledgeDocumentService.js'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import KnowledgeWriteProposalService from '../src/main/harness/write/knowledgeWriteProposalService.js'
import { createKnowledgeWriteProposalTools } from '../src/main/harness/tools/knowledgeWriteProposalTools.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'

const root = fs.mkdtempSync(join(process.cwd(), '.tmp-phase3-'))
const booksDir = join(root, 'books')
const bookName = 'Phase3 测试书'
fs.mkdirSync(join(booksDir, bookName), { recursive: true })

const snapshotService = new BookSavedSnapshotService({ booksDirProvider: () => booksDir })
const catalogService = new BookKnowledgeCatalogService({ snapshotService })
const referenceIndexService = new BookReferenceIndexService({ snapshotService, catalogService })
const documentService = new KnowledgeDocumentService({
  snapshotService,
  onCommitted: async ({ bookName: changedBook, scope }) => {
    catalogService.invalidate(changedBook)
    catalogService.buildCatalog(changedBook, scope, { force: true })
    referenceIndexService.invalidate(changedBook)
    referenceIndexService.buildIndex(changedBook, { force: true })
  }
})

await documentService.initializeBook({ bookName })
const store = new HarnessStore({ snapshotService })
const conversation = await store.createConversation({ bookKey: bookName, runtimeId: 'fake' })
const service = new KnowledgeWriteProposalService({
  store,
  snapshotService,
  documentService,
  catalogService,
  referenceIndexService
})
const context = {
  bookKey: bookName,
  conversationId: conversation.conversationId,
  conversationState: conversation,
  turnId: 'turn_phase3',
  providerCallId: 'provider_phase3',
  toolCallId: 'tool_phase3'
}

try {
  const toolDefinitions = createKnowledgeWriteProposalTools({ proposalService: service })
  const names = toolDefinitions.map((tool) => tool.name)
  assert.deepEqual(names, [
    'propose_character_edit',
    'propose_setting_edit',
    'propose_outline_edit',
    'propose_quick_note_change'
  ])
  assert.equal(names.filter((name) => name.includes('outline')).length, 1)

  const characterBefore = documentService.readDocument({
    bookName,
    scope: 'characters',
    documentId: 'example_character'
  })
  const registry = new DomainToolRegistry()
  toolDefinitions.forEach((tool) => registry.register(tool))
  const characterProposal = await registry.execute('propose_character_edit', context, {
    operation: 'replace_section',
    summary: '更新人物当前状态',
    basis: 'creative',
    reason: '故事推进到灯塔',
    documentId: 'example_character',
    sectionKey: 'current-state',
    expectedFileHash: characterBefore.fileHash,
    expectedSectionHash: characterBefore.sectionHashes['current-state'],
    content: '林舟已经进入旧灯塔，正在检查蓝灯。'
  })
  assert.equal(characterProposal.ok, true)
  assert.equal(characterProposal.proposal.status, 'pending')
  assert.equal(
    documentService.readDocument({ bookName, scope: 'characters', documentId: 'example_character' })
      .fileHash,
    characterBefore.fileHash,
    '创建提案不得修改正式人物文档'
  )
  const characterApplied = await service.apply({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: characterProposal.proposal.proposalId
  })
  assert.equal(characterApplied.proposal.status, 'applied')
  assert.match(
    documentService.readDocument({ bookName, scope: 'characters', documentId: 'example_character' })
      .source,
    /已经进入旧灯塔/
  )
  const characterUndone = await service.undo({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: characterProposal.proposal.proposalId
  })
  assert.equal(characterUndone.proposal.status, 'undone')
  assert.equal(
    documentService.readDocument({ bookName, scope: 'characters', documentId: 'example_character' })
      .fileHash,
    characterBefore.fileHash
  )

  const settingBefore = documentService.readDocument({
    bookName,
    scope: 'settings',
    documentId: 'example_setting'
  })
  const settingProposal = await service.createFromTool(context, 'setting', {
    operation: 'update_metadata',
    summary: '增加设定别名',
    basis: 'creative',
    documentId: 'example_setting',
    expectedFileHash: settingBefore.fileHash,
    metadata: { aliases: ['旧灯塔', '蓝灯塔'] }
  })
  await service.apply({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: settingProposal.proposal.proposalId
  })
  assert.deepEqual(
    documentService.readDocument({ bookName, scope: 'settings', documentId: 'example_setting' })
      .document.metadata.aliases,
    ['旧灯塔', '蓝灯塔']
  )
  assert.equal(catalogService.resolveName(bookName, 'settings', '蓝灯塔').length, 1)

  const outlineBefore = documentService.readDocument({
    bookName,
    scope: 'outlines',
    documentId: 'example_outline'
  })
  const outlineProposal = await service.createFromTool(context, 'outline', {
    operation: 'link_chapter',
    summary: '关联第二章',
    basis: 'creative',
    documentId: 'example_outline',
    expectedFileHash: outlineBefore.fileHash,
    reference: 'chapter:chapter_02'
  })
  await service.apply({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: outlineProposal.proposal.proposalId
  })
  assert.ok(
    documentService
      .readDocument({ bookName, scope: 'outlines', documentId: 'example_outline' })
      .document.metadata.chapterRefs.includes('chapter_02')
  )

  const invalidCreate = await registry.execute('propose_outline_edit', context, {
    operation: 'create_document',
    summary: '错误字段不能静默成功',
    basis: 'creative',
    title: '错误大纲',
    content: '这段内容不能被静默丢弃。'
  })
  assert.equal(invalidCreate.ok, false)
  assert.equal(invalidCreate.error.code, 'TOOL_ARGUMENT_INVALID')

  const patchBase = documentService.readDocument({
    bookName,
    scope: 'outlines',
    documentId: 'example_outline'
  })
  const patchProposal = await service.createFromTool(context, 'outline', {
    operation: 'patch_document',
    summary: '原子更新三个大纲分区',
    basis: 'creative',
    documentId: 'example_outline',
    expectedFileHash: patchBase.fileHash,
    changes: [
      {
        operation: 'replace_section',
        sectionKey: 'summary',
        expectedSectionHash: patchBase.sectionHashes.summary,
        content: '新的核心内容。'
      },
      {
        operation: 'replace_section',
        sectionKey: 'details',
        expectedSectionHash: patchBase.sectionHashes.details,
        content: '新的展开说明。'
      },
      {
        operation: 'replace_section',
        sectionKey: 'constraints',
        expectedSectionHash: patchBase.sectionHashes.constraints,
        content: '新的约束与结果。'
      }
    ]
  })
  assert.deepEqual(patchProposal.proposal.affectedSections.sort(), [
    'constraints',
    'details',
    'summary'
  ])
  await service.apply({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: patchProposal.proposal.proposalId
  })
  const patchedOutline = documentService.readDocument({
    bookName,
    scope: 'outlines',
    documentId: 'example_outline'
  })
  assert.equal(patchedOutline.document.sectionMap.summary.rawContent.trim(), '新的核心内容。')
  assert.equal(patchedOutline.document.sectionMap.details.rawContent.trim(), '新的展开说明。')
  assert.equal(patchedOutline.document.sectionMap.constraints.rawContent.trim(), '新的约束与结果。')

  const independentBase = documentService.readDocument({
    bookName,
    scope: 'outlines',
    documentId: 'example_outline'
  })
  const summaryProposal = await service.createFromTool(context, 'outline', {
    operation: 'replace_section',
    summary: '独立更新核心内容',
    basis: 'creative',
    documentId: 'example_outline',
    expectedFileHash: independentBase.fileHash,
    expectedSectionHash: independentBase.sectionHashes.summary,
    sectionKey: 'summary',
    content: '独立核心内容。'
  })
  const detailsProposal = await service.createFromTool(context, 'outline', {
    operation: 'replace_section',
    summary: '独立更新展开说明',
    basis: 'creative',
    documentId: 'example_outline',
    expectedFileHash: independentBase.fileHash,
    expectedSectionHash: independentBase.sectionHashes.details,
    sectionKey: 'details',
    content: '独立展开说明。'
  })
  assert.equal(summaryProposal.proposal.status, 'pending')
  assert.equal(detailsProposal.proposal.status, 'pending')
  assert.deepEqual(detailsProposal.data.supersededProposalIds, [])
  await service.apply({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: summaryProposal.proposal.proposalId
  })
  await service.apply({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: detailsProposal.proposal.proposalId
  })
  const independentlyPatched = documentService.readDocument({
    bookName,
    scope: 'outlines',
    documentId: 'example_outline'
  })
  assert.equal(independentlyPatched.document.sectionMap.summary.rawContent.trim(), '独立核心内容。')
  assert.equal(independentlyPatched.document.sectionMap.details.rawContent.trim(), '独立展开说明。')

  const overlapBase = independentlyPatched
  const oldSummary = await service.createFromTool(context, 'outline', {
    operation: 'replace_section',
    summary: '旧核心提案',
    basis: 'creative',
    documentId: 'example_outline',
    expectedFileHash: overlapBase.fileHash,
    expectedSectionHash: overlapBase.sectionHashes.summary,
    sectionKey: 'summary',
    content: '即将被替代。'
  })
  const newSummary = await service.createFromTool(context, 'outline', {
    operation: 'replace_section',
    summary: '新核心提案',
    basis: 'creative',
    documentId: 'example_outline',
    expectedFileHash: overlapBase.fileHash,
    expectedSectionHash: overlapBase.sectionHashes.summary,
    sectionKey: 'summary',
    content: '保留的新提案。'
  })
  assert.deepEqual(newSummary.data.supersededProposalIds, [oldSummary.proposal.proposalId])
  await service.apply({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: newSummary.proposal.proposalId
  })

  const evidenceBase = documentService.readDocument({
    bookName,
    scope: 'characters',
    documentId: 'example_character'
  })
  const formalReference = 'chapter:chapter_01#L1-10@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const groundedContext = {
    ...context,
    evidenceEnforced: true,
    evidenceReferences: [{
      reference: formalReference,
      authorityStatus: 'authoritative_saved',
      savedHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    }]
  }
  await assert.rejects(
    service.createFromTool(groundedContext, 'character', {
      operation: 'update_metadata',
      summary: '拒绝未读取证据',
      basis: 'source_grounded',
      sourceReferences: ['chapter:not-read#L1-1@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
      documentId: 'example_character',
      expectedFileHash: evidenceBase.fileHash,
      metadata: { tags: ['未读取'] }
    }),
    /本轮未通过 read_book_source 读取/
  )
  const groundedProposal = await service.createFromTool(groundedContext, 'character', {
    operation: 'update_metadata',
    summary: '接受正式证据',
    basis: 'source_grounded',
    sourceReferences: [formalReference],
    documentId: 'example_character',
    expectedFileHash: evidenceBase.fileHash,
    metadata: { tags: ['有正式证据'] }
  })
  assert.deepEqual(groundedProposal.proposal.sourceReferences, [formalReference])

  const runningState = (
    await store.loadConversation(bookName, conversation.conversationId)
  ).state
  runningState.status = 'running'
  runningState.activeTurnId = 'turn-confirmation-guard'
  await store.updateState(runningState)
  await assert.rejects(
    service.apply({
      bookName,
      conversationId: conversation.conversationId,
      proposalId: groundedProposal.proposal.proposalId
    }),
    (error) => error?.code === 'WRITE_PROPOSAL_TURN_RUNNING'
  )
  runningState.status = 'idle'
  runningState.activeTurnId = null
  await store.updateState(runningState)

  const conflictBase = documentService.readDocument({
    bookName,
    scope: 'characters',
    documentId: 'example_character'
  })
  const conflictProposal = await service.createFromTool(context, 'character', {
    operation: 'replace_section',
    summary: '将被冲突拦截',
    basis: 'creative',
    documentId: 'example_character',
    sectionKey: 'facts',
    expectedFileHash: conflictBase.fileHash,
    expectedSectionHash: conflictBase.sectionHashes.facts,
    content: '旧提案不能覆盖外部修改。'
  })
  await documentService.writeSection({
    bookName,
    scope: 'characters',
    documentId: 'example_character',
    sectionKey: 'facts',
    expectedFileHash: conflictBase.fileHash,
    expectedSectionHash: conflictBase.sectionHashes.facts,
    content: '这是用户刚刚保存的新事实。'
  })
  await assert.rejects(
    service.apply({
      bookName,
      conversationId: conversation.conversationId,
      proposalId: conflictProposal.proposal.proposalId
    }),
    /已发生变化/
  )
  const conflicted = (
    await service.list({ bookName, conversationId: conversation.conversationId })
  ).find((item) => item.proposalId === conflictProposal.proposal.proposalId)
  assert.equal(conflicted.status, 'conflicted')

  const notePath = join(booksDir, bookName, '.51mazi', 'notes', 'quick-notes.md')
  fs.mkdirSync(join(notePath, '..'), { recursive: true })
  fs.writeFileSync(notePath, '# 速记\n', 'utf8')
  catalogService.invalidate(bookName)
  const noteHash = catalogService.buildCatalog(bookName, 'notes', { force: true }).entries[0]
    .fileHash
  const noteProposal = await service.createQuickNoteFromTool(context, {
    operation: 'append_note',
    summary: '记录讨论结论',
    expectedFileHash: noteHash,
    content: '- 蓝灯意味着有人求援。'
  })
  await service.apply({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: noteProposal.proposal.proposalId
  })
  assert.match(fs.readFileSync(notePath, 'utf8'), /蓝灯意味着有人求援/)
  await service.undo({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: noteProposal.proposal.proposalId
  })
  assert.equal(fs.readFileSync(notePath, 'utf8'), '# 速记\n')

  const createProposal = await service.createFromTool(context, 'outline', {
    operation: 'create_document',
    summary: '创建统一大纲',
    basis: 'creative',
    title: '第十二章冲突设计',
    metadata: { status: 'planned', tags: ['章节计划'], order: 12 },
    sections: {
      summary: '设计第十二章核心冲突。',
      details: '冲突逐步升级。',
      constraints: '不提前揭示谜底。'
    }
  })
  const createdId = createProposal.proposal.target.documentId
  await service.apply({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: createProposal.proposal.proposalId
  })
  assert.equal(
    documentService.readDocument({ bookName, scope: 'outlines', documentId: createdId }).document
      .metadata.type,
    'outline'
  )
  await service.undo({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: createProposal.proposal.proposalId
  })
  assert.throws(
    () => documentService.readDocument({ bookName, scope: 'outlines', documentId: createdId }),
    /不存在/
  )

  console.log('knowledge phase3 tests passed')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
