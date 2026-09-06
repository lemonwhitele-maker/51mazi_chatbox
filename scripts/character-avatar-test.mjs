import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join, resolve, relative, sep } from 'node:path'
import { CharacterImageService, resolveCharacterImagePath } from '../src/main/services/characterImageService.js'
import { BookSavedSnapshotService } from '../src/main/services/bookSavedSnapshotService.js'
import { KnowledgeDocumentService, withCharacterAvatar } from '../src/main/services/knowledgeDocumentService.js'
import { BookKnowledgeCatalogService } from '../src/main/services/bookKnowledgeCatalogService.js'
import { registerKnowledgeDocumentsIpc } from '../src/main/services/knowledgeDocumentsIpc.js'
import { parseKnowledgeMarkdown } from '../src/main/services/knowledgeMarkdownParser.js'
import { writeFileAtomically } from '../src/main/services/chapterWriteService.js'

const root = fs.mkdtempSync(join(os.tmpdir(), '51mazi-avatar-test-'))
const bookName = '测试书 中文 空格'
const bookPath = join(root, 'books', bookName)
fs.mkdirSync(bookPath, { recursive: true })
let booksDir = join(root, 'books')
const snapshotService = new BookSavedSnapshotService({ booksDirProvider: () => booksDir })
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afoUAAAAASUVORK5CYII=', 'base64')
const imageService = new CharacterImageService({
  snapshotService,
  generateImageBuffer: async (options) => {
    assert.equal(options.size, '720*1280')
    assert.equal(options.bookPath, bookPath)
    return imageBytes
  }
})
const options = (sessionId) => ({ bookName, sessionId, prompt: '一名虚构人物' })
const copyBook = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyBook(join(from, entry.name), join(to, entry.name))
    else fs.copyFileSync(join(from, entry.name), join(to, entry.name))
  }
}

try {
  const first = await imageService.generate(options('session-first'))
  const second = await imageService.generate(options('session-first'))
  const separate = await imageService.generate(options('session-second'))
  assert.notEqual(first.localPath, second.localPath)
  assert.deepEqual(fs.readFileSync(first.localPath), imageBytes)
  assert.throws(() => imageService.confirm({ ...options('session-first'), chosenPath: separate.localPath }), { code: 'CHARACTER_IMAGE_CANDIDATE_INVALID' })
  assert.throws(() => imageService.confirm({ ...options('session-first'), chosenPath: join(root, 'external.png') }), { code: 'CHARACTER_IMAGE_CANDIDATE_INVALID' })
  await assert.rejects(imageService.generate(options('../invalid')), { code: 'CHARACTER_IMAGE_SESSION_INVALID' })

  const confirmed = imageService.confirm({ ...options('session-first'), chosenPath: first.localPath })
  assert.match(confirmed.relativePath, /^character_images\/[a-f0-9-]+\.png$/)
  assert.deepEqual(fs.readFileSync(confirmed.localPath), imageBytes)
  assert.equal(imageService.confirm({ ...options('session-first'), chosenPath: first.localPath }).localPath, confirmed.localPath)
  assert.ok(fs.existsSync(first.localPath), 'confirmation keeps candidates available for failed document save')
  assert.ok(fs.existsSync(second.localPath))
  imageService.discard(options('session-first'))
  assert.ok(!fs.existsSync(first.localPath))
  assert.ok(!fs.existsSync(second.localPath))
  assert.ok(fs.existsSync(separate.localPath), 'cancel does not remove another session')
  assert.ok(fs.existsSync(confirmed.localPath), 'cancel never removes a confirmed image')
  imageService.discard(options('session-first'))
  await assert.rejects(imageService.generate(options('session-first')), { code: 'CHARACTER_IMAGE_SESSION_CANCELLED' })

  let release
  const lateService = new CharacterImageService({ snapshotService, generateImageBuffer: () => new Promise((done) => { release = done }) })
  const pending = lateService.generate(options('session-late'))
  lateService.discard(options('session-late'))
  release(imageBytes)
  await assert.rejects(pending, { code: 'CHARACTER_IMAGE_SESSION_CANCELLED' })
  assert.ok(!fs.existsSync(join(bookPath, '.51mazi', 'tmp', 'character-images', 'session-late')))
  await assert.rejects(lateService.generate(options('session-late')), { code: 'CHARACTER_IMAGE_SESSION_CANCELLED' })

  // An in-flight session remains bound to its original book root when settings change.
  booksDir = join(root, 'new-books')
  fs.mkdirSync(join(booksDir, bookName), { recursive: true })
  const pinned = imageService.confirm({ ...options('session-second'), chosenPath: separate.localPath })
  assert.ok(pinned.localPath.startsWith(bookPath + sep))
  imageService.discard(options('session-second'))
  booksDir = join(root, 'books')

  const documents = new KnowledgeDocumentService({ snapshotService })
  const source = documents.createTemplateSource('characters', 'char_test', {
    title: '测试人物',
    metadata: { custom: { flags: ['保留'], count: 2 }, markerColor: '#123456' },
    sections: { summary: '人物当前编辑的文字', 'current-state': '状态', facts: '事实' }
  }).replace('custom:', '# 自定义元数据注释\ncustom:').replaceAll('\n', '\r\n')
  await documents.createDocumentFromSource({ bookName, scope: 'characters', documentId: 'char_test', source })
  const before = documents.readDocument({ bookName, scope: 'characters', documentId: 'char_test' })
  const draft = source.replace('人物当前编辑的文字', '未另行保存的新人物文字')
  const saved = await documents.writeCharacterAvatar({ bookName, documentId: 'char_test', source: draft, expectedFileHash: before.fileHash, relativePath: confirmed.relativePath })
  const after = documents.readDocument({ bookName, scope: 'characters', documentId: 'char_test' })
  assert.equal(after.document.metadata.avatar, confirmed.relativePath)
  assert.deepEqual(after.document.metadata.custom, before.document.metadata.custom)
  assert.equal(after.document.metadata.markerColor, '#123456')
  assert.ok(after.source.includes('未另行保存的新人物文字'))
  assert.ok(after.source.includes('# 自定义元数据注释\r\n'))
  assert.equal(after.source.replace(/^avatar: .*\r\n/m, ''), draft, 'all bytes outside the added avatar field are preserved')
  await assert.rejects(documents.writeCharacterAvatar({ bookName, documentId: 'char_test', source: draft, expectedFileHash: before.fileHash, relativePath: pinned.relativePath }), { code: 'KNOWLEDGE_DOCUMENT_VERSION_CONFLICT' })
  assert.equal(documents.readDocument({ bookName, scope: 'characters', documentId: 'char_test' }).fileHash, after.fileHash)
  await assert.rejects(documents.writeCharacterAvatar({ bookName, documentId: 'char_test', source: draft, relativePath: confirmed.relativePath }), { code: 'KNOWLEDGE_DOCUMENT_VERSION_REQUIRED' })
  await assert.rejects(documents.writeCharacterAvatar({ bookName, documentId: 'char_test', source: draft, expectedFileHash: after.fileHash, relativePath: '../external.png' }), { code: 'CHARACTER_IMAGE_PATH_INVALID' })
  assert.ok(fs.existsSync(confirmed.localPath) && fs.existsSync(pinned.localPath), 'version conflicts keep images')

  let shouldFail = true
  const failingDocuments = new KnowledgeDocumentService({
    snapshotService,
    atomicWriter: async (filePath, contents) => {
      if (filePath.endsWith('char_test.md') && shouldFail) {
        shouldFail = false
        throw new Error('simulated disk failure')
      }
      return writeFileAtomically(filePath, contents)
    }
  })
  await assert.rejects(failingDocuments.writeCharacterAvatar({ bookName, documentId: 'char_test', source: draft, expectedFileHash: after.fileHash, relativePath: pinned.relativePath }), { code: 'KNOWLEDGE_DOCUMENT_WRITE_FAILED' })
  assert.equal(documents.readDocument({ bookName, scope: 'characters', documentId: 'char_test' }).fileHash, after.fileHash)
  assert.ok(fs.existsSync(pinned.localPath), 'write failure leaves the chosen image available for retry')

  const catalog = new BookKnowledgeCatalogService({ snapshotService })
  const entry = catalog.listEntries(bookName, 'characters').find((item) => item.id === 'char_test')
  assert.equal(catalog.descriptor(entry).avatar, confirmed.relativePath)
  assert.equal(catalog.listCharacterProfiles(bookName)[0].avatar, confirmed.relativePath)

  // Old values, multiline values, quoted keys and flow-style YAML all preserve other data.
  for (const raw of [
    'id: x\r\navatar: old # 注释\r\ncustom: {nested: [1, 2]}\r\n',
    'id: x\navatar: |\n  old value\n# 保留此注释\ncustom: z\n',
    'id: x\n"avatar":\ncustom: z\n',
    '{id: x, avatar: old, custom: {nested: [1, 2]}}\n',
    '{id: x, custom: {nested: [1, 2]}}\n'
  ]) {
    const original = `---\n${raw}---\n\n正文\n`
    const result = withCharacterAvatar(original, confirmed.relativePath)
    assert.equal(parseKnowledgeMarkdown(result).metadata.avatar, confirmed.relativePath)
    assert.deepEqual(parseKnowledgeMarkdown(result).metadata.custom, parseKnowledgeMarkdown(original).metadata.custom)
    assert.ok(result.endsWith('---\n\n正文\n'))
  }

  const handlers = new Map()
  const ipc = registerKnowledgeDocumentsIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) },
    documentService: documents,
    catalogService: catalog,
    referenceIndexService: {}
  })
  const ipcSaved = await handlers.get('knowledge:v2:write-character-avatar')(null, { bookName, documentId: 'char_test', source: after.source, expectedFileHash: after.fileHash, relativePath: pinned.relativePath })
  assert.equal(ipcSaved.success, true)
  assert.equal(ipcSaved.document.metadata.avatar, pinned.relativePath)
  assert.ok(ipcSaved.saved.undoToken)
  const ipcConflict = await handlers.get('knowledge:v2:write-character-avatar')(null, { bookName, documentId: 'char_test', source: after.source, expectedFileHash: after.fileHash, relativePath: pinned.relativePath })
  assert.equal(ipcConflict.success, false)
  assert.equal(ipcConflict.code, 'KNOWLEDGE_DOCUMENT_VERSION_CONFLICT')
  ipc.dispose()
  assert.equal(handlers.size, 0)

  await documents.undoWrite({ bookName, undoToken: ipcSaved.saved.undoToken })
  await documents.undoWrite({ bookName, undoToken: saved.undoToken })
  assert.ok(fs.existsSync(confirmed.localPath), 'undo keeps formally saved images')
  const movedBookPath = join(root, '搬家后的书库', bookName)
  copyBook(bookPath, movedBookPath)
  assert.deepEqual(fs.readFileSync(resolveCharacterImagePath(movedBookPath, confirmed.relativePath).filePath), imageBytes)

  const linkBook = join(root, 'books', '链接测试')
  const external = join(root, 'external-images')
  fs.mkdirSync(linkBook)
  fs.mkdirSync(external)
  fs.writeFileSync(join(external, 'image.png'), imageBytes)
  fs.symlinkSync(external, join(linkBook, 'character_images'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => resolveCharacterImagePath(linkBook, 'character_images/image.png'), { code: 'CHARACTER_IMAGE_PATH_INVALID' })
  assert.ok(fs.existsSync(join(external, 'image.png')))
  console.log('Character avatar tests passed: sessions, cancellation, path isolation, document conflicts, IPC, and portable images.')
} finally {
  const owned = resolve(root)
  const withinTemp = relative(resolve(os.tmpdir()), owned)
  assert.ok(withinTemp && withinTemp !== '..' && !withinTemp.startsWith(`..${sep}`))
  fs.rmSync(owned, { recursive: true, force: true })
}
