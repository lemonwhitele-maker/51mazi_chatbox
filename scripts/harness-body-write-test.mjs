import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { Schema } from '@tiptap/pm/model'
import BookSavedSnapshotService from '../src/main/services/bookSavedSnapshotService.js'
import ChapterWriteService, {
  chapterTargetId,
  writeFileAtomically
} from '../src/main/services/chapterWriteService.js'
import {
  editorRangeToTextRange,
  serializeChapterDocument
} from '../src/renderer/src/service/chapterText.js'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import BodyWriteProposalService from '../src/main/harness/write/bodyWriteProposalService.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import { createBodyWriteProposalTools } from '../src/main/harness/tools/bodyWriteProposalTools.js'
import { applyBodyOperation } from '../src/shared/bodyWrite.js'

const tempRoot = fs.mkdtempSync(join(os.tmpdir(), '51mazi-body-write-'))
const bookName = '版本测试书'
const volumeName = '第一卷'
const chapterName = '第1章'
const chapterPath = join(tempRoot, bookName, '正文', volumeName, `${chapterName}.txt`)

function write(filePath, content) {
  fs.mkdirSync(join(filePath, '..'), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

try {
  assert.equal(
    chapterTargetId(volumeName, '第2章 '),
    `${volumeName}/第2章 .txt`,
    '历史章节名的尾随空格应在安全校验后保留，以兼容旧文件'
  )

  write(chapterPath, '旧正文\r\n\r\n第二段')
  const snapshotService = new BookSavedSnapshotService({ booksDirProvider: tempRoot })
  const commits = []
  const service = new ChapterWriteService({
    snapshotService,
    onCommitted: async (event) => commits.push(event)
  })

  const initial = snapshotService.readChapterSnapshot(bookName, `${volumeName}/${chapterName}.txt`)
  const first = await service.writeChapterWithExpectedHash({
    bookName,
    volumeName,
    chapterName,
    expectedHash: initial.rawHash,
    content: '新正文\n\n第二段'
  })
  assert.equal(first.previousHash, initial.rawHash)
  assert.equal(first.contentHash, snapshotService.readChapterSnapshot(bookName, `${volumeName}/${chapterName}.txt`).rawHash)
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), '新正文\n\n第二段')
  assert.equal(commits.length, 1, '成功写入只更新一次统计和元数据')

  await assert.rejects(
    service.writeChapterWithExpectedHash({
      bookName,
      volumeName,
      chapterName,
      expectedHash: initial.rawHash,
      content: '不应写入'
    }),
    (error) => error?.code === 'CHAPTER_VERSION_CONFLICT'
  )
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), '新正文\n\n第二段')
  assert.equal(commits.length, 1, '版本冲突不得重复更新统计')

  const ordinary = await service.writeChapterWithExpectedHash({
    bookName,
    volumeName,
    chapterName,
    content: '普通保存仍兼容'
  })
  assert.equal(ordinary.contentHash, snapshotService.readChapterSnapshot(bookName, `${volumeName}/${chapterName}.txt`).rawHash)
  assert.equal(commits.length, 2)

  await assert.rejects(
    service.writeChapterWithExpectedHash({
      bookName,
      volumeName: '..',
      chapterName,
      content: '越界'
    }),
    /卷名 无效/
  )
  await assert.rejects(
    service.writeChapterWithExpectedHash({
      bookName,
      volumeName,
      chapterName: '其他/章节',
      content: '越界'
    }),
    /章节名 无效/
  )

  const contentBeforeFailure = fs.readFileSync(chapterPath, 'utf8')
  const failedService = new ChapterWriteService({
    snapshotService,
    atomicWriter: async () => {
      throw Object.assign(new Error('simulated replace failure'), { code: 'EACCES' })
    },
    onCommitted: async () => {
      throw new Error('must not run')
    }
  })
  await assert.rejects(
    failedService.writeChapterWithExpectedHash({
      bookName,
      volumeName,
      chapterName,
      expectedHash: ordinary.contentHash,
      content: '失败内容'
    }),
    (error) => error?.code === 'CHAPTER_WRITE_FAILED'
  )
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), contentBeforeFailure)

  const fixedTempId = 'forced-failure'
  const tempPath = join(
    join(chapterPath, '..'),
    `.${chapterName}.txt.${process.pid}.${fixedTempId}.tmp`
  )
  const failingFileSystem = {
    open: (...args) => fs.promises.open(...args),
    unlink: (...args) => fs.promises.unlink(...args),
    async rename() {
      throw Object.assign(new Error('busy'), { code: 'EPERM' })
    }
  }
  await assert.rejects(
    writeFileAtomically(chapterPath, '原子替换失败', {
      fileSystem: failingFileSystem,
      renameAttempts: 2,
      retryDelayMs: 0,
      tempId: () => fixedTempId
    }),
    /busy/
  )
  assert.equal(fs.existsSync(tempPath), false, '失败后不得残留同目录临时文件')
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), contentBeforeFailure)

  const schema = new Schema({
    nodes: {
      doc: { content: 'paragraph*' },
      paragraph: { content: 'text*', group: 'block' },
      text: { group: 'inline' }
    }
  })
  const paragraph = (text = '') =>
    schema.node('paragraph', null, text ? [schema.text(text)] : [])
  const document = schema.node('doc', null, [
    paragraph('甲\t乙'),
    paragraph('第二段中文'),
    paragraph(),
    paragraph('末段')
  ])
  const serialized = serializeChapterDocument(document)
  assert.equal(serialized, '甲\t乙\n\n第二段中文\n\n\n\n末段')

  const textNodes = []
  document.descendants((node, position) => {
    if (node.isText) textNodes.push({ text: node.text, position })
  })
  const [firstText, secondText, lastText] = textNodes
  const fixtures = [
    { from: firstText.position, to: firstText.position + firstText.text.length },
    { from: firstText.position + 1, to: firstText.position + 2 },
    { from: secondText.position, to: secondText.position + 3 },
    { from: firstText.position + 2, to: secondText.position + 2 },
    { from: lastText.position, to: lastText.position + lastText.text.length },
    { from: secondText.position, to: secondText.position }
  ]
  for (const fixture of fixtures) {
    const mapped = editorRangeToTextRange(document, fixture)
    assert.equal(
      serialized.slice(mapped.textRange.start, mapped.textRange.end),
      mapped.originalText,
      `编辑器范围 ${fixture.from}-${fixture.to} 应映射到同一序列化正文`
    )
  }

  const operationFixtures = [
    {
      operation: 'replace_selection',
      expected: '甲新丙',
      input: { content: '甲乙丙', textRange: { start: 1, end: 2 }, originalText: '乙', proposedText: '新' }
    },
    {
      operation: 'insert_before_selection',
      expected: '甲新乙丙',
      input: { content: '甲乙丙', textRange: { start: 1, end: 2 }, originalText: '乙', proposedText: '新' }
    },
    {
      operation: 'insert_after_selection',
      expected: '甲乙新丙',
      input: { content: '甲乙丙', textRange: { start: 1, end: 2 }, originalText: '乙', proposedText: '新' }
    },
    {
      operation: 'append_to_chapter',
      expected: '甲乙丙\n\n新段',
      input: { content: '甲乙丙', textRange: null, originalText: '', proposedText: '新段' }
    }
  ]
  for (const fixture of operationFixtures) {
    const applied = applyBodyOperation({ operation: fixture.operation, ...fixture.input })
    assert.equal(applied.ok, true)
    assert.equal(applied.nextContent, fixture.expected)
  }

  await service.writeChapterWithExpectedHash({
    bookName,
    volumeName,
    chapterName,
    content: '目标正文和第二段'
  })
  const harnessStore = new HarnessStore({ snapshotService })
  const conversation = await harnessStore.createConversation({ bookKey: bookName, runtimeId: 'fake' })
  const events = []
  const proposalService = new BodyWriteProposalService({
    store: harnessStore,
    snapshotService,
    chapterWriteService: service,
    eventSink: (event) => events.push(event)
  })
  const registry = new DomainToolRegistry()
  createBodyWriteProposalTools({ proposalService }).forEach((tool) => registry.register(tool))

  function workspaceForSelection({ start = 0, end = 4, dirty = false } = {}) {
    const snapshot = snapshotService.readChapterSnapshot(bookName, `${volumeName}/${chapterName}.txt`)
    return {
      currentModule: 'editor',
      currentDocumentId: `${volumeName}/${chapterName}.txt`,
      selectionText: snapshot.content.slice(start, end),
      editorRange: { from: start + 1, to: end + 1 },
      textRange: { start, end },
      currentDocumentSavedHash: snapshot.rawHash,
      hasUnsavedChanges: dirty,
      metadata: {
        file_type: 'chapter',
        chapter_id: `${volumeName}/${chapterName}.txt`,
        chapter_name: chapterName,
        volume_name: volumeName
      }
    }
  }

  const toolContext = {
    bookKey: bookName,
    conversationId: conversation.conversationId,
    turnId: 'turn_body_write',
    providerCallId: 'provider_call_1',
    toolCallId: 'tool_call_1',
    workspace: workspaceForSelection()
  }
  const diskBeforeProposal = fs.readFileSync(chapterPath, 'utf8')
  const created = await registry.execute(
    'propose_chapter_edit',
    toolContext,
    { operation: 'replace_selection', summary: '替换开头', proposedText: '安全正文' }
  )
  assert.equal(created.ok, true)
  assert.equal(created.proposal.status, 'pending')
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), diskBeforeProposal, '创建提案不得修改正文')
  assert.equal((await proposalService.list({ bookName, conversationId: conversation.conversationId })).length, 1)
  assert.equal(events.at(-1).type, 'write.proposal.created')

  const rejectedArguments = await registry.execute(
    'propose_chapter_edit',
    toolContext,
    {
      operation: 'replace_selection',
      summary: '不得接受路径',
      proposedText: '文本',
      path: chapterPath
    }
  )
  assert.equal(rejectedArguments.ok, false)
  assert.equal(rejectedArguments.error.code, 'TOOL_ARGUMENT_INVALID')

  const commitsBeforeApply = commits.length
  const appliedProposal = await proposalService.apply({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: created.proposal.proposalId
  })
  assert.equal(appliedProposal.proposal.status, 'applied')
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), '安全正文和第二段')
  assert.equal(commits.length, commitsBeforeApply + 1)
  const repeatedApply = await proposalService.apply({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: created.proposal.proposalId
  })
  assert.equal(repeatedApply.proposal.status, 'applied')
  assert.equal(commits.length, commitsBeforeApply + 1, '重复确认不得再次写入')

  const undone = await proposalService.undo({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: created.proposal.proposalId
  })
  assert.equal(undone.proposal.status, 'undone')
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), diskBeforeProposal)
  const commitsAfterUndo = commits.length
  await proposalService.undo({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: created.proposal.proposalId
  })
  assert.equal(commits.length, commitsAfterUndo, '重复撤销不得再次写入')

  const firstPending = await proposalService.createFromTool(
    { ...toolContext, workspace: workspaceForSelection({ start: 0, end: 2 }) },
    { operation: 'replace_selection', summary: '第一版', proposedText: '一版' }
  )
  const secondPending = await proposalService.createFromTool(
    { ...toolContext, providerCallId: 'provider_call_2', workspace: workspaceForSelection({ start: 0, end: 2 }) },
    { operation: 'replace_selection', summary: '第二版', proposedText: '二版' }
  )
  const supersededList = await proposalService.list({ bookName, conversationId: conversation.conversationId })
  assert.equal(supersededList.find((item) => item.proposalId === firstPending.proposal.proposalId).status, 'superseded')
  assert.equal(supersededList.find((item) => item.proposalId === secondPending.proposal.proposalId).status, 'pending')
  const rejected = await proposalService.reject({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: secondPending.proposal.proposalId
  })
  assert.equal(rejected.status, 'rejected')

  await assert.rejects(
    proposalService.createFromTool(
      { ...toolContext, workspace: workspaceForSelection({ dirty: true }) },
      { operation: 'replace_selection', summary: '脏正文', proposedText: '不创建' }
    ),
    (error) => error?.code === 'WRITE_PROPOSAL_UNSAVED_CHANGES'
  )

  const stale = await proposalService.createFromTool(
    { ...toolContext, providerCallId: 'provider_call_stale', workspace: workspaceForSelection({ start: 0, end: 2 }) },
    { operation: 'replace_selection', summary: '等待冲突', proposedText: '冲突' }
  )
  const staleBase = snapshotService.readChapterSnapshot(bookName, `${volumeName}/${chapterName}.txt`)
  await service.writeChapterWithExpectedHash({
    bookName,
    volumeName,
    chapterName,
    expectedHash: staleBase.rawHash,
    content: `${staleBase.content}（人工修改）`
  })
  await assert.rejects(
    proposalService.apply({
      bookName,
      conversationId: conversation.conversationId,
      proposalId: stale.proposal.proposalId
    }),
    (error) => error?.code === 'CHAPTER_VERSION_CONFLICT'
  )
  assert.equal(
    (await proposalService.list({ bookName, conversationId: conversation.conversationId }))
      .find((item) => item.proposalId === stale.proposal.proposalId).status,
    'stale'
  )

  const appendWorkspace = workspaceForSelection()
  appendWorkspace.selectionText = ''
  appendWorkspace.editorRange = null
  appendWorkspace.textRange = null
  const undoConflict = await proposalService.createFromTool(
    { ...toolContext, providerCallId: 'provider_call_undo_conflict', workspace: appendWorkspace },
    { operation: 'append_to_chapter', summary: '追加测试', proposedText: '追加段落' }
  )
  await proposalService.apply({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: undoConflict.proposal.proposalId
  })
  const afterAppend = snapshotService.readChapterSnapshot(bookName, `${volumeName}/${chapterName}.txt`)
  await service.writeChapterWithExpectedHash({
    bookName,
    volumeName,
    chapterName,
    expectedHash: afterAppend.rawHash,
    content: `${afterAppend.content}\n人工后续编辑`
  })
  await assert.rejects(
    proposalService.undo({
      bookName,
      conversationId: conversation.conversationId,
      proposalId: undoConflict.proposal.proposalId
    }),
    (error) => error?.code === 'WRITE_PROPOSAL_UNDO_CONFLICT'
  )

  const failedWriteService = new ChapterWriteService({
    snapshotService,
    atomicWriter: async () => {
      throw Object.assign(new Error('simulated proposal save failure'), { code: 'EACCES' })
    }
  })
  const failedProposalService = new BodyWriteProposalService({
    store: harnessStore,
    snapshotService,
    chapterWriteService: failedWriteService
  })
  const failedWorkspace = workspaceForSelection({ start: 0, end: 2 })
  const failedProposal = await failedProposalService.createFromTool(
    { ...toolContext, providerCallId: 'provider_call_failed', workspace: failedWorkspace },
    { operation: 'replace_selection', summary: '模拟保存失败', proposedText: '失败' }
  )
  const beforeFailedApply = fs.readFileSync(chapterPath, 'utf8')
  await assert.rejects(
    failedProposalService.apply({
      bookName,
      conversationId: conversation.conversationId,
      proposalId: failedProposal.proposal.proposalId
    }),
    (error) => error?.code === 'CHAPTER_WRITE_FAILED'
  )
  assert.equal(fs.readFileSync(chapterPath, 'utf8'), beforeFailedApply)
  assert.equal(
    (await failedProposalService.list({ bookName, conversationId: conversation.conversationId }))
      .find((item) => item.proposalId === failedProposal.proposal.proposalId).status,
    'failed'
  )

  const recoveryWorkspace = workspaceForSelection()
  recoveryWorkspace.selectionText = ''
  recoveryWorkspace.editorRange = null
  recoveryWorkspace.textRange = null
  const interrupted = await proposalService.createFromTool(
    { ...toolContext, providerCallId: 'provider_call_recovery', workspace: recoveryWorkspace },
    { operation: 'append_to_chapter', summary: '中断恢复', proposedText: '恢复段落' }
  )
  const recoveryBefore = snapshotService.readChapterSnapshot(
    bookName,
    `${volumeName}/${chapterName}.txt`
  )
  const recoveryNext = applyBodyOperation({
    content: recoveryBefore.content,
    operation: 'append_to_chapter',
    proposedText: '恢复段落'
  }).nextContent
  await harnessStore.writeUndoSnapshot(
    bookName,
    conversation.conversationId,
    interrupted.proposal.proposalId,
    {
      proposalId: interrupted.proposal.proposalId,
      content: fs.readFileSync(chapterPath, 'utf8'),
      contentHash: recoveryBefore.rawHash,
      createdAt: new Date().toISOString()
    }
  )
  const recoveryWrite = await service.writeChapterWithExpectedHash({
    bookName,
    volumeName,
    chapterName,
    expectedHash: recoveryBefore.rawHash,
    content: recoveryNext
  })
  const storedForRecovery = await harnessStore.readWriteProposals(
    bookName,
    conversation.conversationId
  )
  const interruptedRecord = storedForRecovery.find(
    (item) => item.proposalId === interrupted.proposal.proposalId
  )
  interruptedRecord.status = 'applying'
  interruptedRecord.appliedHash = recoveryWrite.contentHash
  interruptedRecord.undoSnapshotRef = `proposal:${interrupted.proposal.proposalId}`
  await harnessStore.writeWriteProposals(
    bookName,
    conversation.conversationId,
    storedForRecovery
  )
  const recovered = (
    await proposalService.list({ bookName, conversationId: conversation.conversationId })
  ).find((item) => item.proposalId === interrupted.proposal.proposalId)
  assert.equal(recovered.status, 'applied', '异常退出后应根据磁盘哈希收敛为 applied')
  const recoveredUndo = await proposalService.undo({
    bookName,
    conversationId: conversation.conversationId,
    proposalId: interrupted.proposal.proposalId
  })
  assert.equal(recoveredUndo.proposal.status, 'undone')

  console.log('harness body-write proposal workflow checks passed')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
