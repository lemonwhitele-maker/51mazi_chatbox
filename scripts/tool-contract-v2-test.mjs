import assert from 'node:assert/strict'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import { createBookReadTools } from '../src/main/harness/tools/bookReadTools.js'
import { createBodyWriteProposalTools } from '../src/main/harness/tools/bodyWriteProposalTools.js'
import { createKnowledgeWriteProposalTools } from '../src/main/harness/tools/knowledgeWriteProposalTools.js'

const HASH = `sha256:${'a'.repeat(64)}`
const CHAPTER_ID = '正文/第1章.txt'
const CHAPTER_PATH = '正文/正文/第1章.txt'
const REF = `chapter:${encodeURIComponent(CHAPTER_ID)}@${HASH}`
const proposalData = { proposalId: 'proposal-1', status: 'pending', message: 'pending', targetReference: REF }
const registry = new DomainToolRegistry()

createBookReadTools({
  retrievalService: {
    listBookStructure: () => ({
      chapters: [{ targetId: CHAPTER_ID, relativePath: CHAPTER_PATH, reference: REF }]
    }),
    searchBookKnowledge: () => ({ results: [], truncated: false }),
    readBookSource: (_book, reference) => ({
      source: { reference, sourceType: 'chapter', targetId: CHAPTER_ID, contentHash: HASH, authorityStatus: 'authoritative_saved' },
      content: 'content', location: { startLine: 1, endLine: 1 }, truncated: false
    }),
    readBookBacklinks: () => ({ targetReference: REF, items: [], truncated: false }),
    readOutlineContext: () => ({ documents: [], chapterReferences: [], characterReferences: [], settingReferences: [], truncated: false })
  }
}).forEach((tool) => registry.register(tool))
createBodyWriteProposalTools({ proposalService: { createFromTool: async () => ({ data: proposalData }) } })
  .forEach((tool) => registry.register(tool))
createKnowledgeWriteProposalTools({
  proposalService: {
    createFromTool: async () => ({ data: { ...proposalData, affectedSections: [], referenceChanges: [], contentAccepted: true } }),
    createQuickNoteFromTool: async () => ({ data: { ...proposalData, preview: '' } })
  }
}).forEach((tool) => registry.register(tool))

assert.equal(registry.listDefinitions().length, 10)
assert.equal(registry.listDefinitions().every((tool) => tool.version === '2' && tool.contractHash.startsWith('sha256:')), true)
assert.equal(
  registry.listDefinitions().every((tool) => tool.inputSchema?.type === 'object'),
  true,
  'every model-visible tool must explicitly declare an object root schema'
)
assert.equal(registry.getToolsetHash(), registry.getToolsetHash(), 'toolset hash must be stable')
assert.equal(
  registry.listDefinitions()
    .filter((tool) => tool.name.startsWith('propose_'))
    .every((tool) => tool.inputSchema.properties?.operation && tool.inputSchema.required?.includes('operation')),
  true,
  'every proposal schema must expose its operation discriminator at the root'
)

assert.throws(
  () => registry.register({
    name: 'invalid_root_schema',
    version: '2',
    risk: 'read',
    description: 'invalid schema regression probe',
    inputSchema: { oneOf: [{ type: 'object', properties: {} }] },
    execute: async () => ({})
  }),
  (error) => error?.code === 'TOOL_REGISTRATION_INVALID' && /type: "object"/.test(error.message)
)

const common = { summary: 'contract sample', basis: 'creative' }
const document = { documentId: 'doc-1', expectedFileHash: HASH }
const section = { ...document, sectionKey: 'summary', expectedSectionHash: HASH }
const metadata = { title: 'Title' }
const baseOperations = {
  create_document: { title: 'Title', sections: { summary: 'S', 'current-state': 'C', facts: 'F' } },
  patch_document: { ...document, changes: [{ operation: 'update_metadata', metadata }] },
  update_metadata: { ...document, metadata },
  replace_section: { ...section, content: 'content' },
  append_to_section: { ...section, content: 'content' },
  insert_section: { ...document, sectionKey: 'custom', heading: 'Custom', content: 'content' },
  rename_section_label: { ...section, heading: 'Renamed' },
  add_reference: { ...section, reference: REF },
  remove_reference: { ...section, reference: REF },
  archive_document: document
}

const cases = [
  ['list_book_structure', { scopes: ['chapters'] }],
  ['search_book_knowledge', { query: 'q', scopes: ['chapters'] }],
  ['read_book_source', { source: { type: 'reference', reference: REF } }],
  ['read_book_source', { source: { type: 'id', sourceType: 'chapter', objectId: CHAPTER_ID } }],
  ['read_book_source', { source: { type: 'path', relativePath: CHAPTER_PATH } }],
  ['read_book_backlinks', { reference: REF }],
  ['read_outline_context', { reference: `outline:outline-1@${HASH}` }]
]
for (const operation of ['replace_selection', 'insert_before_selection', 'insert_after_selection', 'append_to_chapter']) {
  cases.push(['propose_chapter_edit', { operation, summary: 'chapter', proposedText: 'text' }])
}
for (const toolName of ['propose_character_edit', 'propose_setting_edit']) {
  for (const [operation, fields] of Object.entries(baseOperations)) {
    const args = { operation, ...common, ...structuredClone(fields) }
    if (operation === 'create_document' && toolName === 'propose_setting_edit') {
      args.sections = { definition: 'D', rules: 'R', facts: 'F', custom: 'C' }
      args.metadata = { kind: 'user-defined-kind' }
    }
    cases.push([toolName, args])
  }
}
for (const [operation, fields] of Object.entries(baseOperations)) {
  const args = { operation, ...common, ...structuredClone(fields) }
  if (operation === 'create_document') args.sections = { summary: 'S', details: 'D', constraints: 'C', extra: 'E' }
  if (operation === 'patch_document') args.changes = [{ operation: 'link_chapter', reference: REF }]
  cases.push(['propose_outline_edit', args])
}
for (const [operation, reference] of [['change_order', null], ['link_chapter', REF], ['unlink_chapter', REF], ['link_outline', `outline:other@${HASH}`], ['unlink_outline', `outline:other@${HASH}`]]) {
  cases.push(['propose_outline_edit', { operation, ...common, ...document, ...(operation === 'change_order' ? { order: reference } : { reference }) }])
}
for (const [operation, fields] of [
  ['append_note', { content: 'note' }],
  ['insert_heading_block', { heading: 'H', content: 'note' }],
  ['replace_range', { start: 0, end: 1, content: 'note' }],
  ['archive_block', { start: 0, end: 1 }]
]) cases.push(['propose_quick_note_change', { operation, summary: 'note', expectedFileHash: HASH, ...fields }])

assert.equal(cases.length, 50)
for (const [name, args] of cases) {
  const result = await registry.execute(name, { bookKey: 'book', conversationId: 'conversation', workspace: {} }, args)
  assert.equal(result.ok, true, `${name}/${args.operation || 'read'}: ${result.error?.message || ''}`)
  const unknown = await registry.execute(name, {}, { ...args, __unexpected: true })
  assert.equal(unknown.ok, false, `${name}/${args.operation || 'read'} must reject unknown fields`)
  assert.equal(unknown.error.code, 'TOOL_ARGUMENT_INVALID')
  assert.ok(unknown.error.violations?.length)
}

const crossOperation = await registry.execute('propose_outline_edit', {}, {
  operation: 'archive_document', ...common, ...document, content: 'not allowed here'
})
assert.equal(crossOperation.ok, false)
assert.equal(crossOperation.error.code, 'TOOL_ARGUMENT_INVALID')

const repairedPatch = await registry.execute('propose_outline_edit', {}, {
  basis: 'creative',
  ...document,
  changes: [{ operation: 'replace_section', sectionKey: 'summary', expectedSectionHash: HASH, content: 'normalized patch' }]
})
assert.equal(repairedPatch.ok, true, repairedPatch.error?.message)

console.log('Tool Contract v2: 50 canonical branches passed.')
