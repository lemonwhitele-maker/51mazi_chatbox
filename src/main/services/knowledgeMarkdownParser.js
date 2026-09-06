import crypto from 'node:crypto'
import yaml from 'js-yaml'

export const KNOWLEDGE_DOCUMENT_PROFILES = Object.freeze({
  character: Object.freeze({
    type: 'character',
    requiredMetadata: ['id', 'type', 'title', 'status', 'aliases', 'tags'],
    arrayMetadata: ['aliases', 'tags'],
    requiredSections: ['summary', 'current-state', 'facts']
  }),
  setting: Object.freeze({
    type: 'setting',
    requiredMetadata: ['id', 'type', 'kind', 'title', 'status', 'aliases', 'tags'],
    arrayMetadata: ['aliases', 'tags'],
    requiredSections: ['definition', 'rules', 'facts']
  }),
  outline: Object.freeze({
    type: 'outline',
    requiredMetadata: [
      'id',
      'type',
      'title',
      'status',
      'tags',
      'order',
      'relatedOutlines',
      'chapterRefs',
      'characterRefs',
      'settingRefs'
    ],
    arrayMetadata: ['tags', 'relatedOutlines', 'chapterRefs', 'characterRefs', 'settingRefs'],
    requiredSections: ['summary', 'details', 'constraints']
  })
})

const SETTING_KINDS = new Set([
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
const STATUSES = new Set(['draft', 'confirmed', 'planned', 'deprecated'])
const SECTION_HEADING =
  /^###[ \t]+(.*?)[ \t]*<!--[ \t]*51:section=([A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*-->[ \t]*$/
const REFERENCE_PATTERN =
  /\[\[(character|setting|outline|chapter|note):([^\]|\s]+)(?:\|([^\]]*))?\]\]/gi

export function hashKnowledgeText(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(Buffer.from(String(value ?? ''), 'utf8'))
    .digest('hex')}`
}

function linesWithOffsets(source) {
  const lines = []
  const newline = /\r\n|\n|\r/g
  let start = 0
  let lineNumber = 1
  let match
  while ((match = newline.exec(source))) {
    lines.push({
      lineNumber,
      start,
      textEnd: match.index,
      end: newline.lastIndex,
      text: source.slice(start, match.index),
      eol: match[0]
    })
    start = newline.lastIndex
    lineNumber += 1
  }
  if (start < source.length || source.length === 0) {
    lines.push({
      lineNumber,
      start,
      textEnd: source.length,
      end: source.length,
      text: source.slice(start),
      eol: ''
    })
  }
  return lines
}

function dominantLineEnding(source) {
  const crlf = (source.match(/\r\n/g) || []).length
  const withoutCrlf = source.replace(/\r\n/g, '')
  const lf = (withoutCrlf.match(/\n/g) || []).length
  const cr = (withoutCrlf.match(/\r/g) || []).length
  if (crlf >= lf && crlf >= cr && crlf) return '\r\n'
  if (lf >= cr && lf) return '\n'
  if (cr) return '\r'
  return '\n'
}

function diagnostic(code, message, path = '', severity = 'error') {
  return { code, message, path, severity }
}

function parseFrontmatter(source, lines, diagnostics) {
  const first = lines[0]
  const bomLength = source.startsWith('\uFEFF') ? 1 : 0
  if (!first || source.slice(bomLength, first.textEnd) !== '---') {
    diagnostics.push(
      diagnostic('FRONTMATTER_MISSING', '知识文档必须以 YAML frontmatter 开始', 'frontmatter')
    )
    return { metadata: {}, raw: '', start: bomLength, end: bomLength, bodyStart: bomLength }
  }

  let closing = null
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].text === '---' || lines[index].text === '...') {
      closing = lines[index]
      break
    }
  }
  if (!closing) {
    diagnostics.push(
      diagnostic('FRONTMATTER_UNCLOSED', 'YAML frontmatter 缺少结束标记', 'frontmatter')
    )
    return {
      metadata: {},
      raw: source.slice(first.end),
      start: first.start,
      end: source.length,
      bodyStart: source.length
    }
  }

  const raw = source.slice(first.end, closing.start)
  let metadata = {}
  try {
    const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA })
    if (parsed == null) metadata = {}
    else if (typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed
    else
      diagnostics.push(
        diagnostic('FRONTMATTER_NOT_OBJECT', 'YAML frontmatter 必须是键值对象', 'frontmatter')
      )
  } catch (error) {
    diagnostics.push(
      diagnostic(
        'FRONTMATTER_INVALID',
        `YAML frontmatter 无法解析：${error.message}`,
        'frontmatter'
      )
    )
  }
  return { metadata, raw, start: first.start, end: closing.end, bodyStart: closing.end }
}

export function extractKnowledgeReferences(source) {
  const references = []
  let match
  while ((match = REFERENCE_PATTERN.exec(String(source || '')))) {
    const before = String(source || '').slice(0, match.index)
    references.push({
      sourceType: match[1].toLowerCase(),
      targetId: match[2],
      label: match[3] || '',
      raw: match[0],
      start: match.index,
      end: REFERENCE_PATTERN.lastIndex,
      line: before.split(/\r\n|\n|\r/).length
    })
  }
  return references
}

export function parseKnowledgeMarkdown(value) {
  const source = String(value ?? '')
  const diagnostics = []
  const lines = linesWithOffsets(source)
  const frontmatter = parseFrontmatter(source, lines, diagnostics)
  const headings = []

  for (const line of lines) {
    if (line.start < frontmatter.bodyStart) continue
    const match = SECTION_HEADING.exec(line.text)
    if (!match) continue
    headings.push({
      key: match[2],
      title: match[1].trim(),
      headingStart: line.start,
      headingEnd: line.end,
      headingLine: line.lineNumber
    })
  }

  const sections = headings.map((heading, index) => {
    const next = headings[index + 1]
    const contentStart = heading.headingEnd
    const contentEnd = next?.headingStart ?? source.length
    const rawContent = source.slice(contentStart, contentEnd)
    return {
      ...heading,
      contentStart,
      contentEnd,
      startLine: heading.headingLine,
      contentStartLine: heading.headingLine + 1,
      endLine: next ? next.headingLine - 1 : lines.at(-1)?.lineNumber || heading.headingLine,
      rawContent,
      content: rawContent,
      contentHash: hashKnowledgeText(rawContent)
    }
  })

  const sectionMap = {}
  for (const section of sections) {
    if (sectionMap[section.key]) {
      diagnostics.push(
        diagnostic(
          'SECTION_KEY_DUPLICATE',
          `稳定 section 重复：${section.key}`,
          `sections.${section.key}`
        )
      )
      continue
    }
    sectionMap[section.key] = section
  }

  return {
    source,
    contentHash: hashKnowledgeText(source),
    lineEnding: dominantLineEnding(source),
    metadata: frontmatter.metadata,
    frontmatter,
    sections,
    sectionMap,
    references: extractKnowledgeReferences(source),
    diagnostics
  }
}

export function validateKnowledgeDocument(document, { expectedType = '', mode = 'formal' } = {}) {
  const parsed = typeof document === 'string' ? parseKnowledgeMarkdown(document) : document
  const diagnostics = [...(parsed?.diagnostics || [])]
  const metadata = parsed?.metadata || {}
  const type = String(metadata.type || '')
  const profile = KNOWLEDGE_DOCUMENT_PROFILES[type]
  const missingSeverity = mode === 'draft' ? 'warning' : 'error'

  if (!profile)
    diagnostics.push(
      diagnostic('TYPE_UNSUPPORTED', 'type 必须是 character、setting 或 outline', 'metadata.type')
    )
  if (expectedType && type && type !== expectedType) {
    diagnostics.push(
      diagnostic('TYPE_MISMATCH', `文档 type 必须是 ${expectedType}`, 'metadata.type')
    )
  }

  if (profile) {
    for (const key of profile.requiredMetadata) {
      if (
        !Object.prototype.hasOwnProperty.call(metadata, key) ||
        metadata[key] === '' ||
        metadata[key] === undefined
      ) {
        diagnostics.push(
          diagnostic(
            'METADATA_REQUIRED',
            `缺少强制元数据：${key}`,
            `metadata.${key}`,
            missingSeverity
          )
        )
      }
    }
    for (const key of profile.arrayMetadata) {
      if (Object.prototype.hasOwnProperty.call(metadata, key) && !Array.isArray(metadata[key])) {
        diagnostics.push(
          diagnostic('METADATA_ARRAY_REQUIRED', `${key} 必须是数组`, `metadata.${key}`)
        )
      }
    }
    for (const key of profile.requiredSections) {
      if (!parsed.sectionMap?.[key]) {
        diagnostics.push(
          diagnostic(
            'SECTION_REQUIRED',
            `缺少强制 section：${key}`,
            `sections.${key}`,
            missingSeverity
          )
        )
      }
    }
  }

  if (metadata.status && !STATUSES.has(String(metadata.status))) {
    diagnostics.push(
      diagnostic(
        'STATUS_UNSUPPORTED',
        'status 必须是 draft、confirmed、planned 或 deprecated',
        'metadata.status'
      )
    )
  }
  if (type === 'setting' && metadata.kind && !SETTING_KINDS.has(String(metadata.kind))) {
    diagnostics.push(
      diagnostic(
        'SETTING_KIND_UNSUPPORTED',
        '设定 kind 不在支持列表中；自定义类型请使用 custom',
        'metadata.kind'
      )
    )
  }
  if (
    type === 'outline' &&
    metadata.order !== null &&
    metadata.order !== undefined &&
    typeof metadata.order !== 'number'
  ) {
    diagnostics.push(
      diagnostic('OUTLINE_ORDER_INVALID', '大纲 order 必须是数字或 null', 'metadata.order')
    )
  }

  return {
    valid: !diagnostics.some((item) => item.severity === 'error'),
    diagnostics,
    profile: profile?.type || null
  }
}

function normalizeReplacementContent(rawContent, nextContent, lineEnding) {
  const raw = String(rawContent || '')
  const normalized = String(nextContent ?? '')
    .replace(/\r\n|\n|\r/g, '\n')
    .replace(/^(?:\n)+|(?:\n)+$/g, '')
    .replace(/\n/g, lineEnding)
  const onlyNewlines = /^(?:\r\n|\n|\r)*$/.test(raw)
  if (onlyNewlines) {
    if (!normalized) return raw
    return `${raw || lineEnding}${normalized}${lineEnding}`
  }
  const leading = raw.match(/^(?:\r\n|\n|\r)*/)?.[0] || ''
  const remainder = raw.slice(leading.length)
  const trailing = remainder.match(/(?:\r\n|\n|\r)*$/)?.[0] || ''
  if (!normalized) return `${leading}${trailing || lineEnding}`
  return `${leading}${normalized}${trailing}`
}

export function serializeKnowledgeMarkdown(document, { sectionUpdates = {} } = {}) {
  const parsed = typeof document === 'string' ? parseKnowledgeMarkdown(document) : document
  const updates = Object.entries(sectionUpdates || {})
  if (!updates.length) return parsed.source
  const replacements = updates
    .map(([key, value]) => {
      const matches = parsed.sections.filter((section) => section.key === key)
      if (matches.length !== 1)
        throw new Error(
          matches.length ? `稳定 section 重复：${key}` : `稳定 section 不存在：${key}`
        )
      const section = matches[0]
      return {
        start: section.contentStart,
        end: section.contentEnd,
        value: normalizeReplacementContent(section.rawContent, value, parsed.lineEnding)
      }
    })
    .sort((a, b) => b.start - a.start)

  let source = parsed.source
  for (const replacement of replacements) {
    source = `${source.slice(0, replacement.start)}${replacement.value}${source.slice(replacement.end)}`
  }
  return source
}

export function replaceKnowledgeSection(
  document,
  sectionKey,
  content,
  { expectedSectionHash = '' } = {}
) {
  const parsed = typeof document === 'string' ? parseKnowledgeMarkdown(document) : document
  const matches = parsed.sections.filter((section) => section.key === String(sectionKey || ''))
  if (matches.length !== 1)
    throw new Error(
      matches.length ? `稳定 section 重复：${sectionKey}` : `稳定 section 不存在：${sectionKey}`
    )
  if (expectedSectionHash && matches[0].contentHash !== expectedSectionHash) {
    const error = new Error('知识文档 section 已发生变化，请重新读取后再修改')
    error.code = 'KNOWLEDGE_SECTION_VERSION_CONFLICT'
    error.expectedHash = expectedSectionHash
    error.currentHash = matches[0].contentHash
    throw error
  }
  return serializeKnowledgeMarkdown(parsed, { sectionUpdates: { [sectionKey]: content } })
}
