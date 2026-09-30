import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { validateKnowledgeDocument } from '../src/main/services/knowledgeMarkdownParser.js'
import BookSavedSnapshotService from '../src/main/services/bookSavedSnapshotService.js'
import BookKnowledgeCatalogService from '../src/main/services/bookKnowledgeCatalogService.js'

const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
const bookList = path.resolve(option('--book-list') || '')
const backup = path.resolve(option('--backup') || '')
const apply = args.includes('--apply')
if (!args.includes('--book-list') || !args.includes('--backup') || bookList === backup)
  throw new Error('Usage: node scripts/migrate-four-tools-booklist.mjs --book-list PATH --backup PATH [--apply]')

function within(root, target) {
  const relative = path.relative(root, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`Path must be inside ${root}: ${target}`)
  return target
}
function hash(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
}
async function exists(file) {
  try { await fs.access(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')) }
async function filesUnder(root) {
  const result = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Linked path is not supported: ${file}`)
    if (entry.isDirectory()) result.push(...await filesUnder(file))
    else if (entry.isFile()) result.push(file)
  }
  return result
}
async function verifyBackup() {
  assert.equal((await fs.stat(bookList)).isDirectory(), true)
  assert.equal((await fs.stat(backup)).isDirectory(), true)
  const originals = await filesUnder(bookList)
  for (const file of originals) {
    const copy = within(backup, path.join(backup, path.relative(bookList, file)))
    assert.equal(hash(await fs.readFile(file)), hash(await fs.readFile(copy)), `Backup mismatch: ${file}`)
  }
  return originals.length
}
function outlineMarkdown(node, childIds, id) {
  const metadata = {
    id, type: 'outline', title: String(node.title || '未命名大纲'), status: 'planned',
    tags: typeof node.type === 'string' && node.type ? [node.type] : [],
    order: Number.isFinite(Number(node.order)) ? Number(node.order) : null,
    relatedOutlines: childIds.map((child) => `outline:${child}`),
    chapterRefs: [], characterRefs: [], settingRefs: []
  }
  if (node.chapterId) metadata.legacyChapterId = node.chapterId
  if (node.nodeVersions && Object.keys(node.nodeVersions).length)
    metadata.legacyNodeVersions = node.nodeVersions
  const known = new Set(['id', 'title', 'content', 'children', 'type', 'order', 'chapterId', 'nodeVersions'])
  const extra = Object.fromEntries(Object.entries(node).filter(([key]) => !known.has(key)))
  if (Object.keys(extra).length) metadata.legacyMetadata = extra
  const source = `---\n${yaml.dump(metadata, { lineWidth: -1, noRefs: true })}---\n\n` +
    '### 核心内容 <!-- 51:section=summary -->\n\n' +
    '### 展开说明 <!-- 51:section=details -->\n\n' +
    `${String(node.content || '').trim()}\n\n` +
    '### 约束与结果 <!-- 51:section=constraints -->\n\n'
  const validation = validateKnowledgeDocument(source, { expectedType: 'outline' })
  if (!validation.valid) throw new Error(`Invalid outline ${id}: ${JSON.stringify(validation.diagnostics)}`)
  return source
}
function flattenOutlines(node, fallbackId = 'legacy_outline_root', result = []) {
  const id = String(node.id || fallbackId)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`Invalid outline ID: ${id}`)
  const children = Array.isArray(node.children) ? node.children : []
  const childIds = children.map((child, index) => String(child.id || `${id}_child_${index + 1}`))
  result.push({ id, source: outlineMarkdown(node, childIds, id) })
  children.forEach((child, index) => flattenOutlines(child, childIds[index], result))
  return result
}

const originalCount = await verifyBackup()
const report = { bookList, backup, originalCount, apply, books: [], removals: [] }
const writes = []
const removals = []
const books = (await fs.readdir(bookList, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== '.51mazi')
for (const entry of books) {
  const book = within(bookList, path.join(bookList, entry.name))
  const item = { name: entry.name, created: [], retired: [], verified: [] }
  const knowledge = path.join(book, 'knowledge')
  const verifiedScopes = new Set()
  let outlineReady = false
  for (const scope of ['characters', 'settings', 'outlines']) {
    const dir = path.join(knowledge, scope)
    if (await exists(dir)) {
      for (const file of await filesUnder(dir)) {
        if (!file.endsWith('.md')) continue
        const validation = validateKnowledgeDocument(await fs.readFile(file, 'utf8'), {
          expectedType: { characters: 'character', settings: 'setting', outlines: 'outline' }[scope]
        })
        if (!validation.valid) throw new Error(`Existing knowledge document invalid: ${file}`)
        item.verified.push(path.relative(book, file))
      }
    }
  }
  const legacyOutline = path.join(book, 'outlines.json')
  if (await exists(legacyOutline)) {
    const outlines = flattenOutlines(await readJson(legacyOutline))
    outlineReady = outlines.length > 0
    for (const outline of outlines) {
      const target = path.join(knowledge, 'outlines', `${outline.id}.md`)
      if (!(await exists(target))) {
        writes.push(async () => {
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, outline.source, { flag: 'wx' })
        })
        item.created.push(path.relative(book, target))
      }
    }
  }
  const oldNote = path.join(book, '.codex', 'quick-notes.md')
  const note = path.join(book, '.51mazi', 'notes', 'quick-notes.md')
  let noteWillExist = await exists(note)
  if (await exists(oldNote)) {
    const oldText = await fs.readFile(oldNote, 'utf8')
    const newText = await exists(note) ? await fs.readFile(note, 'utf8') : ''
    if (oldText.trim() && !newText.includes(oldText.trim())) {
      const merged = `${newText.trimEnd()}\n\n## 旧速记迁入内容\n\n${oldText.trim()}\n`
      writes.push(async () => {
        await fs.mkdir(path.dirname(note), { recursive: true })
        await fs.writeFile(note, merged, 'utf8')
      })
      noteWillExist = true
      item.created.push(path.relative(book, note))
    }
    item.retired.push(path.relative(book, oldNote))
  }
  for (const scope of ['characters', 'settings', 'outlines']) {
    const migrationRoot = path.join(book, '.51mazi', 'migrations', 'v2', scope)
    if (!(await exists(migrationRoot))) continue
    const reports = (await filesUnder(migrationRoot)).filter((file) => file.endsWith('migration-report.json') && !file.includes(`${path.sep}legacy${path.sep}`))
    for (const file of reports) {
      const migration = await readJson(file)
      if (migration.status !== 'completed') throw new Error(`Migration unfinished: ${file}`)
      verifiedScopes.add(scope)
      for (const source of migration.sourceFiles || []) {
        const sourceFile = within(book, path.join(book, source.path))
        assert.equal(hash(await fs.readFile(sourceFile)), source.hash, `Legacy source changed: ${sourceFile}`)
      }
      for (const document of migration.documents || []) {
        const target = within(book, path.join(book, document.target))
        if (!(await exists(target))) throw new Error(`Migrated document missing: ${target}`)
      }
    }
  }
  const legacyPaths = ['characters.json', 'settings.json', 'outlines.json', 'entity_profiles.json', '人物', '.codex']
  for (const relative of legacyPaths) {
    const target = path.join(book, relative)
    if (await exists(target)) {
      if (relative === 'characters.json' && !verifiedScopes.has('characters') &&
          (await readJson(target)).length !== 0)
        throw new Error(`Unmigrated characters: ${target}`)
      if (relative === 'settings.json' && !verifiedScopes.has('settings'))
        throw new Error(`Unmigrated settings: ${target}`)
      if (relative === 'outlines.json' && !verifiedScopes.has('outlines') && !outlineReady)
        throw new Error(`Unmigrated outlines: ${target}`)
      if (relative === 'entity_profiles.json') {
        const profiles = await readJson(target)
        if (Object.values(profiles).some((items) => !Array.isArray(items) || items.length))
          throw new Error(`Entity profiles contain unmigrated data: ${target}`)
      }
      if (relative === '人物' && !verifiedScopes.has('characters'))
        throw new Error(`Unmigrated character archive: ${target}`)
      if (relative === '.codex') {
        const remaining = await filesUnder(target)
        if (remaining.some((file) => file !== oldNote) || !noteWillExist)
          throw new Error(`Unmigrated Codex data: ${target}`)
      }
      item.retired.push(relative)
      removals.push(async () => fs.rm(within(book, target), { recursive: true, force: false }))
    }
  }
  const oldMigrationArchive = path.join(book, '.51mazi', 'migrations', 'v2')
  if (await exists(oldMigrationArchive)) {
    item.retired.push(path.relative(book, oldMigrationArchive))
    removals.push(async () => fs.rm(within(book, oldMigrationArchive), { recursive: true, force: false }))
  }
  report.books.push(item)
}
const rootStats = path.join(bookList, 'word_stats.json')
if (await exists(rootStats)) {
  const legacy = await readJson(rootStats)
  for (const item of report.books) {
    const stats = await readJson(path.join(bookList, item.name, '.51mazi', 'stats', 'word-stats.json'))
    const expected = Object.fromEntries(Object.entries(legacy.chapterStats || {})
      .filter(([key]) => key.startsWith(`${item.name}/`))
      .map(([key, value]) => [key.slice(item.name.length + 1), value]))
    assert.deepEqual(stats.chapterStats, expected, `Root statistics differ for ${item.name}`)
    assert.deepEqual(stats.bookDailyStats, legacy.bookDailyStats?.[item.name] || {}, `Daily statistics differ for ${item.name}`)
  }
  report.removals.push('word_stats.json')
  removals.push(async () => fs.rm(within(bookList, rootStats)))
}
if (apply) {
  for (const write of writes) await write()
  const snapshotService = new BookSavedSnapshotService({ booksDirProvider: bookList })
  const catalogService = new BookKnowledgeCatalogService({ snapshotService })
  for (const item of report.books) catalogService.rebuildBook(item.name)
  for (const remove of removals) await remove()
}
console.log(JSON.stringify(report, null, 2))
