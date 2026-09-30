import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import BookSandboxService from '../src/main/harness/sandbox/bookSandboxService.js'
import BookDocumentService from '../src/main/harness/documents/bookDocumentService.js'
import ReadSnapshotLedger from '../src/main/harness/documents/readSnapshotLedger.js'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import DocumentWriteProposalService from '../src/main/harness/write/documentWriteProposalService.js'
import { createDocumentTools } from '../src/main/harness/tools/documentTools.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import { parseKnowledgeMarkdown } from '../src/main/services/knowledgeMarkdownParser.js'

function digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), '51mazi-document-proposals-'))
try {
  const book = path.join(temp, '甲书')
  const characters = path.join(book, 'knowledge', 'characters')
  const settings = path.join(book, 'knowledge', 'settings')
  const outlines = path.join(book, 'knowledge', 'outlines')
  fs.mkdirSync(characters, { recursive: true })
  fs.mkdirSync(settings, { recursive: true })
  fs.mkdirSync(outlines, { recursive: true })
  fs.mkdirSync(path.join(book, '正文', '第一卷'), { recursive: true })

  const original = `---\r\ntitle: 林舟\r\nid: char_001\r\ntype: character\r\nstatus: confirmed\r\naliases: []\r\ntags: []\r\ncustomField: 保留\r\n---\r\n\r\n### 核心定位 <!-- 51:section=summary -->\r\n\r\n年轻的渡船人。\r\n\r\n### 当前状态 <!-- 51:section=current-state -->\r\n\r\n正在寻找同伴。\r\n\r\n### 已确认事实 <!-- 51:section=facts -->\r\n\r\n来自潮汐城。${'资料'.repeat(300)}\r\n\r\n### 自定义 <!-- 51:section=custom -->\r\n\r\n不可丢失。\r\n`
  const file = path.join(characters, 'char_001.md')
  fs.writeFileSync(file, original)
  fs.writeFileSync(path.join(book, '正文', '第一卷', '开端.txt'), '不能被 P3 修改')

  const reference = `character:char_001#document@${digest(Buffer.from(original))}`
  const retrievalService = {
    listBookStructure(_book, scopes) {
      return {
        characters: scopes.includes('characters')
          ? [
              {
                targetId: 'char_001',
                path: 'knowledge/characters/char_001.md',
                title: '林舟',
                authorityStatus: 'authoritative_saved',
                reference
              }
            ]
          : [],
        settings: [],
        outlines: [],
        chapters: [],
        notes: []
      }
    },
    searchBookKnowledge() {
      return { results: [] }
    },
    readBookBacklinks(_book, value) {
      return { reference: value, target: {}, backlinks: [] }
    },
    readOutlineContext() {
      return { requested: {}, documents: [] }
    }
  }
  const snapshotService = {
    getBooksDir: () => temp,
    resolveBookPath(name) {
      return path.join(temp, name)
    }
  }
  const sandbox = new BookSandboxService({ booksDirProvider: temp })
  const documentService = new BookDocumentService({ sandboxService: sandbox, retrievalService })
  const ledger = new ReadSnapshotLedger()
  const store = new HarnessStore({ snapshotService, sandboxService: sandbox })
  const state = await store.createConversation({ bookKey: '甲书', title: 'P3' })
  const context = {
    conversationId: state.conversationId,
    turnId: 'turn_p3',
    bookScope: sandbox.bindBook('甲书', { conversationId: state.conversationId, turnId: 'turn_p3' })
  }
  const proposals = new DocumentWriteProposalService({
    store,
    documentService,
    readSnapshotLedger: ledger
  })
  const registry = new DomainToolRegistry()
  createDocumentTools({ documentService, proposalService: proposals }).forEach((tool) =>
    registry.register(tool)
  )

  let page = await registry.execute('read', context, {
    path: 'book/knowledge/characters/char_001.md',
    maxChars: 512
  })
  let sequence = 1
  ledger.recordDelivery(context, page, { deliverySequence: sequence++ })
  while (page.data.nextCursor) {
    page = await registry.execute('read', context, {
      path: 'book/knowledge/characters/char_001.md',
      cursor: page.data.nextCursor,
      maxChars: 512
    })
    ledger.recordDelivery(context, page, { deliverySequence: sequence++ })
  }
  const originalHash = digest(fs.readFileSync(file))

  const createContent = `---\ntitle: 潮汐城\nkind: location\n---\n\n### 定义 <!-- 51:section=definition -->\n\n沿海城镇。\n\n### 规则与边界 <!-- 51:section=rules -->\n\n每天开闭水门。\n\n### 已确认事实 <!-- 51:section=facts -->\n\n待补充。\n`
  const created = await registry.execute('create', context, {
    directory: 'book/knowledge/settings/',
    content: createContent,
    basis: 'creative'
  })
  assert.equal(created.ok, true)
  assert.equal(created.data.status, 'pending_confirmation')
  assert.equal(fs.readdirSync(settings).length, 0)
  const frozenCreate = await proposals.readFrozenCandidate(context, created.data.proposalId)
  const parsedCreate = parseKnowledgeMarkdown(frozenCreate.bytes.toString('utf8'))
  assert.equal(parsedCreate.metadata.type, 'setting')
  assert.equal(parsedCreate.metadata.id, created.data.target.documentId)
  assert.equal(parsedCreate.metadata.status, 'draft')
  assert.equal(parsedCreate.metadata.aliases.length, 0)

  const createdCharacter = await registry.execute('create', context, {
    directory: 'book/knowledge/characters/',
    content: `---\ntitle: 新人物\n---\n\n### 核心定位 <!-- 51:section=summary -->\n\n定位。\n\n### 当前状态 <!-- 51:section=current-state -->\n\n状态。\n\n### 已确认事实 <!-- 51:section=facts -->\n\n事实。\n`,
    basis: 'creative'
  })
  assert.equal(createdCharacter.ok, true)
  assert.equal(createdCharacter.data.target.type, 'character')
  const createdOutline = await registry.execute('create', context, {
    directory: 'book/knowledge/outlines/',
    content: `---\ntitle: 新大纲\n---\n\n### 核心内容 <!-- 51:section=summary -->\n\n内容。\n\n### 展开说明 <!-- 51:section=details -->\n\n说明。\n\n### 约束与结果 <!-- 51:section=constraints -->\n\n约束。\n`,
    basis: 'creative'
  })
  assert.equal(createdOutline.ok, true)
  assert.equal(createdOutline.data.target.type, 'outline')
  assert.equal(fs.readdirSync(characters).length, 1)
  assert.equal(fs.readdirSync(outlines).length, 0)

  const replacement = original.replace('正在寻找同伴。', '已经找到同伴。').replace(/\r\n/g, '\n')
  const written = await registry.execute('write', context, {
    path: 'book/knowledge/characters/char_001.md',
    content: replacement,
    basis: 'source_grounded',
    sources: [reference]
  })
  assert.equal(written.ok, true, JSON.stringify(written))
  const frozenWrite = await proposals.readFrozenCandidate(context, written.data.proposalId)
  assert.equal(frozenWrite.bytes.toString('utf8'), replacement)
  assert.equal(
    parseKnowledgeMarkdown(frozenWrite.bytes.toString('utf8')).metadata.customField,
    '保留'
  )
  assert.equal(digest(fs.readFileSync(file)), originalHash)

  const edited = await registry.execute('edit', context, {
    path: 'book/knowledge/characters/char_001.md',
    edits: [
      { oldText: '年轻的渡船人。', newText: '年轻而谨慎的渡船人。' },
      { oldText: '不可丢失。', newText: '仍然不可丢失。' }
    ],
    basis: 'creative'
  })
  assert.equal(edited.ok, true)
  const frozenEdit = await proposals.readFrozenCandidate(context, edited.data.proposalId)
  const editedText = frozenEdit.bytes.toString('utf8')
  assert(editedText.includes('年轻而谨慎的渡船人。'))
  assert(editedText.includes('仍然不可丢失。'))
  assert(editedText.includes('\r\n'))
  assert.equal(
    editedText
      .replace('年轻而谨慎的渡船人。', '年轻的渡船人。')
      .replace('仍然不可丢失。', '不可丢失。'),
    original
  )
  assert.equal(digest(fs.readFileSync(file)), originalHash)

  const beforeFailures = (await proposals.list(context)).length
  const ambiguous = await registry.execute('edit', context, {
    path: 'book/knowledge/characters/char_001.md',
    edits: [{ oldText: '###', newText: '##' }],
    basis: 'creative'
  })
  assert.equal(ambiguous.error.code, 'EDIT_NOT_UNIQUE')
  const overlap = await registry.execute('edit', context, {
    path: 'book/knowledge/characters/char_001.md',
    edits: [
      { oldText: '年轻的渡船人。', newText: '甲' },
      { oldText: '渡船人', newText: '乙' }
    ],
    basis: 'creative'
  })
  assert.equal(overlap.error.code, 'EDIT_OVERLAP')
  const identityChange = await registry.execute('write', context, {
    path: 'book/knowledge/characters/char_001.md',
    content: replacement.replace('id: char_001', 'id: char_other'),
    basis: 'creative'
  })
  assert.equal(identityChange.error.code, 'DOCUMENT_FORMAT_INVALID')
  const unsupported = await registry.execute('write', context, {
    path: 'book/chapters/第一卷/开端.txt',
    content: '不应修改',
    basis: 'creative'
  })
  assert.equal(unsupported.error.code, 'FULL_READ_REQUIRED')
  assert.equal((await proposals.list(context)).length, beforeFailures)
  assert.equal(digest(fs.readFileSync(file)), originalHash)
  assert.equal(
    fs.readFileSync(path.join(book, '正文', '第一卷', '开端.txt'), 'utf8'),
    '不能被 P3 修改'
  )

  const partialContext = {
    ...context,
    turnId: 'turn_partial',
    bookScope: sandbox.bindBook('甲书', {
      conversationId: state.conversationId,
      turnId: 'turn_partial'
    })
  }
  const partial = await registry.execute('read', partialContext, {
    path: 'book/knowledge/characters/char_001.md',
    maxChars: 512
  })
  ledger.recordDelivery(partialContext, partial, { deliverySequence: 1 })
  const partialWrite = await registry.execute('write', partialContext, {
    path: 'book/knowledge/characters/char_001.md',
    content: replacement,
    basis: 'creative'
  })
  assert.equal(partialWrite.error.code, 'FULL_READ_REQUIRED')
  const uncoveredEdit = await registry.execute('edit', partialContext, {
    path: 'book/knowledge/characters/char_001.md',
    edits: [{ oldText: '不可丢失。', newText: '不应创建候选。' }],
    basis: 'creative'
  })
  assert.equal(uncoveredEdit.error.code, 'FULL_READ_REQUIRED')
  const unreadEdit = await registry.execute('edit', partialContext, {
    path: 'book/knowledge/characters/char_001.md',
    edits: [{ oldText: '不可丢失。', newText: '不能丢失。' }],
    basis: 'creative'
  })
  assert.equal(unreadEdit.error.code, 'FULL_READ_REQUIRED')

  // A real list -> batch read -> outline proposal, using human-readable paths.
  const outlineText = (id, title) => `---\nid: ${id}\ntype: outline\ntitle: ${title}\nstatus: planned\ntags: []\norder: 1\nrelatedOutlines: []\nchapterRefs: []\ncharacterRefs: []\nsettingRefs: []\n---\n\n### 核心内容 <!-- 51:section=summary -->\n\n原计划。\n\n### 展开说明 <!-- 51:section=details -->\n\n说明。\n\n### 约束与结果 <!-- 51:section=constraints -->\n\n约束。\n`
  const outlineItems = [
    { targetId: 'o_root', title: '全书总纲', path: 'knowledge/outlines/o_root.md' },
    { targetId: 'o_four', title: '第四章', path: 'knowledge/outlines/o_four.md' },
    { targetId: 'o_dup1', title: '同名', path: 'knowledge/outlines/o_dup1.md' },
    { targetId: 'o_dup2', title: '同名', path: 'knowledge/outlines/o_dup2.md' }
  ]
  for (const item of outlineItems) fs.writeFileSync(path.join(book, item.path), outlineText(item.targetId, item.title))
  const originalList = retrievalService.listBookStructure.bind(retrievalService)
  retrievalService.listBookStructure = (name, scopes) => ({ ...originalList(name, scopes), outlines: scopes.includes('outlines') ? outlineItems : [] })
  const manifest = await registry.execute('list_files', context, { path: 'book/knowledge/outlines/' })
  assert.equal(manifest.ok, true, JSON.stringify(manifest))
  assert.equal(manifest.data.total, 4)
  assert(manifest.data.items.some((item) => item.path === 'book/knowledge/outlines/第四章.md'))
  const duplicates = manifest.data.items.filter((item) => item.title === '同名')
  assert.equal(new Set(duplicates.map((item) => item.path)).size, 2)
  for (const item of duplicates) assert.equal((await registry.execute('read', context, { path: item.path })).ok, true)
  const batch = await registry.execute('read', context, { paths: ['book/knowledge/outlines/全书总纲.md', 'book/knowledge/outlines/第四章.md'] })
  assert.equal(batch.ok, true, JSON.stringify(batch))
  assert.equal(batch.data.complete, true)
  ledger.recordDelivery(context, batch, { deliverySequence: 100 })
  const planEdit = await registry.execute('edit', context, {
    path: 'book/knowledge/outlines/全书总纲.md', edits: [{ oldText: '原计划。', newText: '汇总第四章计划。' }],
    basis: 'source_grounded', sources: ['book/knowledge/outlines/第四章.md']
  })
  assert.equal(planEdit.ok, true, JSON.stringify(planEdit))
  const planAsFact = await registry.execute('create', context, { directory: 'book/knowledge/settings/', content: createContent, basis: 'source_grounded', sources: ['book/knowledge/outlines/第四章.md'] })
  assert.equal(planAsFact.error.code, 'KNOWLEDGE_EVIDENCE_NOT_READ')
  const mixedBatch = await registry.execute('read', context, { paths: ['book/knowledge/outlines/第四章.md', 'book/knowledge/outlines/missing.md'] })
  assert.equal(mixedBatch.data.items[0].ok, true)
  assert.equal(mixedBatch.data.items[1].ok, false)
  assert.equal(mixedBatch.data.complete, false)
  const partialBatch = await registry.execute('read', context, { paths: ['book/knowledge/outlines/第四章.md'], maxChars: 512 })
  assert.equal(partialBatch.ok, true)
  // Long files must expose continuation rather than silently count as fully read.
  fs.writeFileSync(path.join(outlines, 'o_four.md'), outlineText('o_four', '第四章') + '长内容'.repeat(5000))
  const longBatch = await registry.execute('read', context, { paths: ['book/knowledge/outlines/第四章.md'], maxChars: 512 })
  assert.equal(longBatch.data.complete, false)
  assert(longBatch.data.items[0].data.nextCursor)
  const continuation = await registry.execute('read', context, { cursor: longBatch.data.items[0].data.nextCursor })
  assert.equal(continuation.data.returnedCoverage.startOffset, 512)
  assert.equal((await registry.execute('read', context, { paths: ['book/knowledge/outlines/第四章.md'], maxChars: 10 })).ok, false)
  const invalidBatch = await registry.execute('read', context, { path: 'book/', paths: ['help/index.md'] })
  assert.equal(invalidBatch.error.code, 'TOOL_ARGUMENT_INVALID')
  outlineItems.push({ targetId: 'o_long', title: '长标题'.repeat(60), path: 'knowledge/outlines/o_long.md' })
  fs.writeFileSync(path.join(outlines, 'o_long.md'), outlineText('o_long', '长标题'.repeat(60)))
  const shortList = await registry.execute('list_files', context, { path: 'book/knowledge/outlines/', maxChars: 512 })
  assert.equal(shortList.data.complete, false)
  let nextList = shortList
  const listed = [...shortList.data.items]
  while (nextList.data.nextCursor) {
    const args = { cursor: nextList.data.nextCursor }
    nextList = await registry.execute('list_files', context, args)
    assert.equal(nextList.ok, true)
    const retry = await registry.execute('list_files', context, args)
    assert.deepEqual(retry.data, nextList.data)
    listed.push(...nextList.data.items)
  }
  assert.equal(listed.length, 5)
  assert.equal(new Set(listed.map((item) => item.path)).size, 5)
  const wrongTool = await registry.execute('read', context, { cursor: shortList.data.nextCursor })
  assert.equal(wrongTool.error.code, 'CURSOR_INVALID')


  console.log('harness-document-proposals-test: ok')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
