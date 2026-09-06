import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import LegacyCodexHarnessMigrationV1 from '../src/main/harness/migration/legacyCodexHarnessMigrationV1.js'

const root = await fs.mkdtemp(join(os.tmpdir(), '51mazi-migration-'))
const bookPath = join(root, '书一')
await fs.mkdir(join(bookPath, '.codex'), { recursive: true })
await fs.writeFile(join(bookPath, '.codex', 'quick-notes.md'), '旧速记', 'utf8')
const values = new Map([
  ['codexAgent.bookBindingsV1', { [encodeURIComponent('书一')]: { threads: [{ id: 'provider-thread-1', name: '旧对话', archived: true, modelPreference: 'gpt-test', effortPreference: '[object Object]' }] } }],
  ['codexAgent.threadHistoryV1', { 'provider-thread-1': [{ role: 'user', content: '中文请求', createdAt: '2026-01-01T00:00:00Z' }, { role: 'assistant', content: '中文回答' }] }]
])
const legacyStore = { get: (key) => values.get(key), set: (key, value) => values.set(key, value) }
const snapshotService = { resolveBookPath: (name) => join(root, name), getBooksDir: () => root }
const harnessStore = new HarnessStore({ snapshotService })
try {
  const migration = new LegacyCodexHarnessMigrationV1({ store: legacyStore, harnessStore, snapshotService })
  const first = await migration.migrate()
  const second = await migration.migrate()
  assert.equal(first.imported.length, 1)
  assert.equal(second.imported.length, 0)
  const list = await harnessStore.listConversations('书一')
  assert.equal(list[0].status, 'archived')
  const data = await harnessStore.loadConversation('书一', list[0].conversationId)
  assert.equal(data.state.modelPreference, 'gpt-test')
  assert.equal(data.state.effortPreference, null)
  assert.equal(values.get('codexAgent.bookBindingsV1')[encodeURIComponent('书一')].threads[0].effortPreference, 'codex-default')
  assert.equal(JSON.stringify(data).includes('provider-thread-1'), false)
  assert.equal((await fs.readFile(join(bookPath, '.51mazi', 'notes', 'quick-notes.md'), 'utf8')), '旧速记')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
console.log('harness migration test passed')
