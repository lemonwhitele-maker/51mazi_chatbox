import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import BookSavedSnapshotService from '../src/main/services/bookSavedSnapshotService.js'
import BookKnowledgeCatalogService from '../src/main/services/bookKnowledgeCatalogService.js'
import BookSearchIndexService from '../src/main/services/bookSearchIndexService.js'
import BookRetrievalService from '../src/main/services/bookRetrievalService.js'

const tempRoot = fs.mkdtempSync(join(os.tmpdir(), '51mazi-book-retrieval-'))
const bookName = '合成测试书'
const bookPath = join(tempRoot, bookName)
const legacyFiles = new Map()
const originalReadFileSync = fs.readFileSync
const legacyReads = []

function write(filePath, content) {
  fs.mkdirSync(dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function writeKnowledge(scope, id, type, title, metadata, sections) {
  const header = { id, type, title, status: 'confirmed', aliases: [], tags: [], ...metadata }
  const content = Object.entries(sections)
    .map(([key, text]) => `### ${key} <!-- 51:section=${key} -->\n\n${text}\n`)
    .join('\n')
  write(join(bookPath, 'knowledge', scope, `${id}.md`), `---\n${JSON.stringify(header, null, 2)}\n---\n\n${content}`)
}

function writeLegacy(relativePath, content) {
  const filePath = join(bookPath, ...relativePath)
  write(filePath, content)
  legacyFiles.set(resolve(filePath), Buffer.from(content, 'utf8'))
}

try {
  const chapterPath = join(bookPath, '正文', '测试卷', '测试章.txt')
  write(chapterPath, '测试共同词：正文中的测试人物。\r\n\r\n第二段：独立测试内容。\r\n')
  writeKnowledge('characters', 'test-character', 'character', '测试人物', {
    aliases: ['测试别名'], avatar: 'file:///test/avatar.png', markerColor: '#123456'
  }, {
    summary: '测试共同词：人物简介。',
    'current-state': '人物的当前状态。',
    facts: '人物的已确认事实。'
  })
  writeKnowledge('settings', 'test-setting', 'setting', '测试设定', { kind: 'custom' }, {
    definition: '测试共同词：设定定义。',
    rules: '设定边界。',
    facts: '设定的已确认事实。'
  })
  writeKnowledge('outlines', 'test-outline', 'outline', '测试大纲', {
    order: 1,
    relatedOutlines: [],
    chapterRefs: ['测试卷/测试章.txt'],
    characterRefs: ['test-character'],
    settingRefs: ['test-setting']
  }, {
    summary: '测试共同词：大纲概要。',
    details: '大纲内容。',
    constraints: '大纲约束。'
  })
  write(join(bookPath, '.51mazi', 'notes', 'quick-notes.md'), '# 测试速记\n\n测试共同词：保存的速记。\n')

  // Retired source files are present only to verify that retrieval leaves them untouched.
  writeLegacy(['characters.json'], '[{"id":"legacy-character","name":"旧格式专属词"}]')
  writeLegacy(['outlines.json'], '{"children":[{"id":"legacy-outline","content":"旧格式专属词"}]}')
  writeLegacy(['outline-ai-sessions.json'], '{"draft":"旧格式专属词"}')
  writeLegacy(['人物', 'characters', 'index.json'], '{"documents":[{"id":"legacy-html","file":"legacy.html","name":"旧格式专属词"}]}')
  writeLegacy(['人物', 'characters', 'legacy.html'], '<article>旧格式专属词</article>')
  writeLegacy(['人物', 'characters', 'legacy.draft.html'], '<article>旧格式草稿专属词</article>')

  fs.readFileSync = function (filePath, ...args) {
    if (typeof filePath === 'string' && legacyFiles.has(resolve(filePath))) {
      legacyReads.push(resolve(filePath))
    }
    return originalReadFileSync.call(this, filePath, ...args)
  }

  const snapshotService = new BookSavedSnapshotService({ booksDirProvider: tempRoot })
  const catalogService = new BookKnowledgeCatalogService({ snapshotService })
  const searchIndexService = new BookSearchIndexService({ snapshotService, catalogService })
  const retrievalService = new BookRetrievalService({ snapshotService, catalogService, searchIndexService })
  const scopes = ['chapters', 'characters', 'settings', 'outlines', 'notes']

  const structure = retrievalService.listBookStructure(bookName, scopes, { mode: 'flat' })
  assert.equal(structure.chapters.length, 1)
  assert.equal(structure.chapters[0].lineEnding, 'CRLF')
  assert.deepEqual(structure.characters.map((item) => item.targetId), ['test-character'])
  assert.deepEqual(structure.settings.map((item) => item.targetId), ['test-setting'])
  assert.deepEqual(structure.outlines.map((item) => item.targetId), ['test-outline'])
  assert.equal(structure.notes.length, 1)
  assert.equal(structure.items.length, 5)

  const characterProfiles = catalogService.listCharacterProfiles(bookName)
  assert.equal(characterProfiles.length, 1)
  assert.equal(characterProfiles[0].id, 'test-character')
  assert.equal(characterProfiles[0].name, '测试人物')
  assert.equal(characterProfiles[0].avatar, 'file:///test/avatar.png')
  assert.equal(characterProfiles[0].markerColor, '#123456')

  const search = retrievalService.searchBookKnowledge(bookName, '测试共同词', { scopes, limit: 8 })
  assert.deepEqual(new Set(search.results.map((result) => result.sourceType)),
    new Set(['chapter', 'character', 'setting', 'outline', 'note']))
  assert.equal(retrievalService.searchBookKnowledge(bookName, '旧格式专属词', { scopes }).results.length, 0)

  const chapterResult = search.results.find((result) => result.sourceType === 'chapter')
  const read = retrievalService.readBookSource(bookName, chapterResult.reference, { before: 0, after: 0 })
  assert.match(read.content, /测试共同词/)
  assert.equal(read.versionChanged, false)

  const characterRead = retrievalService.readBookSource(bookName, 'character:test-character#current-state')
  assert.match(characterRead.content, /人物的当前状态/)
  assert.doesNotMatch(characterRead.content, /人物的已确认事实/)
  assert.match(retrievalService.readBookSource(bookName, 'setting:test-setting#definition').content, /设定定义/)
  assert.match(retrievalService.readBookSource(bookName, 'outline:test-outline#summary').content, /大纲概要/)
  assert.match(retrievalService.readBookSource(bookName, 'note:quick-notes').content, /保存的速记/)
  assert.equal(retrievalService.readOutlineContext(bookName, 'outline:test-outline').documents[0].id, 'test-outline')

  for (const reference of ['character:legacy-character', 'character:legacy-html', 'outline:legacy-outline']) {
    assert.throws(() => retrievalService.readBookSource(bookName, reference),
      (error) => error.code === 'KNOWLEDGE_DOCUMENT_NOT_FOUND' && /旧人物 HTML\/JSON/.test(error.message))
  }

  // The shared chapter/notes reader must not reactivate legacy readers without a catalog.
  const chapterOnlyRetrieval = new BookRetrievalService({
    snapshotService,
    searchIndexService: new BookSearchIndexService({ snapshotService })
  })
  const chapterOnlyStructure = chapterOnlyRetrieval.listBookStructure(bookName, scopes, { mode: 'flat' })
  assert.deepEqual(chapterOnlyStructure.characters, [])
  assert.deepEqual(chapterOnlyStructure.settings, [])
  assert.deepEqual(chapterOnlyStructure.outlines, [])
  assert.equal(chapterOnlyStructure.items.length, 2)
  assert.equal(chapterOnlyRetrieval.searchBookKnowledge(bookName, '旧格式专属词', { scopes }).results.length, 0)

  write(chapterPath, '新保存版本：测试人物改变了决定。\r\n')
  const staleRead = retrievalService.readBookSource(bookName, chapterResult.reference)
  assert.equal(staleRead.versionChanged, true)
  assert.match(staleRead.message, /正式版本已变化/)
  assert.throws(() => snapshotService.readChapterSnapshot(bookName, '../outlines.json'), /路径无效|越出书籍范围/)

  fs.readFileSync = originalReadFileSync
  assert.deepEqual(legacyReads, [], '正式检索不应读取任何旧格式文件')
  for (const [filePath, original] of legacyFiles) {
    assert.deepEqual(fs.readFileSync(filePath), original, '现存旧格式文件不得改写或删除')
  }
  console.log('book retrieval checks passed: Markdown sources, chapters, notes, and untouched legacy files')
} finally {
  fs.readFileSync = originalReadFileSync
  const resolvedRoot = resolve(tempRoot)
  assert.ok(resolvedRoot.startsWith(`${resolve(os.tmpdir())}${sep}`))
  fs.rmSync(resolvedRoot, { recursive: true, force: true })
}
