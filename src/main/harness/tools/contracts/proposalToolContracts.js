import { closedObject, contentSchema, hashSchema, referenceSchema, sectionKeySchema, shortTextSchema, sourceReferenceArraySchema, stableIdSchema } from './commonSchemas.js'

const reasonSchema = { type: 'string', maxLength: 1000 }
const headingSchema = { type: 'string', minLength: 1, maxLength: 200, pattern: '.*\\S.*' }
const titleSchema = { ...headingSchema }
const statusSchema = { enum: ['draft', 'confirmed', 'planned', 'deprecated'] }
const textArray = (maxItems = 100, pattern) => ({
  type: 'array', minItems: 0, maxItems, uniqueItems: true,
  items: { type: 'string', minLength: 1, maxLength: 200, ...(pattern ? { pattern } : {}) }
})

const metadataProfiles = {
  character: closedObject({ title: titleSchema, status: statusSchema, aliases: textArray(), tags: textArray() }),
  setting: closedObject({
    title: titleSchema, status: statusSchema, aliases: textArray(), tags: textArray(),
    kind: { type: 'string', minLength: 1, maxLength: 100, pattern: '.*\\S.*' }
  }),
  outline: closedObject({
    title: titleSchema, status: statusSchema, tags: textArray(), order: { type: ['number', 'null'] },
    relatedOutlines: textArray(200, '^outline:'), chapterRefs: textArray(200, '^chapter:'),
    characterRefs: textArray(200, '^character:'), settingRefs: textArray(200, '^setting:')
  })
}

const basisConstraint = { oneOf: [
  { type: 'object', required: ['basis'], properties: { basis: { const: 'creative' } }, not: { required: ['sourceReferences'] } },
  { type: 'object', required: ['basis', 'sourceReferences'], properties: { basis: { const: 'source_grounded' }, sourceReferences: sourceReferenceArraySchema } }
] }

function operationBranch(operation, businessProperties, required = []) {
  return closedObject({
    operation: { const: operation }, summary: shortTextSchema, reason: reasonSchema,
    basis: { enum: ['source_grounded', 'creative'] }, sourceReferences: sourceReferenceArraySchema,
    ...businessProperties
  }, ['operation', 'summary', 'basis', ...required])
}

function sectionMap(requiredSections) {
  return {
    type: 'object', minProperties: requiredSections.length, maxProperties: 100,
    properties: Object.fromEntries(requiredSections.map((key) => [key, contentSchema])),
    required: requiredSections,
    patternProperties: { '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$': contentSchema },
    additionalProperties: false
  }
}

const documentTarget = { documentId: stableIdSchema, expectedFileHash: hashSchema }
const sectionTarget = { ...documentTarget, sectionKey: sectionKeySchema, expectedSectionHash: hashSchema }

function nestedChangeSchemas(documentType) {
  const metadata = metadataProfiles[documentType]
  const schemas = [
    closedObject({ operation: { const: 'update_metadata' }, metadata: { ...metadata, minProperties: 1 } }, ['operation', 'metadata']),
    closedObject({ operation: { const: 'replace_section' }, sectionKey: sectionKeySchema, expectedSectionHash: hashSchema, content: contentSchema }, ['operation', 'sectionKey', 'expectedSectionHash', 'content']),
    closedObject({ operation: { const: 'append_to_section' }, sectionKey: sectionKeySchema, expectedSectionHash: hashSchema, content: contentSchema }, ['operation', 'sectionKey', 'expectedSectionHash', 'content']),
    closedObject({ operation: { const: 'insert_section' }, sectionKey: sectionKeySchema, heading: headingSchema, content: contentSchema, afterSectionKey: sectionKeySchema }, ['operation', 'sectionKey', 'heading', 'content']),
    closedObject({ operation: { const: 'rename_section_label' }, sectionKey: sectionKeySchema, expectedSectionHash: hashSchema, heading: headingSchema }, ['operation', 'sectionKey', 'expectedSectionHash', 'heading']),
    closedObject({ operation: { const: 'add_reference' }, sectionKey: sectionKeySchema, expectedSectionHash: hashSchema, reference: { ...referenceSchema, maxLength: 500 }, label: { type: 'string', maxLength: 200 } }, ['operation', 'sectionKey', 'expectedSectionHash', 'reference']),
    closedObject({ operation: { const: 'remove_reference' }, sectionKey: sectionKeySchema, expectedSectionHash: hashSchema, reference: { ...referenceSchema, maxLength: 500 } }, ['operation', 'sectionKey', 'expectedSectionHash', 'reference'])
  ]
  if (documentType === 'outline') {
    for (const [operation, pattern] of [['link_chapter', '^chapter:'], ['unlink_chapter', '^chapter:'], ['link_outline', '^outline:'], ['unlink_outline', '^outline:']]) {
      schemas.push(closedObject({ operation: { const: operation }, reference: { ...referenceSchema, maxLength: 500, pattern } }, ['operation', 'reference']))
    }
  }
  return schemas
}

function knowledgeProposalSchema(documentType, requiredSections) {
  const metadata = metadataProfiles[documentType]
  const createMetadata = documentType === 'setting' ? { ...metadata, required: ['kind'] } : metadata
  const branches = [
    operationBranch('create_document', { title: titleSchema, sections: sectionMap(requiredSections), metadata: createMetadata }, documentType === 'setting' ? ['title', 'sections', 'metadata'] : ['title', 'sections']),
    operationBranch('patch_document', { ...documentTarget, changes: { type: 'array', minItems: 1, maxItems: 12, items: { oneOf: nestedChangeSchemas(documentType) } } }, ['documentId', 'expectedFileHash', 'changes']),
    operationBranch('update_metadata', { ...documentTarget, metadata: { ...metadata, minProperties: 1 } }, ['documentId', 'expectedFileHash', 'metadata']),
    operationBranch('replace_section', { ...sectionTarget, content: contentSchema }, ['documentId', 'expectedFileHash', 'sectionKey', 'expectedSectionHash', 'content']),
    operationBranch('append_to_section', { ...sectionTarget, content: contentSchema }, ['documentId', 'expectedFileHash', 'sectionKey', 'expectedSectionHash', 'content']),
    operationBranch('insert_section', { ...documentTarget, sectionKey: sectionKeySchema, heading: headingSchema, content: contentSchema, afterSectionKey: sectionKeySchema }, ['documentId', 'expectedFileHash', 'sectionKey', 'heading', 'content']),
    operationBranch('rename_section_label', { ...sectionTarget, heading: headingSchema }, ['documentId', 'expectedFileHash', 'sectionKey', 'expectedSectionHash', 'heading']),
    operationBranch('add_reference', { ...sectionTarget, reference: { ...referenceSchema, maxLength: 500 }, label: { type: 'string', maxLength: 200 } }, ['documentId', 'expectedFileHash', 'sectionKey', 'expectedSectionHash', 'reference']),
    operationBranch('remove_reference', { ...sectionTarget, reference: { ...referenceSchema, maxLength: 500 } }, ['documentId', 'expectedFileHash', 'sectionKey', 'expectedSectionHash', 'reference']),
    operationBranch('archive_document', documentTarget, ['documentId', 'expectedFileHash'])
  ]
  if (documentType === 'outline') {
    branches.push(operationBranch('change_order', { ...documentTarget, order: { type: ['number', 'null'] } }, ['documentId', 'expectedFileHash', 'order']))
    for (const [operation, pattern] of [['link_chapter', '^chapter:'], ['unlink_chapter', '^chapter:'], ['link_outline', '^outline:'], ['unlink_outline', '^outline:']]) {
      branches.push(operationBranch(operation, { ...documentTarget, reference: { ...referenceSchema, maxLength: 500, pattern } }, ['documentId', 'expectedFileHash', 'reference']))
    }
  }
  // OpenAI-compatible providers inspect root properties when prompting the
  // model. Keep the strict per-operation branches, but also expose their
  // shared discriminator fields at the root so providers do not omit them.
  return {
    type: 'object',
    properties: {
      operation: { enum: branches.map((branch) => branch.properties.operation.const) },
      summary: shortTextSchema,
      reason: reasonSchema,
      basis: { enum: ['source_grounded', 'creative'] },
      sourceReferences: sourceReferenceArraySchema
    },
    required: ['operation', 'summary', 'basis'],
    allOf: [{ oneOf: branches }, basisConstraint]
  }
}

export const proposeCharacterEditSchema = knowledgeProposalSchema('character', ['summary', 'current-state', 'facts'])
export const proposeSettingEditSchema = knowledgeProposalSchema('setting', ['definition', 'rules', 'facts'])
export const proposeOutlineEditSchema = knowledgeProposalSchema('outline', ['summary', 'details', 'constraints'])

const chapterOperations = ['replace_selection', 'insert_before_selection', 'insert_after_selection', 'append_to_chapter']
export const proposeChapterEditSchema = {
  type: 'object',
  properties: {
    operation: { enum: chapterOperations },
    summary: shortTextSchema,
    proposedText: contentSchema
  },
  required: ['operation', 'summary', 'proposedText'],
  oneOf: chapterOperations.map((operation) =>
    closedObject({ operation: { const: operation }, summary: shortTextSchema, proposedText: contentSchema }, ['operation', 'summary', 'proposedText'])
  )
}

function quickNoteBranch(operation, properties, required) {
  return closedObject({ operation: { const: operation }, summary: shortTextSchema, reason: reasonSchema, expectedFileHash: hashSchema, ...properties }, ['operation', 'summary', 'expectedFileHash', ...required])
}
const quickNoteOperations = ['append_note', 'insert_heading_block', 'replace_range', 'archive_block']
export const proposeQuickNoteChangeSchema = {
  type: 'object',
  properties: {
    operation: { enum: quickNoteOperations },
    summary: shortTextSchema,
    reason: reasonSchema,
    expectedFileHash: hashSchema
  },
  required: ['operation', 'summary', 'expectedFileHash'],
  oneOf: [
    quickNoteBranch('append_note', { content: contentSchema }, ['content']),
    quickNoteBranch('insert_heading_block', { heading: headingSchema, content: contentSchema }, ['heading', 'content']),
    quickNoteBranch('replace_range', { start: { type: 'integer', minimum: 0, maximum: 500000 }, end: { type: 'integer', minimum: 0, maximum: 500000 }, content: contentSchema }, ['start', 'end', 'content']),
    quickNoteBranch('archive_block', { start: { type: 'integer', minimum: 0, maximum: 500000 }, end: { type: 'integer', minimum: 0, maximum: 500000 } }, ['start', 'end'])
  ]
}
