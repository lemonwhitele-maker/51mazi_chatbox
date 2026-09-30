import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import BookSandboxService from '../src/main/harness/sandbox/bookSandboxService.js'
import BookScopeRegistry from '../src/main/harness/sandbox/bookScopeRegistry.js'
import BookDocumentService from '../src/main/harness/documents/bookDocumentService.js'
import ReadSnapshotLedger from '../src/main/harness/documents/readSnapshotLedger.js'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import DocumentWriteProposalService from '../src/main/harness/write/documentWriteProposalService.js'

const digest = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
const root = fs.mkdtempSync(path.join(os.tmpdir(), '51mazi-p4-'))

try {
  const book = path.join(root, '甲书')
  const characters = path.join(book, 'knowledge', 'characters')
  const settings = path.join(book, 'knowledge', 'settings')
  fs.mkdirSync(characters, { recursive: true })
  fs.mkdirSync(settings, { recursive: true })
  const file = path.join(characters, 'char_001.md')
  const original = `---\r\ntitle: 林舟\r\nid: char_001\r\ntype: character\r\nstatus: confirmed\r\naliases: []\r\ntags: []\r\n---\r\n\r\n### 核心定位 <!-- 51:section=summary -->\r\n\r\n渡船人。\r\n\r\n### 当前状态 <!-- 51:section=current-state -->\r\n\r\n正在等待。\r\n\r\n### 已确认事实 <!-- 51:section=facts -->\r\n\r\n来自潮汐城。\r\n`
  fs.writeFileSync(file, original)

  const snapshotService = {
    getBooksDir: () => root,
    resolveBookPath: (name) => path.join(root, name)
  }
  const retrievalService = {
    listBookStructure: () => ({ characters: [], settings: [], outlines: [], chapters: [], notes: [] }),
    searchBookKnowledge: () => ({ results: [] })
  }
  const sandbox = new BookSandboxService({ booksDirProvider: root })
  const scopes = new BookScopeRegistry({ sandboxService: sandbox })
  const scope = scopes.bindBook({ senderId: 1, frameId: 10, bookName: '甲书' }).scope
  const otherWindow = scopes.bindBook({ senderId: 2, frameId: 20, bookName: '甲书' }).scope
  const documents = new BookDocumentService({ sandboxService: sandbox, retrievalService })
  const ledger = new ReadSnapshotLedger()
  const store = new HarnessStore({ snapshotService, sandboxService: sandbox })
  const state = await store.createConversation({ bookKey: '甲书', title: 'P4' })
  const context = { conversationId: state.conversationId, turnId: 'turn_p4', bookScope: scope }
  const service = new DocumentWriteProposalService({ store, documentService: documents, readSnapshotLedger: ledger })

  const page = await documents.read(context, { path: 'book/knowledge/characters/char_001.md' })
  ledger.recordDelivery(context, { ok: true, ...page }, { deliverySequence: 1 })
  const proposed = await service.edit(context, {
    path: 'book/knowledge/characters/char_001.md',
    edits: [{ oldText: '正在等待。', newText: '已经启程。' }],
    basis: 'creative'
  })
  assert.equal(fs.readFileSync(file, 'utf8'), original, '未确认不得修改正式文件')

  const listed = await service.list({ conversationId: state.conversationId, bookScope: scope })
  const proposal = listed.find((item) => item.proposalId === proposed.data.proposalId)
  assert.equal(proposal.preview.complete, true)
  assert.equal(proposal.preview.before, original)
  assert.match(proposal.preview.after, /已经启程/)
  const crossWindow = await service.list({
    conversationId: state.conversationId,
    bookScope: otherWindow,
    allowScopeRebind: (scopeId) => !scopes.isScopeActive(scopeId)
  })
  assert.equal(
    crossWindow.find((item) => item.proposalId === proposal.proposalId).confirmationAllowed,
    false,
    '原窗口仍有效时，另一窗口不能领取确认权限'
  )
  const credential = scopes.issueConfirmation(scope, proposal)
  const verified = scopes.verifyConfirmation({
    senderId: 1,
    frameId: 10,
    proposalId: proposal.proposalId,
    revision: proposal.revision,
    confirmationCredential: credential
  })
  assert.throws(
    () => scopes.verifyConfirmation({ senderId: 2, frameId: 20, proposalId: proposal.proposalId, revision: proposal.revision, confirmationCredential: credential }),
    { code: 'PROPOSAL_CONFIRMATION_INVALID' },
    '另一窗口不能重放确认凭据'
  )
  const applied = await service.apply(
    { conversationId: state.conversationId, bookScope: verified.scope },
    { proposalId: proposal.proposalId, revision: proposal.revision, candidateHash: verified.grant.candidateHash }
  )
  assert.equal(applied.proposal.status, 'applied')
  const appliedBytes = fs.readFileSync(file)
  assert.equal(digest(appliedBytes), proposal.candidateHash, '落盘字节必须与冻结候选一致')
  const replay = await service.apply(
    { conversationId: state.conversationId, bookScope: verified.scope },
    { proposalId: proposal.proposalId, revision: proposal.revision, candidateHash: verified.grant.candidateHash }
  )
  assert.equal(replay.contentHash, proposal.candidateHash, '重复确认必须幂等')

  const undone = await service.undo({ conversationId: state.conversationId, bookScope: scope }, proposal.proposalId)
  assert.equal(undone.proposal.status, 'undone')
  assert.deepEqual(fs.readFileSync(file), Buffer.from(original), '撤销必须恢复原始字节')

  const createResult = await service.create(context, {
    directory: 'book/knowledge/settings/',
    content: `---\ntitle: 潮汐城\nkind: location\n---\n\n### 定义 <!-- 51:section=definition -->\n\n城镇。\n\n### 规则与边界 <!-- 51:section=rules -->\n\n涨潮开门。\n\n### 已确认事实 <!-- 51:section=facts -->\n\n待确认。\n`,
    basis: 'creative'
  })
  const createdRecord = (await service.list({ conversationId: state.conversationId, bookScope: scope }))
    .find((item) => item.proposalId === createResult.data.proposalId)
  await service.apply(context, {
    proposalId: createdRecord.proposalId,
    revision: createdRecord.revision,
    candidateHash: createdRecord.candidateHash
  })
  const createdPath = path.join(settings, `${createdRecord.target.documentId}.md`)
  assert.equal(digest(fs.readFileSync(createdPath)), createdRecord.candidateHash)
  await service.undo(context, createdRecord.proposalId)
  assert.equal(fs.existsSync(createdPath), false, '撤销新建只删除该提案创建的目标')
  assert.equal(fs.existsSync(settings), true, '撤销新建不得删除父目录')

  const state2 = await store.createConversation({ bookKey: '甲书', title: '并发 P4' })
  const context2 = { conversationId: state2.conversationId, turnId: 'turn_p4_b', bookScope: scope }
  const read2 = await documents.read(context2, { path: 'book/knowledge/characters/char_001.md' })
  ledger.recordDelivery(context2, { ok: true, ...read2 }, { deliverySequence: 1 })
  const concurrentA = await service.edit(context, {
    path: 'book/knowledge/characters/char_001.md',
    edits: [{ oldText: '正在等待。', newText: '会话甲获胜。' }],
    basis: 'creative'
  })
  const concurrentB = await service.edit(context2, {
    path: 'book/knowledge/characters/char_001.md',
    edits: [{ oldText: '正在等待。', newText: '会话乙获胜。' }],
    basis: 'creative'
  })
  const [recordA] = (await service.list({ conversationId: state.conversationId, bookScope: scope }))
    .filter((item) => item.proposalId === concurrentA.data.proposalId)
  const [recordB] = (await service.list({ conversationId: state2.conversationId, bookScope: scope }))
    .filter((item) => item.proposalId === concurrentB.data.proposalId)
  const concurrent = await Promise.allSettled([
    service.apply(context, { proposalId: recordA.proposalId, revision: recordA.revision, candidateHash: recordA.candidateHash }),
    service.apply(context2, { proposalId: recordB.proposalId, revision: recordB.revision, candidateHash: recordB.candidateHash })
  ])
  assert.equal(concurrent.filter((item) => item.status === 'fulfilled').length, 1, '同一基线只能提交一个候选')
  const winner = concurrent[0].status === 'fulfilled'
    ? { context, record: recordA }
    : { context: context2, record: recordB }
  await service.undo(winner.context, winner.record.proposalId)

  const cancelRaceResult = await service.edit(context, {
    path: 'book/knowledge/characters/char_001.md',
    edits: [{ oldText: '正在等待。', newText: '确认取消竞态。' }],
    basis: 'creative'
  })
  const cancelRace = (await service.list({ conversationId: state.conversationId, bookScope: scope }))
    .find((item) => item.proposalId === cancelRaceResult.data.proposalId)
  const raced = await Promise.allSettled([
    service.apply(context, { proposalId: cancelRace.proposalId, revision: cancelRace.revision, candidateHash: cancelRace.candidateHash }),
    service.reject(context, cancelRace.proposalId, cancelRace.revision)
  ])
  assert.equal(raced.filter((item) => item.status === 'fulfilled').length, 1, '确认与取消只能产生一个终态')
  const racedRecord = await service.findRecord('甲书', state.conversationId, cancelRace.proposalId)
  assert(['applied', 'rejected'].includes(racedRecord.status))
  if (racedRecord.status === 'applied') await service.undo(context, racedRecord.proposalId)

  const recoveryResult = await service.edit(context, {
    path: 'book/knowledge/characters/char_001.md',
    edits: [{ oldText: '正在等待。', newText: '恢复候选。' }],
    basis: 'creative'
  })
  const records = await store.readDocumentProposals('甲书', state.conversationId)
  const recovering = records.find((item) => item.proposalId === recoveryResult.data.proposalId)
  await store.writeUndoSnapshot('甲书', state.conversationId, recovering.proposalId, {
    proposalId: recovering.proposalId,
    baseExists: true,
    contentBase64: Buffer.from(original).toString('base64'),
    contentHash: digest(Buffer.from(original))
  })
  recovering.status = 'applying'
  fs.writeFileSync(file, await store.readDocumentCandidate('甲书', state.conversationId, recovering.proposalId))
  await store.writeDocumentProposals('甲书', state.conversationId, records)
  const recovered = await service.list({ conversationId: state.conversationId, bookScope: scope })
  assert.equal(recovered.find((item) => item.proposalId === recovering.proposalId).status, 'applied')
  await service.undo(context, recovering.proposalId)
  assert.deepEqual(fs.readFileSync(file), Buffer.from(original))

  console.log('harness-document-confirmation-test: ok')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
