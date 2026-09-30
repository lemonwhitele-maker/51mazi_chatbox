import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateKnowledgeDocument } from '../src/main/services/knowledgeMarkdownParser.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), '51mazi-four-tools-migration-'))
const bookList = path.join(root, 'BookList')
const backup = path.join(root, 'Backup')
const book = path.join(bookList, '测试书')
const command = (script, flags = []) => execFileSync(process.execPath, [
  path.join(process.cwd(), 'scripts', script), '--book-list', bookList, '--backup', backup, ...flags
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
try {
  await fs.mkdir(path.join(book, '.codex'), { recursive: true })
  await fs.mkdir(path.join(book, '.51mazi', 'notes'), { recursive: true })
  await fs.mkdir(path.join(book, '.51mazi', 'stats'), { recursive: true })
  await fs.mkdir(path.join(book, '.51mazi', 'harness', 'v1', 'conversations', 'conv_old'), { recursive: true })
  await fs.writeFile(path.join(book, 'characters.json'), '[]')
  await fs.writeFile(path.join(book, 'entity_profiles.json'), JSON.stringify({ mount: [], monster: [] }))
  await fs.writeFile(path.join(book, 'outlines.json'), JSON.stringify({
    title: '总纲', content: '完整旧大纲内容', children: [{ id: 'outline_child', title: '子纲', content: '子纲内容', children: [] }]
  }))
  await fs.writeFile(path.join(book, '.codex', 'quick-notes.md'), '旧速记唯一内容\n')
  await fs.writeFile(path.join(book, '.51mazi', 'notes', 'quick-notes.md'), '新速记唯一内容\n')
  const stats = { schemaVersion: 1, dailyStats: {}, chapterStats: {}, bookDailyStats: {} }
  await fs.writeFile(path.join(book, '.51mazi', 'stats', 'word-stats.json'), JSON.stringify(stats))
  await fs.writeFile(path.join(bookList, 'word_stats.json'), JSON.stringify({ chapterStats: {}, bookDailyStats: {} }))
  const state = { schemaVersion: 1, conversationId: 'conv_old', bookKey: '测试书', runtimeId: 'agent-router' }
  await fs.writeFile(path.join(book, '.51mazi', 'harness', 'v1', 'conversations', 'conv_old', 'state.json'), JSON.stringify(state))
  await fs.writeFile(path.join(book, '.51mazi', 'harness', 'v1', 'conversations.json'), JSON.stringify({ conversations: [state] }))
  await fs.cp(bookList, backup, { recursive: true })

  await fs.writeFile(path.join(book, 'characters.json'), '[{"id":"changed"}]')
  assert.throws(() => command('migrate-four-tools-booklist.mjs', ['--apply']), /Backup mismatch/)
  assert.equal(await fs.readFile(path.join(book, 'characters.json'), 'utf8'), '[{"id":"changed"}]')
  await fs.copyFile(path.join(backup, '测试书', 'characters.json'), path.join(book, 'characters.json'))

  command('migrate-four-tools-booklist.mjs', ['--apply'])
  const rootOutline = await fs.readFile(path.join(book, 'knowledge', 'outlines', 'legacy_outline_root.md'), 'utf8')
  const childOutline = await fs.readFile(path.join(book, 'knowledge', 'outlines', 'outline_child.md'), 'utf8')
  assert.equal(validateKnowledgeDocument(rootOutline, { expectedType: 'outline' }).valid, true)
  assert.equal(validateKnowledgeDocument(childOutline, { expectedType: 'outline' }).valid, true)
  assert.match(rootOutline, /完整旧大纲内容/)
  assert.match(rootOutline, /outline:outline_child/)
  assert.match(await fs.readFile(path.join(book, '.51mazi', 'notes', 'quick-notes.md'), 'utf8'), /旧速记唯一内容/)
  await assert.rejects(fs.access(path.join(book, 'outlines.json')), { code: 'ENOENT' })
  await assert.rejects(fs.access(path.join(book, 'entity_profiles.json')), { code: 'ENOENT' })
  await assert.rejects(fs.access(path.join(book, '.codex')), { code: 'ENOENT' })
  await assert.rejects(fs.access(path.join(bookList, 'word_stats.json')), { code: 'ENOENT' })

  const migrated = JSON.parse(command('migrate-four-tools-conversations.mjs', ['--apply']))
  assert.equal(migrated.conversations, 1)
  assert.equal((await fs.readFile(path.join(book, '.51mazi', 'harness', 'v1', 'conversations', 'conv_old', 'state.json'), 'utf8')).includes('book-primitives-v1'), true)
  assert.equal((await fs.readFile(path.join(book, '.51mazi', 'harness', 'v1', 'conversations.json'), 'utf8')).includes('book-primitives-v1'), true)
  assert.equal((await fs.readFile(path.join(backup, '测试书', 'outlines.json'), 'utf8')).includes('完整旧大纲内容'), true)
  console.log('Four-tool BookList migration test passed')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
