import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const value = (name) => args[args.indexOf(name) + 1]
if (!args.includes('--book-list') || !args.includes('--backup'))
  throw new Error('Usage: node scripts/migrate-four-tools-conversations.mjs --book-list PATH --backup PATH [--apply]')
const bookList = path.resolve(value('--book-list'))
const backup = path.resolve(value('--backup'))
const apply = args.includes('--apply')
if (bookList === backup) throw new Error('BookList and backup must differ')
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const exists = async (file) => fs.access(file).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false
  throw error
})
async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  await fs.rename(temp, file)
}
function inside(root, target) {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`Unsafe path: ${target}`)
  return target
}
async function checkedJson(file) {
  const backupFile = inside(backup, path.join(backup, path.relative(bookList, file)))
  if (!(await exists(backupFile))) throw new Error(`Backup missing: ${backupFile}`)
  const current = await fs.readFile(file)
  const original = await fs.readFile(backupFile)
  if (sha(current) !== sha(original)) throw new Error(`File changed since backup: ${file}`)
  return JSON.parse(current.toString('utf8'))
}

const report = { apply, conversations: 0, indexes: 0, books: [] }
for (const entry of await fs.readdir(bookList, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === '.51mazi') continue
  const book = inside(bookList, path.join(bookList, entry.name))
  const base = path.join(book, '.51mazi', 'harness', 'v1')
  if (!(await exists(base))) continue
  const states = []
  const conversationRoot = path.join(base, 'conversations')
  if (await exists(conversationRoot)) {
    for (const folder of await fs.readdir(conversationRoot, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue
      const file = inside(book, path.join(conversationRoot, folder.name, 'state.json'))
      if (!(await exists(file))) continue
      const state = await checkedJson(file)
      assert.equal(state.bookKey, entry.name, `Conversation belongs to another book: ${file}`)
      state.toolMode = 'book-primitives-v1'
      states.push({ file, state })
    }
  }
  const indexFile = path.join(base, 'conversations.json')
  let index = null
  if (await exists(indexFile)) {
    index = await checkedJson(indexFile)
    for (const conversation of index.conversations || []) {
      assert.equal(conversation.bookKey, entry.name)
      conversation.toolMode = 'book-primitives-v1'
    }
  }
  if (apply) {
    for (const { file, state } of states) await writeJson(file, state)
    if (index) await writeJson(indexFile, index)
  }
  report.conversations += states.length
  report.indexes += Number(Boolean(index))
  report.books.push({ name: entry.name, conversations: states.length })
}
console.log(JSON.stringify(report, null, 2))
