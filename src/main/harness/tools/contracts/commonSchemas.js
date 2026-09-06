export const HASH_PATTERN = '^sha256:[a-f0-9]{64}$'
export const SECTION_KEY_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
export const REFERENCE_PATTERN = '^(chapter|character|setting|outline|note|conversation):[^\\s\\\\/][^\\r\\n]{0,1990}$'

export const hashSchema = Object.freeze({ type: 'string', pattern: HASH_PATTERN })
export const sectionKeySchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 120, pattern: SECTION_KEY_PATTERN })
export const referenceSchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 2000, pattern: REFERENCE_PATTERN })
export const stableIdSchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 240, pattern: '^(?!.*(?:[\\\\/]|\\.\\.))\\S(?:.*\\S)?$' })
export const relativePathSchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 500, pattern: '^(?![A-Za-z]:)(?![/\\\\])(?!.*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))(?!.*[/\\\\]{2})[^\\r\\n]+$' })
export const shortTextSchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 120, pattern: '.*\\S.*' })
export const contentSchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 30000, pattern: '.*\\S.*' })

export const TOOL_SCOPES = Object.freeze(['chapters', 'characters', 'settings', 'outlines', 'notes', 'conversations'])

export const sourceReferenceArraySchema = Object.freeze({
  type: 'array', minItems: 1, maxItems: 24, uniqueItems: true, items: referenceSchema
})

export function closedObject(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required }
}
