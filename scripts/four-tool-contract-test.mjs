import assert from 'node:assert/strict'
import Ajv from 'ajv'
import { documentToolContracts } from '../src/main/harness/tools/contracts/documentToolContracts.js'

const contracts = Object.fromEntries(documentToolContracts.map((tool) => [tool.name, tool]))
assert.deepEqual(Object.keys(contracts).sort(), ['create', 'edit', 'list_files', 'read', 'write'])
assert.match(contracts.read.description, /path="help\/index\.md"/)
assert.match(contracts.read.description, /书籍文档使用 book\//)
const schemas = Object.values(contracts).map((tool) => tool.inputSchema)
assert(schemas.every((schema) => schema.type === 'object' && schema.additionalProperties === false))
assert(schemas.reduce((length, schema) => length + JSON.stringify(schema).length, 0) < 6000)
assert.equal(JSON.stringify(schemas).includes('"operation"'), false)
assert.equal(JSON.stringify(schemas).includes('"oneOf"'), false)

const ajv = new Ajv({ strict: true, allErrors: true })
const valid = {
  list_files: {},
  read: { path: 'book/' },
  create: { directory: 'book/knowledge/characters/', content: '内容' },
  write: { path: 'book/notes/quick-notes.md', content: '内容' },
  edit: { path: 'book/notes/quick-notes.md', edits: [{ oldText: '旧', newText: '新' }] }
}
for (const [name, contract] of Object.entries(contracts)) {
  const validate = ajv.compile(contract.inputSchema)
  assert.equal(validate(valid[name]), true, `${name} valid arguments`)
  for (const extra of ['bookName', 'scopeId', 'confirmed', 'operation', 'expectedFileHash'])
    assert.equal(validate({ ...valid[name], [extra]: 'forbidden' }), false, `${name} must reject ${extra}`)
}
const validateEdit = ajv.compile(contracts.edit.inputSchema)
assert.equal(validateEdit({ path: 'book/chapters/第一卷/开端.txt', edits: [{ newText: '替换后文本' }] }), true)
assert.equal(validateEdit({ path: 'book/chapters/第一卷/开端.txt', edits: [{ newText: '' }] }), true)
assert.equal(validateEdit({ path: 'book/chapters/第一卷/开端.txt', edits: [{}] }), false)
assert.equal(validateEdit({ path: 'book/chapters/第一卷/开端.txt', edits: [{ newText: '新', start: 0, end: 1 }] }), false)
console.log('Four-tool contract test passed')
