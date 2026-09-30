import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Ajv from 'ajv'
import BookSandboxService from '../src/main/harness/sandbox/bookSandboxService.js'
import BookDocumentService from '../src/main/harness/documents/bookDocumentService.js'
import ReadSnapshotLedger from '../src/main/harness/documents/readSnapshotLedger.js'
import { createDocumentTools } from '../src/main/harness/tools/documentTools.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import { documentToolContracts } from '../src/main/harness/tools/contracts/documentToolContracts.js'
import ContextAssembler from '../src/main/harness/context/contextAssembler.js'
import { safeWorkspace } from '../src/main/harness/context/workspaceContext.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), '51mazi-document-tools-'))
try {
  const bookA = path.join(temp, '甲书')
  const bookB = path.join(temp, '乙书')
  fs.mkdirSync(path.join(bookA, 'knowledge', 'characters'), { recursive: true })
  fs.mkdirSync(path.join(bookA, '正文', '第一卷'), { recursive: true })
  fs.mkdirSync(path.join(bookA, '.51mazi', 'notes'), { recursive: true })
  fs.mkdirSync(bookB, { recursive: true })
  const characterText = `---\r\ntitle: 林舟\r\nid: char_001\r\ntype: character\r\nstatus: confirmed\r\naliases: []\r\ntags: []\r\n---\r\n\r\n### 核心定位 <!-- 51:section=summary -->\r\n\r\n${'潮'.repeat(700)}😀${'舟'.repeat(900)}`
  fs.writeFileSync(path.join(bookA, 'knowledge', 'characters', 'char_001.md'), characterText)
  fs.writeFileSync(path.join(bookA, '正文', '第一卷', '开端.txt'), '第一行\r\n第二行😀\r\n')
  fs.writeFileSync(path.join(bookA, '.51mazi', 'notes', 'quick-notes.md'), '# 速记\n私有构思')

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
                reference: 'character:char_001@sha256:' + 'a'.repeat(64)
              }
            ]
          : [],
        settings: [],
        outlines: [],
        chapters: scopes.includes('chapters')
          ? [
              {
                targetId: '第一卷/开端.txt',
                relativePath: '第一卷/开端.txt',
                title: '开端',
                reference:
                  'chapter:%E7%AC%AC%E4%B8%80%E5%8D%B7%2F%E5%BC%80%E7%AB%AF.txt@sha256:' +
                  'b'.repeat(64)
              }
            ]
          : [],
        notes: []
      }
    },
    searchBookKnowledge(_book, query) {
      return {
        results: [
          {
            sourceType: 'character',
            targetId: 'char_001',
            title: '林舟',
            snippet: `命中：${query}`,
            authorityStatus: 'authoritative_saved',
            reference: 'character:char_001@sha256:' + 'a'.repeat(64),
            score: 0.9
          }
        ]
      }
    },
    readBookBacklinks(_book, reference) {
      return {
        reference,
        target: { type: 'character', id: 'char_001' },
        backlinks: [],
        truncated: false
      }
    },
    readOutlineContext() {
      return {
        requested: { sourceType: 'outline', targetId: 'o1' },
        documents: [],
        truncated: false
      }
    }
  }
  const conversationRetrievalService = {
    async listConversationStructure() {
      return [{ targetId: 'conv-中文', title: '讨论', updatedAt: '2026-09-12T00:00:00.000Z' }]
    },
    async search(_book, query) {
      return {
        results: [
          {
            targetId: 'conv-中文',
            title: '讨论',
            snippet: `历史：${query}`,
            reference: 'conversation:conv-%E4%B8%AD%E6%96%87#turn:t1@sha256:' + 'c'.repeat(64),
            score: 0.5
          }
        ]
      }
    },
    async readConversationDocument() {
      return {
        targetId: 'conv-中文',
        title: '讨论',
        text: '用户：只保留公开对话\n\n助手：已记录',
        contentHash: 'sha256:' + 'c'.repeat(64),
        authorityStatus: 'unconfirmed_conversation',
        reference: 'conversation:conv-%E4%B8%AD%E6%96%87@sha256:' + 'c'.repeat(64)
      }
    }
  }
  const sandbox = new BookSandboxService({ booksDirProvider: temp })
  const service = new BookDocumentService({
    sandboxService: sandbox,
    retrievalService,
    conversationRetrievalService
  })
  const scopeA = sandbox.bindBook('甲书')
  const scopeB = sandbox.bindBook('乙书')
  const contextA = { bookKey: '甲书', conversationId: 'c1', turnId: 't1', bookScope: scopeA }

  const root = await service.read(contextA, { path: 'book/' })
  assert.equal(root.data.kind, 'directory')
  assert(root.data.items.some((item) => item.path === 'book/knowledge/'))

  // Reproduce the editor's storage-relative outline address, then read the
  // backend-generated address exactly as it is delivered to the model.
  const outlineId = 'outline_1789652860373_a3cd63dc'
  fs.mkdirSync(path.join(bookA, 'knowledge', 'outlines'), { recursive: true })
  fs.writeFileSync(path.join(bookA, 'knowledge', 'outlines', `${outlineId}.md`), '# 总纲\n当前书的大纲')
  await assert.rejects(service.read(contextA, { path: `knowledge/outlines/${outlineId}.md` }),
    (error) => error.code === 'VIRTUAL_PATH_REQUIRED' && error.nextAction.includes('toolPath'))
  await assert.rejects(service.read(contextA, { path: '.51mazi/harness/v1/conversations.json' }), { code: 'PATH_OUTSIDE_BOOK' })
  await assert.rejects(service.read(contextA, { path: 'knowledge/../乙书/secret.md' }), { code: 'PATH_OUTSIDE_BOOK' })
  const assembled = new ContextAssembler().assemble({
    workspace: safeWorkspace({
      currentModule: 'outlines-knowledge-v2', currentDocumentId: outlineId,
      metadata: { knowledge_scope: 'outlines', knowledge_document_id: outlineId, source_file: `knowledge/outlines/${outlineId}.md` }
    }),
    userText: '读取当前总纲'
  })
  const outlinePath = /^toolPath=(.+)$/m.exec(assembled.layers.currentWorkspace)[1]
  const outline = await service.read(contextA, { path: outlinePath })
  assert.equal(outline.data.text, '# 总纲\n当前书的大纲')
  await assert.rejects(service.read({ ...contextA, bookScope: scopeB }, { path: outlinePath }), { code: 'DOCUMENT_NOT_FOUND' })

  fs.mkdirSync(path.join(bookA, '正文', '第二卷 空卷'))
  const volumes = await service.read(contextA, { path: 'book/chapters/' })
  const emptyVolume = volumes.data.items.find((item) => item.name === '第二卷 空卷')
  assert.equal(emptyVolume.path, 'book/chapters/第二卷 空卷/')
  assert.deepEqual((await service.read(contextA, { path: emptyVolume.path })).data.items, [])
  assert.deepEqual((await service.read({ ...contextA, bookScope: scopeB }, { path: 'book/chapters/' })).data.items, [])
  for (const args of [{ path: 'book/chapters/不存在的卷/' }, { path: 'book/chapters/不存在的卷/', query: '开端' }])
    await assert.rejects(service.read(contextA, args), { code: 'DOCUMENT_NOT_FOUND' })
  const chapters = await service.read(contextA, { path: 'book/chapters/第一卷/' })
  assert.equal(chapters.data.items[0].path, 'book/chapters/第一卷/开端.txt')
  assert.equal((await service.read(contextA, { path: chapters.data.items[0].path })).data.text, '第一行\n第二行😀\n')
  // Directory discovery must validate entries before following them.
  const linkedVolume = path.join(bookA, '正文', '外部卷')
  fs.writeFileSync(path.join(bookB, 'secret.txt'), 'OTHER_BOOK_MARKER')
  fs.symlinkSync(bookB, linkedVolume, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    for (const args of [
      { path: 'book/chapters/' },
      { path: 'book/chapters/', query: 'OTHER_BOOK_MARKER' },
      { path: 'book/chapters/外部卷/' }
    ]) {
      await assert.rejects(service.read(contextA, args), (error) =>
        error.code === 'PATH_OUTSIDE_BOOK' && !error.message.includes('OTHER_BOOK_MARKER'))
    }
    assert.equal(fs.readFileSync(path.join(bookB, 'secret.txt'), 'utf8'), 'OTHER_BOOK_MARKER')
  } finally {
    fs.unlinkSync(linkedVolume)
  }

  const chinese = await service.read(contextA, { path: 'book/knowledge/characters/' })
  assert.equal(chinese.data.items[0].path, 'book/knowledge/characters/char_001.md')
  const searched = await service.read(contextA, {
    path: 'book/knowledge/characters/',
    query: '林舟'
  })
  assert.equal(searched.data.kind, 'search')
  assert.equal(searched.data.items[0].path, 'book/knowledge/characters/char_001.md')

  const originalSearch = service.search
  service.search = async () => Array.from({ length: 12 }, (_, index) => ({
    path: `book/knowledge/characters/item-${index}.md`, title: '查询命中'.repeat(30), index
  }))
  try {
    const firstSearch = await service.read(contextA, { path: 'book/knowledge/characters/', query: '林舟', maxChars: 512 })
    const secondSearch = await service.read(contextA, { cursor: firstSearch.data.nextCursor })
    assert.equal(secondSearch.data.query, '林舟', '短游标恢复原查询')
    assert.equal(secondSearch.data.items[0].index, firstSearch.data.items.length)
    assert.equal(secondSearch.data.items.length, firstSearch.data.items.length, '短游标保留分页大小')
    assert.deepEqual(await service.read(contextA, { cursor: firstSearch.data.nextCursor }), secondSearch)
    service.search = async () => []
    await assert.rejects(service.read(contextA, { cursor: firstSearch.data.nextCursor }), { code: 'READ_VERSION_CHANGED' })
  } finally { service.search = originalSearch }

  let page = await service.read(contextA, {
    path: 'book/knowledge/characters/char_001.md',
    maxChars: 512
  })
  assert.match(page.data.nextCursor, /^r[a-f0-9]{8}-[a-z0-9]+$/)
  assert.ok(page.data.nextCursor.length < 24)
  const cursorOnlyArgs = { cursor: page.data.nextCursor }
  assert.equal(new Ajv().compile(documentToolContracts.find((item) => item.name === 'read').inputSchema)(cursorOnlyArgs), true)
  const cursorOnly = await service.read(contextA, cursorOnlyArgs)
  assert.equal(cursorOnly.data.returnedCoverage.startOffset, 512)
  assert.equal(cursorOnly.data.returnedCoverage.endOffset, 1024)
  assert.deepEqual(await service.read(contextA, cursorOnlyArgs), cursorOnly, '重试同一游标返回相同页和后续游标')
  for (const other of [{ ...contextA, conversationId: 'other' }, { ...contextA, turnId: 'other' }])
    await assert.rejects(service.read(other, cursorOnlyArgs), { code: 'CURSOR_INVALID' })
  await assert.rejects(service.listFiles(contextA, cursorOnlyArgs), { code: 'CURSOR_INVALID' })
  await assert.rejects(service.read(contextA, { cursor: 'not-a-cursor' }),
    (error) => error.code === 'CURSOR_INVALID' && error.retryable && error.nextAction.includes('path'))
  await assert.rejects(service.read(contextA, { ...cursorOnlyArgs, query: 'changed' }), { code: 'CURSOR_INVALID' })
  const expiresAt = service.cursors.get(cursorOnlyArgs.cursor).expiresAt
  service.cursors.get(cursorOnlyArgs.cursor).expiresAt = 0
  await assert.rejects(service.read(contextA, cursorOnlyArgs), { code: 'CURSOR_INVALID' })
  service.cursors.get(cursorOnlyArgs.cursor).expiresAt = expiresAt
  const restarted = new BookDocumentService({ sandboxService: sandbox, retrievalService, conversationRetrievalService })
  await assert.rejects(restarted.read(contextA, cursorOnlyArgs), { code: 'CURSOR_INVALID' })
  const pages = [page]
  while (page.data.nextCursor) {
    page = await service.read(contextA, {
      cursor: page.data.nextCursor
    })
    pages.push(page)
  }
  const delivered = pages.map((item) => item.data.text).join('')
  assert.equal(delivered, characterText.replace(/\r\n|\r/g, '\n'))
  assert(!delivered.includes('\uFFFD'))
  assert.equal(pages.at(-1).data.complete, true)
  assert(pages.every((item) => item.data.evidenceEligible))
  const frozen = service.getSnapshot(contextA, pages[0].data.path, pages[0].data.savedHash)
  assert.equal(frozen.raw.toString('utf8'), characterText)

  await assert.rejects(
    () =>
      service.read(
        { ...contextA, bookKey: '乙书', bookScope: scopeB },
        {
          path: 'book/knowledge/characters/char_001.md',
          cursor: pages[0].data.nextCursor,
          maxChars: 512
        }
      ),
    (error) => error.code === 'CURSOR_INVALID'
  )
  await assert.rejects(
    () =>
      service.read(contextA, {
        path: 'book/chapters/第一卷/开端.txt',
        cursor: pages[0].data.nextCursor,
        maxChars: 512
      }),
    (error) => error.code === 'CURSOR_INVALID'
  )

  const staleFirst = await service.read(contextA, {
    path: 'book/knowledge/characters/char_001.md',
    maxChars: 512
  })
  fs.appendFileSync(path.join(bookA, 'knowledge', 'characters', 'char_001.md'), '\n版本变化')
  await assert.rejects(
    () =>
      service.read(contextA, {
        path: 'book/knowledge/characters/char_001.md',
        cursor: staleFirst.data.nextCursor,
        maxChars: 512
      }),
    (error) => error.code === 'READ_VERSION_CHANGED'
  )

  const help = await service.read(contextA, { path: 'help/settings.md' })
  assert.equal(help.data.kind, 'help')
  assert.equal(help.data.evidenceEligible, false)
  assert.match(help.data.text, /location/)
  const conversation = await service.read(contextA, {
    path: 'book/conversations/conv-%E4%B8%AD%E6%96%87.md'
  })
  assert.equal(conversation.data.authorityStatus, 'unconfirmed_conversation')
  assert.equal(conversation.data.evidenceEligible, false)
  assert(!conversation.data.text.includes('.51mazi'))

  const ledger = new ReadSnapshotLedger()
  for (let index = 0; index < pages.length; index += 1)
    ledger.recordDelivery(contextA, { ok: true, ...pages[index] }, { deliverySequence: index + 1 })
  const entry = ledger.find(contextA, pages[0].data.path, pages[0].data.savedHash)
  assert.equal(entry.complete, true)
  assert.equal(ledger.hasFullRead(contextA, pages[0].data.path, pages[0].data.savedHash), true)
  assert.deepEqual(entry.ranges, [{ start: 0, end: delivered.length }])
  assert.equal(ledger.recordDelivery(contextA, { ok: true, ...searched }), null)
  assert.equal(ledger.recordDelivery(contextA, { ok: true, ...help }), null)

  const ajv = new Ajv({ strict: true, allErrors: true })
  assert.deepEqual(
    documentToolContracts.map((tool) => tool.name),
    ['read', 'create', 'write', 'edit', 'list_files']
  )
  for (const contract of documentToolContracts) assert(ajv.compile(contract.inputSchema))
  assert.equal(
    ajv.compile(documentToolContracts[0].inputSchema)({ path: 'book/', bookName: '甲书' }),
    false
  )
  const tools = createDocumentTools({ documentService: service })
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['read', 'create', 'write', 'edit', 'list_files']
  )
  const registry = new DomainToolRegistry()
  tools.forEach((tool) => registry.register(tool))
  const publicRead = await registry.execute('read', contextA, { path: 'help/index.md' })
  assert.equal(publicRead.ok, true)
  assert.equal('raw' in publicRead.data, false)
  const rejectedExtra = await registry.execute('read', contextA, {
    path: 'book/',
    bookName: '乙书'
  })
  assert.equal(rejectedExtra.error.code, 'TOOL_ARGUMENT_INVALID')
  const unsupportedWrite = await registry.execute('write', contextA, {
    path: 'book/chapters/第一卷/开端.txt',
    content: '不应写入'
  })
  assert.equal(unsupportedWrite.error.code, 'RESOURCE_NOT_SUPPORTED')
  assert.equal(
    fs.readFileSync(path.join(bookA, '正文', '第一卷', '开端.txt'), 'utf8'),
    '第一行\r\n第二行😀\r\n'
  )

  console.log('harness-document-tools-test: ok')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
