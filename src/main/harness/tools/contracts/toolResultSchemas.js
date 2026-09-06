import { closedObject } from './commonSchemas.js'

const violationSchema = closedObject({
  path: { type: 'string' }, keyword: { type: 'string' }, message: { type: 'string' }, params: { type: 'object', additionalProperties: true }
}, ['path', 'keyword', 'message'])
const metaSchema = closedObject({
  contractVersion: { const: '2' }, toolVersion: { type: 'string' }, contractHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }
}, ['contractVersion', 'toolVersion', 'contractHash'])

export const toolResultSchema = { oneOf: [
  closedObject({
    ok: { const: true }, data: {}, references: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    truncated: { type: 'boolean' }, continuation: {}, normalizations: { type: 'array', items: { type: 'object', additionalProperties: true } }, meta: metaSchema
  }, ['ok', 'data', 'references', 'truncated', 'meta']),
  closedObject({
    ok: { const: false },
    error: closedObject({
      code: { type: 'string', minLength: 1 }, message: { type: 'string', minLength: 1 }, retryable: { type: 'boolean' },
      category: { type: 'string' }, retryStrategy: { type: 'string' }, terminal: { type: 'boolean' },
      violations: { type: 'array', items: violationSchema }, nextAction: { type: 'string' }
    }, ['code', 'message', 'retryable']),
    meta: metaSchema
  }, ['ok', 'error', 'meta'])
] }
