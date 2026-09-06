import { TOOL_SCOPES, closedObject, referenceSchema, relativePathSchema, sectionKeySchema } from './commonSchemas.js'

const scopeArraySchema = { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { enum: TOOL_SCOPES } }
const cursorSchema = { type: 'string', minLength: 1, maxLength: 2000 }

export const listBookStructureSchema = closedObject({
  scopes: scopeArraySchema,
  mode: { enum: ['grouped', 'flat'] },
  limitPerScope: { type: 'integer', minimum: 1, maximum: 200 },
  cursor: cursorSchema
}, ['scopes'])

export const searchBookKnowledgeSchema = closedObject({
  query: { type: 'string', minLength: 1, maxLength: 500, pattern: '.*\\S.*' },
  scopes: scopeArraySchema,
  limit: { type: 'integer', minimum: 1, maximum: 12 },
  mode: { enum: ['literal', 'regex', 'semantic', 'hybrid'] },
  cursor: cursorSchema,
  filters: closedObject({
    heading: { type: 'string', minLength: 1, maxLength: 200 },
    kind: { type: 'string', minLength: 1, maxLength: 100 },
    status: { type: 'string', minLength: 1, maxLength: 100 },
    reference: { ...referenceSchema, maxLength: 500 },
    tags: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 100 } }
  })
}, ['query', 'scopes'])

const sourceSchema = { oneOf: [
  closedObject({ type: { const: 'reference' }, reference: referenceSchema }, ['type', 'reference']),
  // Chapter object IDs are safe book-relative IDs such as `正文/第1章.txt`.
  // They are resolved through the current book's structure before reading,
  // so the ID selector must accept the same bounded relative form as paths.
  closedObject({ type: { const: 'id' }, sourceType: { enum: ['chapter', 'character', 'setting', 'outline', 'note', 'conversation'] }, objectId: relativePathSchema }, ['type', 'sourceType', 'objectId']),
  closedObject({ type: { const: 'path' }, relativePath: relativePathSchema }, ['type', 'relativePath'])
] }
const contextSchema = closedObject({ before: { type: 'integer', minimum: 0, maximum: 5 }, after: { type: 'integer', minimum: 0, maximum: 5 } })
const locatorSchema = { oneOf: [
  closedObject({ type: { const: 'reference' } }, ['type']),
  closedObject({ type: { const: 'lines' }, startLine: { type: 'integer', minimum: 1, maximum: 1000000 }, endLine: { type: 'integer', minimum: 1, maximum: 1000000 } }, ['type', 'startLine', 'endLine']),
  closedObject({ type: { const: 'section' }, sectionKey: sectionKeySchema }, ['type', 'sectionKey']),
  closedObject({ type: { const: 'heading' }, heading: { type: 'string', minLength: 1, maxLength: 200 } }, ['type', 'heading'])
] }

export const readBookSourceSchema = closedObject({
  source: sourceSchema,
  locator: locatorSchema,
  context: contextSchema,
  maxChars: { type: 'integer', minimum: 200, maximum: 20000 }
}, ['source'])

export const readBookBacklinksSchema = closedObject({
  reference: referenceSchema,
  includeWeak: { type: 'boolean' },
  limit: { type: 'integer', minimum: 1, maximum: 100 },
  cursor: cursorSchema
}, ['reference'])

export const readOutlineContextSchema = closedObject({
  reference: { ...referenceSchema, pattern: '^(outline|chapter):' },
  maxDepth: { type: 'integer', minimum: 0, maximum: 3 },
  maxRelated: { type: 'integer', minimum: 1, maximum: 30 },
  maxChars: { type: 'integer', minimum: 200, maximum: 20000 }
}, ['reference'])
