export const SETTING_KINDS = Object.freeze([
  'world-rule',
  'location',
  'organization',
  'item',
  'ability',
  'technology',
  'profession',
  'term',
  'historical-event',
  'custom'
])

export const KNOWLEDGE_SECTION_CONTENT_MAX_LENGTH = 30000
export const KNOWLEDGE_SECTIONS_TOTAL_MAX_LENGTH = 30000

export const STABLE_DOCUMENT_REFERENCE_TYPES = Object.freeze([
  'chapter',
  'character',
  'setting',
  'outline',
  'note'
])

export const STABLE_DOCUMENT_REFERENCE_PATTERN =
  '^(chapter|character|setting|outline|note):[^\\s\\\\/@#|\\]]+(?:#[^\\s@|\\]]+)?(?:@sha256:[a-f0-9]{64})?$'

const STABLE_REFERENCE = new RegExp(STABLE_DOCUMENT_REFERENCE_PATTERN)
const VERSION_SUFFIX = /@sha256:[a-f0-9]{64}$/i

export function parseStableDocumentReference(value, expectedType = '') {
  const raw = String(value || '').trim()
  const match = STABLE_REFERENCE.exec(raw)
  if (!match || (expectedType && match[1] !== expectedType)) return null
  const withoutVersion = raw.replace(VERSION_SUFFIX, '')
  const separator = withoutVersion.indexOf(':')
  const type = withoutVersion.slice(0, separator)
  const id = withoutVersion.slice(separator + 1).replace(/#.*$/, '')
  if (!id) return null
  return { type, id, reference: `${type}:${id}` }
}

export function normalizeStoredDocumentReference(value, expectedType) {
  const parsed = parseStableDocumentReference(value, expectedType)
  if (parsed) return parsed.reference
  const raw = String(value || '').trim()
  if (!raw || /[\\s\\/\\\\@#|\\]]/.test(raw)) return null
  return `${expectedType}:${raw}`
}
