import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import BookSavedSnapshotService, {
  parseSourceReference
} from '../src/main/services/bookSavedSnapshotService.js'
import BookKnowledgeCatalogService from '../src/main/services/bookKnowledgeCatalogService.js'
import BookReferenceIndexService from '../src/main/services/bookReferenceIndexService.js'
import BookSearchIndexService from '../src/main/services/bookSearchIndexService.js'
import BookRetrievalService from '../src/main/services/bookRetrievalService.js'
import KnowledgeDocumentService from '../src/main/services/knowledgeDocumentService.js'
import { createBookReadTools } from '../src/main/harness/tools/bookReadTools.js'

const fixtureBook = fileURLToPath(
  new URL('./fixtures/knowledge-documents-v2/中文书籍', import.meta.url)
)
const tempRoot = fs.mkdtempSync(join(os.tmpdir(), '51mazi-knowledge-phase1-'))
const bookName = '中文书籍'
const bookPath = join(tempRoot, bookName)

function copyDirectory(sourceDirectory, targetDirectory) {
  fs.mkdirSync(targetDirectory, { recursive: true })
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = join(sourceDirectory, entry.name)
    const targetPath = join(targetDirectory, entry.name)
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath)
    else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath)
  }
}

function write(filePath, content) {
  fs.mkdirSync(join(filePath, '..'), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

try {
  copyDirectory(fixtureBook, bookPath)
  write(
    join(bookPath, '正文', '第一卷', 'chapter_01.txt'),
    '林昕来到 [[setting:setting_01|字丑科技]]。\n甲方公司要求复核事故报告。\n'
  )
  write(join(bookPath, '.51mazi', 'notes', 'quick-notes.md'), '# 待办\n\n继续调查字丑科技。\n')
  write(
    join(bookPath, 'knowledge', 'settings', 'setting_02.md'),
    `---
id: setting_02
type: setting
kind: organization
title: 字丑科技
status: confirmed
aliases: [第二家公司]
tags: [测试]
---

### 定义 <!-- 51:section=definition -->

同名但不同 ID 的组织。

### 规则 <!-- 51:section=rules -->

无。

### 已确认事实 <!-- 51:section=facts -->

无。
`
  )

  const snapshotService = new BookSavedSnapshotService({ booksDirProvider: tempRoot })
  const catalogService = new BookKnowledgeCatalogService({ snapshotService })
  const referenceIndexService = new BookReferenceIndexService({
    snapshotService,
    catalogService
  })
  const searchIndexService = new BookSearchIndexService({
    snapshotService,
    catalogService
  })
  const retrievalService = new BookRetrievalService({
    snapshotService,
    catalogService,
    referenceIndexService,
    searchIndexService
  })

  console.log('knowledge phase1: catalog rebuild')
  const catalogs = catalogService.rebuildBook(bookName)
  assert.equal(catalogs.chapters.entries.length, 1)
  assert.equal(catalogs.characters.entries.length, 1)
  assert.equal(catalogs.settings.entries.length, 2)
  assert.equal(
    catalogs.outlines.entries.every((entry) => entry.type === 'outline'),
    true
  )
  assert.equal(catalogs.notes.entries.length, 1)
  assert.equal(catalogs.settings.lookup['字丑科技'].length, 2)
  assert.equal(
    catalogs.settings.entries.every((entry) => entry.ambiguous),
    true
  )
  assert.doesNotMatch(JSON.stringify(catalogs.settings), /事故报告必须经过两人复核/)
  for (const name of [
    'chapters.catalog.json',
    'characters.catalog.json',
    'settings.catalog.json',
    'outlines.catalog.json',
    'notes.catalog.json'
  ]) {
    assert.equal(fs.existsSync(join(bookPath, '.51mazi', 'index', 'v2', name)), true)
  }

  console.log('knowledge phase1: character highlight projection')
  const documentService = new KnowledgeDocumentService({
    snapshotService,
    onCommitted: ({ bookName: changedBook, scope }) => {
      catalogService.invalidate(changedBook)
      catalogService.buildCatalog(changedBook, scope, { force: true })
    }
  })
  const duncan = await documentService.createDocument({
    bookName,
    scope: 'characters',
    title: '邓肯'
  })
  const characterProfiles = catalogService.listCharacterProfiles(bookName)
  assert.ok(
    characterProfiles.some(
      (item) => item.id === duncan.documentId && item.name === '邓肯' && item.markdownFile
    )
  )
  assert.equal(/邓肯/gi.test('【邓肯】'), true)

  fs.rmSync(join(bookPath, '.51mazi', 'index', 'v2'), { recursive: true, force: true })
  const rebuilt = catalogService.getCatalog(bookName, 'settings')
  assert.equal(rebuilt.entries.length, 2)

  console.log('knowledge phase1: references and backlinks')
  const referenceIndex = referenceIndexService.buildIndex(bookName, { force: true })
  assert.equal(
    fs.existsSync(join(bookPath, '.51mazi', 'index', 'v2', 'references.catalog.json')),
    true
  )
  assert.equal(
    referenceIndex.dangling.some((item) => item.target.id === 'missing_setting'),
    true
  )
  assert.equal(
    referenceIndex.ambiguities.some((item) => item.kind === 'text_match'),
    true
  )
  const backlinks = retrievalService.readBookBacklinks(bookName, 'setting:setting_01', {
    includeWeak: true
  })
  assert.equal(
    backlinks.backlinks.some(
      (item) => item.kind === 'explicit_ref' && item.source.type === 'chapter'
    ),
    true
  )
  assert.equal(
    backlinks.backlinks.some(
      (item) => item.kind === 'explicit_ref' && item.source.type === 'character'
    ),
    true
  )
  assert.equal(parseSourceReference('setting:setting_01').sourceType, 'setting')
  const characterBacklinks = retrievalService.readBookBacklinks(bookName, 'character:char_01')
  assert.equal(
    characterBacklinks.backlinks.some(
      (item) => item.source.type === 'outline' && item.source.section === 'frontmatter'
    ),
    true
  )

  console.log('knowledge phase1: search and point reads')
  const aliasSearch = retrievalService.searchBookKnowledge(bookName, '甲方公司', {
    scopes: ['settings'],
    limit: 8,
    filters: { kind: 'organization', status: 'confirmed' }
  })
  assert.equal(
    aliasSearch.results.some((item) => item.targetId === 'setting_01'),
    true
  )
  const mixedStructure = retrievalService.listBookStructure(bookName, ['outlines'])
  assert.equal(
    mixedStructure.outlines.some((item) => item.targetId === 'outline_01'),
    true
  )
  const outlineFilterSearch = retrievalService.searchBookKnowledge(bookName, '事故', {
    scopes: ['outlines'],
    limit: 8,
    filters: { reference: 'chapter:chapter_01' }
  })
  assert.equal(
    outlineFilterSearch.results.some((item) => item.targetId === 'outline_01'),
    true
  )
  assert.equal(
    catalogService.queryEntries(bookName, 'outlines', {
      chapterRef: 'chapter:chapter_01'
    })[0].id,
    'outline_01'
  )
  const regexSearch = retrievalService.searchBookKnowledge(bookName, '事故.*复核', {
    scopes: ['settings'],
    limit: 8,
    mode: 'regex'
  })
  assert.equal(
    regexSearch.results.some((item) => item.targetId === 'setting_01'),
    true
  )
  const rules = retrievalService.readBookSource(bookName, 'setting:setting_01#rules', {
    maxChars: 2000
  })
  assert.match(rules.content, /事故报告必须经过两人复核/)
  assert.doesNotMatch(rules.content, /一家承担大型系统压测/)
  assert.equal(rules.location.section, 'rules')
  assert.equal(rules.adjacentSections.length, 2)
  assert.equal(rules.hasMoreBefore, true)

  const outlineContext = retrievalService.readOutlineContext(bookName, 'chapter:chapter_01', {
    maxDepth: 1,
    maxRelated: 10,
    maxChars: 5000
  })
  assert.equal(
    outlineContext.documents.some((item) => item.id === 'outline_01'),
    true
  )
  assert.equal(outlineContext.documents[0].reason, 'chapter_ref')

  const tools = createBookReadTools({ retrievalService })
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'list_book_structure',
      'search_book_knowledge',
      'read_book_source',
      'read_book_backlinks',
      'read_outline_context'
    ]
  )
  const flatList = await tools
    .find((tool) => tool.name === 'list_book_structure')
    .execute({ bookKey: bookName }, { scopes: ['settings', 'outlines'], mode: 'flat' })
  assert.equal(
    flatList.data.items.some((item) => item.scope === 'settings'),
    true
  )

  console.log('knowledge phase1: incremental refresh')
  const settingPath = join(bookPath, 'knowledge', 'settings', 'setting_01.md')
  fs.appendFileSync(settingPath, '\n外部编辑后的附加说明。\n', 'utf8')
  const incrementallyUpdated = catalogService.getCatalog(bookName, 'settings')
  assert.equal(incrementallyUpdated.stats.rebuiltEntries, 1)
  assert.equal(incrementallyUpdated.stats.reusedEntries, 1)
  searchIndexService.invalidate(bookName)
  const refreshedSearch = retrievalService.searchBookKnowledge(bookName, '外部编辑后的附加说明', {
    scopes: ['settings'],
    limit: 8
  })
  assert.equal(
    refreshedSearch.results.some((item) => item.targetId === 'setting_01'),
    true
  )

  const renamed = fs
    .readFileSync(settingPath, 'utf8')
    .replace('title: 字丑科技', 'title: 字丑科技（新名称）')
  fs.writeFileSync(settingPath, renamed, 'utf8')
  catalogService.getCatalog(bookName, 'settings')
  const renamedReferences = referenceIndexService.buildIndex(bookName, { force: true })
  assert.equal(
    renamedReferences.references.some(
      (item) =>
        item.kind === 'explicit_ref' &&
        item.source.type === 'chapter' &&
        item.target.id === 'setting_01' &&
        item.resolution === 'resolved'
    ),
    true
  )

  fs.rmSync(join(bookPath, 'knowledge', 'settings', 'setting_02.md'))
  const afterDelete = catalogService.getCatalog(bookName, 'settings')
  assert.equal(afterDelete.entries.length, 1)
  assert.equal(afterDelete.entries[0].ambiguous, false)

  console.log('knowledge phase1 checks passed')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
