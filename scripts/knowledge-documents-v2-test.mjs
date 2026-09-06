import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import BookSavedSnapshotService from '../src/main/services/bookSavedSnapshotService.js'
import KnowledgeDocumentService from '../src/main/services/knowledgeDocumentService.js'
import {
  parseKnowledgeMarkdown,
  replaceKnowledgeSection,
  serializeKnowledgeMarkdown,
  validateKnowledgeDocument
} from '../src/main/services/knowledgeMarkdownParser.js'

const fixtureBook = fileURLToPath(
  new URL('./fixtures/knowledge-documents-v2/中文书籍', import.meta.url)
)
const fixtureCharacter = join(fixtureBook, 'knowledge', 'characters', 'char_01.md')
const source = fs.readFileSync(fixtureCharacter, 'utf8')
const settingSource = fs.readFileSync(
  join(fixtureBook, 'knowledge', 'settings', 'setting_01.md'),
  'utf8'
)
const outlineSource = fs.readFileSync(
  join(fixtureBook, 'knowledge', 'outlines', 'outline_01.md'),
  'utf8'
)

const parsed = parseKnowledgeMarkdown(source)
console.log('knowledge v2: parser')
assert.equal(parsed.metadata.id, 'char_01')
assert.equal(parsed.metadata.customField.owner, '用户保留字段')
assert.deepEqual(parsed.metadata.aliases, ['小林', '阿昕'])
assert.equal(parsed.sectionMap['current-state'].content.trim(), '')
assert.equal(
  parsed.references.some((item) => item.targetId === 'missing_setting'),
  true
)
assert.equal(
  serializeKnowledgeMarkdown(parsed),
  source,
  '未修改的 parse → serialize 必须逐字节等价'
)
assert.equal(validateKnowledgeDocument(parsed, { expectedType: 'character' }).valid, true)
assert.equal(validateKnowledgeDocument(settingSource, { expectedType: 'setting' }).valid, true)
assert.equal(validateKnowledgeDocument(outlineSource, { expectedType: 'outline' }).valid, true)

const originalSummary = parsed.sectionMap.summary.rawContent
const originalFacts = parsed.sectionMap.facts.rawContent
const updatedSource = replaceKnowledgeSection(
  parsed,
  'current-state',
  '她已经拿到被改写的事故报告。',
  { expectedSectionHash: parsed.sectionMap['current-state'].contentHash }
)
const updated = parseKnowledgeMarkdown(updatedSource)
assert.match(updated.sectionMap['current-state'].content, /已经拿到/)
assert.equal(updated.sectionMap.summary.rawContent, originalSummary)
assert.equal(updated.sectionMap.facts.rawContent, originalFacts)
assert.equal(updated.metadata.customField.owner, '用户保留字段')
assert.match(updated.source, /## 自由前言/)
assert.throws(
  () =>
    replaceKnowledgeSection(parsed, 'current-state', '过期修改', {
      expectedSectionHash: 'sha256:stale'
    }),
  (error) => error.code === 'KNOWLEDGE_SECTION_VERSION_CONFLICT'
)

const invalidOutline = parseKnowledgeMarkdown(
  source.replace('type: character', 'type: book-outline')
)
assert.equal(validateKnowledgeDocument(invalidOutline).valid, false)
const missingRequiredSection = parseKnowledgeMarkdown(
  source.replace('<!-- 51:section=facts -->', '<!-- marker intentionally missing -->')
)
const missingRequiredValidation = validateKnowledgeDocument(missingRequiredSection, {
  expectedType: 'character'
})
assert.equal(missingRequiredValidation.valid, false)
assert.equal(
  missingRequiredValidation.diagnostics.some(
    (item) => item.code === 'SECTION_REQUIRED' && item.path === 'sections.facts'
  ),
  true
)
assert.equal(serializeKnowledgeMarkdown(missingRequiredSection), missingRequiredSection.source)

console.log('knowledge v2: document service')
const tempRoot = fs.mkdtempSync(join(os.tmpdir(), '51mazi-knowledge-v2-'))
const bookName = '中文书籍'
const tempBook = join(tempRoot, bookName)

function copyDirectory(sourceDirectory, targetDirectory) {
  fs.mkdirSync(targetDirectory, { recursive: true })
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = join(sourceDirectory, entry.name)
    const targetPath = join(targetDirectory, entry.name)
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath)
    else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath)
  }
}

try {
  copyDirectory(fixtureBook, tempBook)
  const snapshotService = new BookSavedSnapshotService({ booksDirProvider: tempRoot })
  const service = new KnowledgeDocumentService({ snapshotService })
  const before = service.readDocument({ bookName, scope: 'characters', documentId: 'char_01' })
  assert.equal(before.sectionHashes.summary, parsed.sectionMap.summary.contentHash)
  assert.equal(typeof before.mtimeMs, 'number')

  const applied = await service.writeSection({
    bookName,
    scope: 'characters',
    documentId: 'char_01',
    sectionKey: 'current-state',
    expectedFileHash: before.fileHash,
    expectedSectionHash: before.sectionHashes['current-state'],
    content: '她正在复核事故报告。'
  })
  console.log('knowledge v2: section applied')
  assert.notEqual(applied.fileHash, before.fileHash)
  assert.ok(applied.undoToken)
  assert.match(
    service.readDocument({ bookName, scope: 'characters', documentId: 'char_01' }).document
      .sectionMap['current-state'].content,
    /正在复核/
  )

  const undone = await service.undoWrite({
    bookName,
    undoToken: applied.undoToken,
    expectedCurrentHash: applied.fileHash
  })
  console.log('knowledge v2: undo applied')
  assert.equal(undone.fileHash, before.fileHash)
  assert.throws(
    () => service.resolveDocumentFile(bookName, 'characters', '../settings/setting_01'),
    /ID 无效/
  )

  const characterPath = join(tempBook, 'knowledge', 'characters', 'char_01.md')
  fs.appendFileSync(characterPath, '\n外部编辑。\n', 'utf8')
  await assert.rejects(
    service.writeDocument({
      bookName,
      scope: 'characters',
      documentId: 'char_01',
      expectedFileHash: before.fileHash,
      source
    }),
    (error) => error.code === 'KNOWLEDGE_DOCUMENT_VERSION_CONFLICT'
  )

  const manifestPath = join(
    tempBook,
    '.51mazi',
    'backups',
    'knowledge-documents',
    `${applied.undoToken}.json`
  )
  assert.equal(fs.existsSync(manifestPath), true)
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).status, 'undone')

  console.log('knowledge v2: new-book examples')
  const exampleBookName = '新书样例测试'
  const exampleBookPath = join(tempRoot, exampleBookName)
  fs.mkdirSync(exampleBookPath, { recursive: true })
  fs.writeFileSync(join(exampleBookPath, 'mazi.json'), JSON.stringify({ name: exampleBookName }))
  const initialized = await service.initializeBook({ bookName: exampleBookName })
  assert.equal(initialized.created.length, 3)
  assert.deepEqual(initialized.created.map((item) => `${item.scope}:${item.documentId}`).sort(), [
    'characters:example_character',
    'outlines:example_outline',
    'settings:example_setting'
  ])
  for (const item of initialized.created) {
    const example = service.readDocument({
      bookName: exampleBookName,
      scope: item.scope,
      documentId: item.documentId
    })
    assert.equal(validateKnowledgeDocument(example.document).valid, true)
    assert.match(example.source, /样例/)
    assert.ok(example.document.sections.every((section) => section.content.trim()))
  }
  const initializedAgain = await service.initializeBook({ bookName: exampleBookName })
  assert.equal(initializedAgain.created.length, 0)
  assert.equal(initializedAgain.existing.length, 3)
  console.log('knowledge documents v2 checks passed')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
