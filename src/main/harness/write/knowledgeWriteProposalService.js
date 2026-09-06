import crypto from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { writeFileAtomically } from '../../services/chapterWriteService.js'
import { QUICK_NOTES_RELATIVE_PATH } from '../../services/harnessQuickNotesService.js'
import {
  KNOWLEDGE_DOCUMENT_PROFILES,
  extractKnowledgeReferences,
  parseKnowledgeMarkdown,
  replaceKnowledgeSection
} from '../../services/knowledgeMarkdownParser.js'
import { HarnessError } from '../harnessErrors.js'
import { createId, nowIso } from '../ids.js'
import WriteProposalStateMachine, {
  publicWriteProposal,
  transitionWriteProposal,
  writeProposalFailure
} from './writeProposalStateMachine.js'

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/i
const SECTION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SCOPE_CONFIG = Object.freeze({
  character: { scope: 'characters', prefix: 'char' },
  setting: { scope: 'settings', prefix: 'setting' },
  outline: { scope: 'outlines', prefix: 'outline' }
})
const COMMON_OPERATIONS = new Set([
  'create_document',
  'patch_document',
  'update_metadata',
  'replace_section',
  'append_to_section',
  'insert_section',
  'rename_section_label',
  'add_reference',
  'remove_reference',
  'archive_document'
])
const OUTLINE_OPERATIONS = new Set([
  'change_order',
  'link_chapter',
  'unlink_chapter',
  'link_outline',
  'unlink_outline'
])
const NOTE_OPERATIONS = new Set([
  'append_note',
  'insert_heading_block',
  'replace_range',
  'archive_block'
])
const SECTION_OPERATIONS = new Set([
  'replace_section',
  'append_to_section',
  'rename_section_label',
  'add_reference',
  'remove_reference'
])
const METADATA_FIELDS = Object.freeze({
  character: new Set(['title', 'status', 'aliases', 'tags']),
  setting: new Set(['title', 'status', 'aliases', 'tags', 'kind']),
  outline: new Set([
    'title',
    'status',
    'tags',
    'order',
    'relatedOutlines',
    'chapterRefs',
    'characterRefs',
    'settingRefs'
  ])
})
const COMMON_ARGUMENT_FIELDS = new Set([
  'operation',
  'summary',
  'reason',
  'basis',
  'sourceReferences'
])
const OPERATION_ARGUMENT_FIELDS = Object.freeze({
  create_document: new Set(['title', 'metadata', 'sections']),
  patch_document: new Set(['documentId', 'expectedFileHash', 'changes']),
  update_metadata: new Set(['documentId', 'expectedFileHash', 'metadata']),
  replace_section: new Set(['documentId', 'expectedFileHash', 'expectedSectionHash', 'sectionKey', 'content']),
  append_to_section: new Set(['documentId', 'expectedFileHash', 'expectedSectionHash', 'sectionKey', 'content']),
  insert_section: new Set(['documentId', 'expectedFileHash', 'sectionKey', 'afterSectionKey', 'heading', 'content']),
  rename_section_label: new Set(['documentId', 'expectedFileHash', 'expectedSectionHash', 'sectionKey', 'heading']),
  add_reference: new Set(['documentId', 'expectedFileHash', 'expectedSectionHash', 'sectionKey', 'reference', 'label']),
  remove_reference: new Set(['documentId', 'expectedFileHash', 'expectedSectionHash', 'sectionKey', 'reference']),
  archive_document: new Set(['documentId', 'expectedFileHash']),
  change_order: new Set(['documentId', 'expectedFileHash', 'order']),
  link_chapter: new Set(['documentId', 'expectedFileHash', 'reference']),
  unlink_chapter: new Set(['documentId', 'expectedFileHash', 'reference']),
  link_outline: new Set(['documentId', 'expectedFileHash', 'reference']),
  unlink_outline: new Set(['documentId', 'expectedFileHash', 'reference'])
})

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function requiredText(value, name, maxLength = 30000) {
  const text = String(value ?? '').trim()
  if (!text || text.length > maxLength) {
    throw new HarnessError('TOOL_ARGUMENT_INVALID', `${name} 不能为空或超过长度限制`)
  }
  return text
}

function requireHash(value, name) {
  const hash = String(value || '')
  if (!HASH_PATTERN.test(hash)) {
    throw new HarnessError('TOOL_ARGUMENT_INVALID', `${name} 必须是有效的 sha256 哈希`)
  }
  return hash
}

function validateOperationArguments(documentType, args, { nested = false } = {}) {
  const operation = String(args?.operation || '')
  const allowed = OPERATION_ARGUMENT_FIELDS[operation]
  if (!allowed) throw new HarnessError('KNOWLEDGE_OPERATION_INVALID', '不支持的知识文档修改操作')
  const common = nested ? new Set(['operation']) : COMMON_ARGUMENT_FIELDS
  for (const key of Object.keys(args || {})) {
    if (!common.has(key) && !allowed.has(key)) {
      throw new HarnessError(
        'TOOL_ARGUMENT_INVALID',
        `${operation} 不接受参数：${key}`
      )
    }
  }
  if (!nested) {
    const basis = String(args.basis || '')
    if (!['source_grounded', 'creative'].includes(basis)) {
      throw new HarnessError('KNOWLEDGE_EVIDENCE_BASIS_REQUIRED', '必须声明提案依据是 source_grounded 或 creative')
    }
  }
  if (operation === 'create_document') {
    requiredText(args.title, 'title', 200)
    if (documentType === 'setting') requiredText(args.metadata?.kind, 'metadata.kind', 100)
    const requiredSections = KNOWLEDGE_DOCUMENT_PROFILES[documentType]?.requiredSections || []
    if (!args.sections || typeof args.sections !== 'object' || Array.isArray(args.sections)) {
      throw new HarnessError('TOOL_ARGUMENT_INVALID', 'create_document 必须提供 sections')
    }
    const supplied = Object.keys(args.sections)
    const unsupported = supplied.filter((key) => !SECTION_KEY_PATTERN.test(key) || key.length > 120)
    if (unsupported.length) throw new HarnessError('TOOL_ARGUMENT_INVALID', `create_document 包含无效 section key：${unsupported.join('、')}`)
    for (const key of supplied) requiredText(args.sections[key], `sections.${key}`)
    for (const key of requiredSections) requiredText(args.sections[key], `sections.${key}`)
    return
  }
  if (!nested) {
    requiredText(args.documentId, 'documentId', 240)
    requireHash(args.expectedFileHash, 'expectedFileHash')
  }
  if (operation === 'patch_document') {
    if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > 12) {
      throw new HarnessError('TOOL_ARGUMENT_INVALID', 'patch_document 必须包含 1-12 项 changes')
    }
    const keys = new Set()
    for (const change of args.changes) {
      validateOperationArguments(documentType, change, { nested: true })
      if (['create_document', 'patch_document', 'archive_document', 'change_order'].includes(change.operation)) {
        throw new HarnessError('TOOL_ARGUMENT_INVALID', `patch_document 不支持子操作：${change.operation}`)
      }
      const key = changeConflictKeys(documentType, change).join('|')
      if (key && keys.has(key)) {
        throw new HarnessError('TOOL_ARGUMENT_INVALID', `patch_document 重复修改同一目标：${key}`)
      }
      if (key) keys.add(key)
    }
    return
  }
  if (SECTION_OPERATIONS.has(operation)) {
    requiredText(args.sectionKey, 'sectionKey', 120)
    requireHash(args.expectedSectionHash, 'expectedSectionHash')
  }
  if (operation === 'replace_section' || operation === 'append_to_section') {
    requiredText(args.content, 'content')
  } else if (operation === 'insert_section') {
    requiredText(args.sectionKey, 'sectionKey', 120)
    requiredText(args.heading, 'heading', 200)
    requiredText(args.content, 'content')
  } else if (operation === 'rename_section_label') {
    requiredText(args.heading, 'heading', 200)
  } else if (operation === 'update_metadata') {
    if (!args.metadata || typeof args.metadata !== 'object' || !Object.keys(args.metadata).length) {
      throw new HarnessError('TOOL_ARGUMENT_INVALID', 'update_metadata 必须提供 metadata')
    }
  } else if (operation === 'add_reference' || operation === 'remove_reference' || OUTLINE_OPERATIONS.has(operation)) {
    requiredText(args.reference, 'reference', 500)
  }
}

function validateEvidence(context, args) {
  const basis = String(args.basis || '')
  const references = [...new Set((args.sourceReferences || []).map((item) => String(item || '').trim()).filter(Boolean))]
  if (basis === 'creative') {
    if (references.length) {
      throw new HarnessError('KNOWLEDGE_EVIDENCE_INVALID', 'creative 提案不能伪装为正式来源提案')
    }
    return { basis, sourceReferences: [], evidence: [] }
  }
  if (!references.length) {
    throw new HarnessError('KNOWLEDGE_EVIDENCE_REQUIRED', 'source_grounded 提案必须提供本轮已读取的正式来源')
  }
  if (context.evidenceEnforced !== true) {
    return { basis, sourceReferences: references, evidence: [] }
  }
  const available = new Map(
    (context.evidenceReferences || []).map((item) => [String(item.reference || ''), item])
  )
  const evidence = references.map((reference) => {
    const item = available.get(reference)
    if (!item) {
      throw new HarnessError('KNOWLEDGE_EVIDENCE_NOT_READ', '提案引用了本轮未通过 read_book_source 读取的来源')
    }
    return item
  })
  if (!evidence.some((item) => item.authorityStatus === 'authoritative_saved')) {
    const statuses = [...new Set(evidence.map((item) => item.authorityStatus || 'unknown'))]
    throw new HarnessError(
      'KNOWLEDGE_AUTHORITATIVE_EVIDENCE_REQUIRED',
      `正式资料提案至少需要一个 authoritative_saved 来源；当前已读取来源状态：${statuses.join(', ')}`
    )
  }
  return { basis, sourceReferences: references, evidence }
}

function changeConflictKeys(documentType, args) {
  const operation = String(args?.operation || '')
  if (operation === 'patch_document') {
    return [...new Set((args.changes || []).flatMap((change) => changeConflictKeys(documentType, change)))]
  }
  if (SECTION_OPERATIONS.has(operation) || operation === 'insert_section') {
    return [`section:${String(args.sectionKey || '')}`]
  }
  if (operation === 'update_metadata') {
    return Object.keys(args.metadata || {}).map((key) => `metadata:${key}`)
  }
  if (operation === 'archive_document') return ['metadata:status']
  if (operation === 'change_order') return ['metadata:order']
  if (operation === 'link_chapter' || operation === 'unlink_chapter') return ['metadata:chapterRefs']
  if (operation === 'link_outline' || operation === 'unlink_outline') return ['metadata:relatedOutlines']
  return [`operation:${documentType}:${operation}`]
}

function proposalsOverlap(documentType, existing, args) {
  const existingKeys = new Set(changeConflictKeys(documentType, existing.arguments || {}))
  return changeConflictKeys(documentType, args).some((key) => existingKeys.has(key))
}

function referenceParts(value, expectedType = '') {
  const match = /^(character|setting|outline|chapter|note):([^\s|\]]+)$/.exec(
    String(value || '').trim()
  )
  if (!match || (expectedType && match[1] !== expectedType)) {
    throw new HarnessError('TOOL_ARGUMENT_INVALID', 'reference 必须使用受支持的稳定引用')
  }
  return { type: match[1], id: match[2] }
}

function replaceFrontmatter(parsed, metadata) {
  const eol = parsed.lineEnding || '\n'
  const raw = yaml
    .dump(metadata, {
      schema: yaml.JSON_SCHEMA,
      noRefs: true,
      lineWidth: 120,
      noCompatMode: true,
      sortKeys: false
    })
    .trimEnd()
    .replace(/\r\n|\n|\r/g, eol)
  return `---${eol}${raw}${eol}---${eol}${parsed.source.slice(parsed.frontmatter.end)}`
}

function updateMetadata(source, documentType, changes) {
  const parsed = parseKnowledgeMarkdown(source)
  const allowed = METADATA_FIELDS[documentType]
  const next = { ...parsed.metadata }
  for (const [key, value] of Object.entries(changes || {})) {
    if (!allowed?.has(key)) {
      throw new HarnessError('KNOWLEDGE_METADATA_FIELD_INVALID', `不允许修改元数据：${key}`)
    }
    next[key] = value
  }
  next.id = parsed.metadata.id
  next.type = parsed.metadata.type
  return replaceFrontmatter(parsed, next)
}

function sanitizeMetadata(documentType, changes) {
  const allowed = METADATA_FIELDS[documentType]
  const result = {}
  for (const [key, value] of Object.entries(changes || {})) {
    if (!allowed?.has(key)) {
      throw new HarnessError('KNOWLEDGE_METADATA_FIELD_INVALID', `不允许设置元数据：${key}`)
    }
    result[key] = value
  }
  return result
}

function sectionOf(parsed, key) {
  const matches = parsed.sections.filter((section) => section.key === key)
  if (matches.length !== 1) {
    throw new HarnessError(
      matches.length ? 'KNOWLEDGE_SECTION_DUPLICATE' : 'KNOWLEDGE_SECTION_NOT_FOUND',
      matches.length ? `稳定 section 重复：${key}` : `稳定 section 不存在：${key}`
    )
  }
  return matches[0]
}

function insertSection(source, args) {
  const key = requiredText(args.sectionKey, 'sectionKey', 120)
  if (!SECTION_KEY_PATTERN.test(key)) {
    throw new HarnessError('TOOL_ARGUMENT_INVALID', 'sectionKey 格式无效')
  }
  const parsed = parseKnowledgeMarkdown(source)
  if (parsed.sectionMap[key]) {
    throw new HarnessError('KNOWLEDGE_SECTION_EXISTS', `稳定 section 已存在：${key}`)
  }
  const heading = requiredText(args.heading, 'heading', 200)
  const content = String(args.content ?? '').trim()
  const eol = parsed.lineEnding || '\n'
  const block = `### ${heading} <!-- 51:section=${key} -->${eol}${content ? `${eol}${content}${eol}` : ''}`
  const afterKey = String(args.afterSectionKey || '').trim()
  if (!afterKey) return `${source.replace(/(?:\r\n|\n|\r)*$/, '')}${eol}${eol}${block}`
  const after = sectionOf(parsed, afterKey)
  return `${source.slice(0, after.contentEnd)}${block}${eol}${source.slice(after.contentEnd)}`
}

function renameSection(source, args) {
  const parsed = parseKnowledgeMarkdown(source)
  const section = sectionOf(parsed, requiredText(args.sectionKey, 'sectionKey', 120))
  const heading = requiredText(args.heading, 'heading', 200)
  const original = source.slice(section.headingStart, section.headingEnd)
  const eol = original.match(/\r\n|\n|\r$/)?.[0] || ''
  const replacement = `### ${heading} <!-- 51:section=${section.key} -->${eol}`
  return `${source.slice(0, section.headingStart)}${replacement}${source.slice(section.headingEnd)}`
}

function mutateSectionReference(source, args, remove = false) {
  const parsed = parseKnowledgeMarkdown(source)
  const section = sectionOf(parsed, requiredText(args.sectionKey, 'sectionKey', 120))
  const ref = referenceParts(args.reference)
  const matches = extractKnowledgeReferences(section.rawContent).filter(
    (item) => item.sourceType === ref.type && item.targetId === ref.id
  )
  if (remove) {
    if (!matches.length) {
      throw new HarnessError('KNOWLEDGE_REFERENCE_NOT_FOUND', '目标引用不在指定 section 中')
    }
    let content = section.rawContent
    for (const item of matches.sort((a, b) => b.start - a.start)) {
      content = `${content.slice(0, item.start)}${content.slice(item.end)}`
    }
    return replaceKnowledgeSection(parsed, section.key, content.trim())
  }
  if (matches.length) return source
  const label = String(args.label || '').trim()
  const token = `[[${ref.type}:${ref.id}${label ? `|${label}` : ''}]]`
  const current = section.rawContent.trim()
  return replaceKnowledgeSection(parsed, section.key, `${current}${current ? '\n' : ''}${token}`)
}

function outlineLink(source, operation, reference) {
  const map = {
    link_chapter: ['chapterRefs', 'chapter', true],
    unlink_chapter: ['chapterRefs', 'chapter', false],
    link_outline: ['relatedOutlines', 'outline', true],
    unlink_outline: ['relatedOutlines', 'outline', false]
  }
  const [field, type, add] = map[operation]
  const ref = referenceParts(reference, type)
  const parsed = parseKnowledgeMarkdown(source)
  const values = Array.isArray(parsed.metadata[field]) ? [...parsed.metadata[field]] : []
  const next = add ? [...new Set([...values, ref.id])] : values.filter((item) => item !== ref.id)
  return updateMetadata(source, 'outline', { [field]: next })
}

function previewText(value, limit = 12000) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（预览已截断）`
}

function materializeKnowledgeOperation(source, documentType, args) {
  const operation = String(args.operation || '')
  const parsed = parseKnowledgeMarkdown(source)
  let next = source
  let before = ''
  let after = ''
  let affectedSections = []
  let referenceChanges = []

  if (operation === 'update_metadata') {
    before = yaml.dump(parsed.metadata, { schema: yaml.JSON_SCHEMA, noRefs: true }).trim()
    next = updateMetadata(source, documentType, args.metadata)
    after = yaml
      .dump(parseKnowledgeMarkdown(next).metadata, { schema: yaml.JSON_SCHEMA, noRefs: true })
      .trim()
  } else if (operation === 'archive_document') {
    before = String(parsed.metadata.status || '')
    next = updateMetadata(source, documentType, { status: 'deprecated' })
    after = 'deprecated'
  } else if (operation === 'replace_section' || operation === 'append_to_section') {
    const section = sectionOf(parsed, requiredText(args.sectionKey, 'sectionKey', 120))
    before = section.rawContent.trim()
    const content = String(args.content ?? '')
    const replacement =
      operation === 'append_to_section'
        ? `${before}${before && content ? '\n' : ''}${content}`
        : content
    next = replaceKnowledgeSection(parsed, section.key, replacement, {
      expectedSectionHash: args.expectedSectionHash
    })
    after = sectionOf(parseKnowledgeMarkdown(next), section.key).rawContent.trim()
    affectedSections = [section.key]
  } else if (operation === 'insert_section') {
    next = insertSection(source, args)
    before = args.afterSectionKey ? `在 ${args.afterSectionKey} 后` : '文档末尾'
    after = `### ${args.heading} <!-- 51:section=${args.sectionKey} -->\n${String(args.content || '')}`
    affectedSections = [String(args.sectionKey)]
  } else if (operation === 'rename_section_label') {
    const section = sectionOf(parsed, requiredText(args.sectionKey, 'sectionKey', 120))
    before = section.title
    next = renameSection(source, args)
    after = requiredText(args.heading, 'heading', 200)
    affectedSections = [section.key]
  } else if (operation === 'add_reference' || operation === 'remove_reference') {
    const section = sectionOf(parsed, requiredText(args.sectionKey, 'sectionKey', 120))
    before = section.rawContent.trim()
    next = mutateSectionReference(source, args, operation === 'remove_reference')
    after = sectionOf(parseKnowledgeMarkdown(next), section.key).rawContent.trim()
    affectedSections = [section.key]
    referenceChanges = [{ operation, reference: args.reference, sectionKey: section.key }]
  } else if (operation === 'change_order') {
    before = String(parsed.metadata.order ?? 'null')
    next = updateMetadata(source, 'outline', { order: args.order ?? null })
    after = String(args.order ?? 'null')
  } else if (OUTLINE_OPERATIONS.has(operation)) {
    before = yaml.dump(parsed.metadata, { schema: yaml.JSON_SCHEMA, noRefs: true }).trim()
    next = outlineLink(source, operation, args.reference)
    after = yaml
      .dump(parseKnowledgeMarkdown(next).metadata, { schema: yaml.JSON_SCHEMA, noRefs: true })
      .trim()
    referenceChanges = [{ operation, reference: args.reference }]
  } else {
    throw new HarnessError('KNOWLEDGE_OPERATION_INVALID', '不支持的知识文档修改操作')
  }
  return {
    source: next,
    preview: { before: previewText(before), after: previewText(after) },
    affectedSections,
    referenceChanges
  }
}

function materializeKnowledgePatch(source, documentType, changes) {
  let next = source
  const affectedSections = new Set()
  const referenceChanges = []
  for (const change of changes) {
    const result = materializeKnowledgeOperation(next, documentType, change)
    next = result.source
    for (const sectionKey of result.affectedSections || []) affectedSections.add(sectionKey)
    referenceChanges.push(...(result.referenceChanges || []))
  }
  return {
    source: next,
    preview: { before: previewText(source), after: previewText(next) },
    affectedSections: [...affectedSections],
    referenceChanges
  }
}

function noteSnapshot(snapshotService, bookName) {
  const bookPath = snapshotService.resolveBookPath(bookName)
  const filePath = snapshotService.resolveInside(bookPath, QUICK_NOTES_RELATIVE_PATH, '助手速记')
  const buffer = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.from('', 'utf8')
  return { filePath, content: buffer.toString('utf8'), fileHash: sha256(buffer) }
}

function materializeNoteOperation(content, args) {
  const operation = String(args.operation || '')
  const value = String(args.content ?? '')
  if (!NOTE_OPERATIONS.has(operation)) {
    throw new HarnessError('QUICK_NOTE_OPERATION_INVALID', '不支持的速记修改操作')
  }
  if (operation === 'append_note') {
    const separator = content && !content.endsWith('\n') ? '\n' : ''
    return {
      source: `${content}${separator}${requiredText(value, 'content')}`,
      preview: { before: '速记末尾', after: value }
    }
  }
  if (operation === 'insert_heading_block') {
    const heading = requiredText(args.heading, 'heading', 200)
    const block = `## ${heading}\n\n${requiredText(value, 'content')}`
    const separator = content.trim() ? '\n\n' : ''
    return {
      source: `${content.replace(/\s*$/, '')}${separator}${block}\n`,
      preview: { before: '速记末尾', after: block }
    }
  }
  const start = Number(args.start)
  const end = Number(args.end)
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > content.length
  ) {
    throw new HarnessError('QUICK_NOTE_RANGE_INVALID', '速记范围无效')
  }
  const before = content.slice(start, end)
  if (operation === 'replace_range') {
    return {
      source: `${content.slice(0, start)}${value}${content.slice(end)}`,
      preview: { before, after: value }
    }
  }
  const archived = `\n\n## 已归档\n\n${before.trim()}\n`
  return {
    source: `${content.slice(0, start)}${content.slice(end)}${archived}`,
    preview: { before, after: archived.trim() }
  }
}

function targetLabel(record) {
  return record.target?.title || record.target?.documentId || '助手速记'
}

export class KnowledgeWriteProposalService {
  constructor({
    store,
    snapshotService,
    documentService,
    catalogService = null,
    referenceIndexService = null,
    eventSink = () => {}
  } = {}) {
    if (!store || !snapshotService || !documentService) {
      throw new TypeError('KnowledgeWriteProposalService dependencies are required')
    }
    this.store = store
    this.snapshotService = snapshotService
    this.documentService = documentService
    this.catalogService = catalogService
    this.referenceIndexService = referenceIndexService
    this.stateMachine = new WriteProposalStateMachine({ store, eventSink })
    this.readRecords = store.readKnowledgeProposals.bind(store)
    this.writeRecords = store.writeKnowledgeProposals.bind(store)
  }

  async refreshNotesIndex(bookName) {
    try {
      this.catalogService?.invalidate(bookName)
      this.catalogService?.buildCatalog(bookName, 'notes', { force: true })
      this.referenceIndexService?.invalidate(bookName)
      this.referenceIndexService?.buildIndex(bookName, { force: true })
      return { indexStale: false }
    } catch (error) {
      return { indexStale: true, indexError: error?.message || '速记索引需要重建' }
    }
  }

  validateOperation(documentType, operation) {
    if (documentType === 'note') {
      if (!NOTE_OPERATIONS.has(operation))
        throw new HarnessError('QUICK_NOTE_OPERATION_INVALID', '不支持的速记修改操作')
      return
    }
    if (
      !COMMON_OPERATIONS.has(operation) &&
      !(documentType === 'outline' && OUTLINE_OPERATIONS.has(operation))
    ) {
      throw new HarnessError('KNOWLEDGE_OPERATION_INVALID', `不支持的 ${documentType} 修改操作`)
    }
    if (documentType !== 'outline' && OUTLINE_OPERATIONS.has(operation)) {
      throw new HarnessError('KNOWLEDGE_OPERATION_INVALID', '大纲关联操作只适用于 outline')
    }
  }

  async createFromTool(context, documentType, args, signal) {
    if (signal?.aborted) throw new HarnessError('TOOL_CANCELLED', '工具调用已取消')
    const config = SCOPE_CONFIG[documentType]
    if (!config) throw new HarnessError('KNOWLEDGE_TYPE_INVALID', '知识文档类型无效')
    const operation = String(args?.operation || '')
    this.validateOperation(documentType, operation)
    validateOperationArguments(documentType, args)
    const evidenceInfo = validateEvidence(context, args)
    const summary = requiredText(args.summary, 'summary', 120)
    const reason = String(args.reason || '')
      .trim()
      .slice(0, 1000)
    const state = await this.stateMachine.conversationState(
      context.bookKey,
      context.conversationId,
      context.conversationState
    )

    return this.store.withLock(
      `knowledge-write:${state.bookKey}:${state.conversationId}`,
      async () => {
        if (signal?.aborted) throw new HarnessError('TOOL_CANCELLED', '工具调用已取消')
        const proposals = await this.readRecords(state.bookKey, state.conversationId)
        const internalToolCallId = context.idempotencyEnforced === true ? String(context.toolCallId || '') : ''
        const existingForCall = internalToolCallId
          ? proposals.find((item) => item.internalToolCallId === internalToolCallId || item.createdBy?.toolCallId === internalToolCallId)
          : null
        if (existingForCall) {
          return {
            data: { proposalId: existingForCall.proposalId, status: existingForCall.status, contentAccepted: true, affectedSections: existingForCall.affectedSections || [], message: '已返回该工具调用创建的知识文档提案。' },
            proposal: publicWriteProposal(existingForCall)
          }
        }
        let target
        let baseSavedHash = ''
        let baseSectionHash = ''
        let baseSectionHashes = {}
        let materialized
        const storedArgs = structuredClone(args)

        if (operation === 'create_document') {
          const documentId = createId(config.prefix)
          const title = requiredText(args.title, 'title', 200)
          const metadata = sanitizeMetadata(documentType, args.metadata)
          if (JSON.stringify(args.sections || {}).length > 30000) {
            throw new HarnessError('TOOL_ARGUMENT_INVALID', '新建文档 section 内容超过长度限制')
          }
          let source = this.documentService.createTemplateSource(config.scope, documentId, {
            title,
            kind: documentType === 'setting' ? metadata.kind : '',
            metadata,
            sections: args.sections || {}
          })
          const created = parseKnowledgeMarkdown(source)
          for (const key of KNOWLEDGE_DOCUMENT_PROFILES[documentType]?.requiredSections || []) {
            const expected = String(args.sections?.[key] || '').trim()
            const actual = sectionOf(created, key).rawContent.trim()
            if (!expected || actual !== expected) {
              throw new HarnessError(
                'KNOWLEDGE_PROPOSAL_CONTENT_DROPPED',
                `输入内容未完整进入目标 section：${key}`
              )
            }
          }
          materialized = {
            source,
            preview: { before: '', after: previewText(source) },
            affectedSections: Object.keys(args.sections || {}),
            referenceChanges: []
          }
          target = {
            type: documentType,
            scope: config.scope,
            documentId,
            title,
            path: null,
            create: true
          }
          storedArgs.documentId = documentId
        } else {
          const documentId = requiredText(args.documentId, 'documentId', 240)
          const read = this.documentService.readDocument({
            bookName: state.bookKey,
            scope: config.scope,
            documentId
          })
          if (
            !HASH_PATTERN.test(String(args.expectedFileHash || '')) ||
            args.expectedFileHash !== read.fileHash
          ) {
            throw new HarnessError(
              'KNOWLEDGE_DOCUMENT_VERSION_CONFLICT',
              '知识文档哈希缺失或已变化，请重新读取'
            )
          }
          if (operation === 'patch_document') {
            for (const change of args.changes) {
              if (!SECTION_OPERATIONS.has(change.operation)) continue
              const section = sectionOf(
                read.document,
                requiredText(change.sectionKey, 'sectionKey', 120)
              )
              if (change.expectedSectionHash !== section.contentHash) {
                throw new HarnessError(
                  'KNOWLEDGE_SECTION_VERSION_CONFLICT',
                  `目标 section 哈希缺失或已变化：${change.sectionKey}`
                )
              }
              baseSectionHashes[section.key] = section.contentHash
            }
            materialized = materializeKnowledgePatch(read.source, documentType, args.changes)
          } else if (SECTION_OPERATIONS.has(operation)) {
            const section = sectionOf(
              read.document,
              requiredText(args.sectionKey, 'sectionKey', 120)
            )
            if (
              !HASH_PATTERN.test(String(args.expectedSectionHash || '')) ||
              args.expectedSectionHash !== section.contentHash
            ) {
              throw new HarnessError(
                'KNOWLEDGE_SECTION_VERSION_CONFLICT',
                '目标 section 哈希缺失或已变化，请重新读取'
              )
            }
            baseSectionHash = section.contentHash
            baseSectionHashes[section.key] = section.contentHash
            materialized = materializeKnowledgeOperation(read.source, documentType, args)
          } else {
            materialized = materializeKnowledgeOperation(read.source, documentType, args)
          }
          target = {
            type: documentType,
            scope: config.scope,
            documentId,
            title: String(read.document.metadata.title || documentId),
            path: read.relativePath,
            create: false
          }
          baseSavedHash = read.fileHash
        }

        const now = nowIso()
        const supersededProposalIds = []
        for (const existing of proposals) {
          if (
            existing.status === 'pending' &&
            existing.target?.type === documentType &&
            existing.target?.documentId === target.documentId &&
            proposalsOverlap(documentType, existing, args)
          ) {
            const previousStatus = transitionWriteProposal(existing, 'superseded', {
              failure: null
            })
            await this.stateMachine.persist({
              state,
              proposals,
              record: existing,
              write: this.writeRecords,
              previousStatus,
              reasonCode: 'WRITE_PROPOSAL_SUPERSEDED'
            })
            supersededProposalIds.push(existing.proposalId)
          }
        }
        const record = {
          schemaVersion: 1,
          proposalType: 'knowledge',
          proposalId: createId('proposal'),
          bookKey: state.bookKey,
          conversationId: state.conversationId,
          turnId: context.turnId,
          internalToolCallId,
          target,
          operation,
          summary,
          reason,
          basis: evidenceInfo.basis,
          sourceReferences: evidenceInfo.sourceReferences,
          evidence: evidenceInfo.evidence,
          arguments: storedArgs,
          preview: materialized.preview,
          affectedSections: materialized.affectedSections || [],
          referenceChanges: materialized.referenceChanges || [],
          baseSavedHash,
          baseSectionHash,
          baseSectionHashes,
          status: 'pending',
          createdAt: now,
          resolvedAt: null,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          appliedHash: null,
          undoToken: null,
          failure: null,
          createdBy: {
            toolCallId: String(context.toolCallId || '')
          }
        }
        if (signal?.aborted) throw new HarnessError('TOOL_CANCELLED', '工具调用已取消')
        proposals.push(record)
        const proposal = await this.stateMachine.recordCreated({
          state,
          proposals,
          record,
          write: this.writeRecords
        })
        return {
          data: {
            proposalId: record.proposalId,
            status: 'pending',
            contentAccepted: true,
            affectedSections: record.affectedSections,
            supersededProposalIds,
            message: `${targetLabel(record)} 修改提案已创建，等待用户确认；正式资料尚未写入。`
          },
          proposal
        }
      }
    )
  }

  async createQuickNoteFromTool(context, args, signal) {
    if (signal?.aborted) throw new HarnessError('TOOL_CANCELLED', '工具调用已取消')
    const operation = String(args?.operation || '')
    this.validateOperation('note', operation)
    const summary = requiredText(args.summary, 'summary', 120)
    const state = await this.stateMachine.conversationState(
      context.bookKey,
      context.conversationId,
      context.conversationState
    )
    return this.store.withLock(
      `knowledge-write:${state.bookKey}:${state.conversationId}`,
      async () => {
        if (signal?.aborted) throw new HarnessError('TOOL_CANCELLED', '工具调用已取消')
        const proposals = await this.readRecords(state.bookKey, state.conversationId)
        const internalToolCallId = context.idempotencyEnforced === true ? String(context.toolCallId || '') : ''
        const existingForCall = internalToolCallId
          ? proposals.find((item) => item.internalToolCallId === internalToolCallId || item.createdBy?.toolCallId === internalToolCallId)
          : null
        if (existingForCall) {
          return { data: { proposalId: existingForCall.proposalId, status: existingForCall.status, message: '已返回该工具调用创建的速记提案。' }, proposal: publicWriteProposal(existingForCall) }
        }
        const before = noteSnapshot(this.snapshotService, state.bookKey)
        if (
          !HASH_PATTERN.test(String(args.expectedFileHash || '')) ||
          args.expectedFileHash !== before.fileHash
        ) {
          throw new HarnessError('QUICK_NOTE_VERSION_CONFLICT', '速记哈希缺失或已变化，请重新读取')
        }
        const materialized = materializeNoteOperation(before.content, args)
        const record = {
          schemaVersion: 1,
          proposalType: 'knowledge',
          proposalId: createId('proposal'),
          bookKey: state.bookKey,
          conversationId: state.conversationId,
          turnId: context.turnId,
          internalToolCallId,
          target: {
            type: 'note',
            scope: 'notes',
            documentId: 'quick-notes',
            title: '助手速记',
            path: QUICK_NOTES_RELATIVE_PATH.replaceAll('\\', '/'),
            create: false
          },
          operation,
          summary,
          reason: String(args.reason || '')
            .trim()
            .slice(0, 1000),
          arguments: structuredClone(args),
          preview: {
            before: previewText(materialized.preview.before),
            after: previewText(materialized.preview.after)
          },
          affectedSections: [],
          referenceChanges: [],
          baseSavedHash: before.fileHash,
          baseSectionHash: '',
          status: 'pending',
          createdAt: nowIso(),
          resolvedAt: null,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          appliedHash: null,
          undoToken: null,
          failure: null,
          createdBy: {
            toolCallId: String(context.toolCallId || '')
          }
        }
        if (signal?.aborted) throw new HarnessError('TOOL_CANCELLED', '工具调用已取消')
        proposals.push(record)
        const proposal = await this.stateMachine.recordCreated({
          state,
          proposals,
          record,
          write: this.writeRecords
        })
        return {
          data: {
            proposalId: record.proposalId,
            status: 'pending',
            message: '速记修改提案已创建，等待用户确认；速记尚未写入。'
          },
          proposal
        }
      }
    )
  }

  async reconcileApplying(state, proposals) {
    for (const record of proposals) {
      if (record.status !== 'applying') continue
      let currentHash = ''
      try {
        currentHash =
          record.target.type === 'note'
            ? noteSnapshot(this.snapshotService, state.bookKey).fileHash
            : this.documentService.readDocument({
                bookName: state.bookKey,
                scope: record.target.scope,
                documentId: record.target.documentId
              }).fileHash
      } catch {
        currentHash = ''
      }
      let previousStatus
      if (record.appliedHash && currentHash === record.appliedHash) {
        previousStatus = transitionWriteProposal(record, 'applied', { failure: null })
      } else if (currentHash === record.baseSavedHash) {
        previousStatus = transitionWriteProposal(record, 'failed', {
          failure: {
            code: 'WRITE_PROPOSAL_INTERRUPTED',
            message: '上次写入在完成前中断，可以安全重试',
            retryable: true
          },
          resolved: false
        })
      } else {
        previousStatus = transitionWriteProposal(record, 'conflicted', {
          failure: {
            code: 'KNOWLEDGE_DOCUMENT_VERSION_CONFLICT',
            message: '目标资料已发生变化，这条提案已失效',
            retryable: false
          }
        })
      }
      await this.stateMachine.persist({
        state,
        proposals,
        record,
        write: this.writeRecords,
        previousStatus,
        reasonCode: record.failure?.code || 'WRITE_PROPOSAL_RECOVERED'
      })
    }
  }

  async list({ bookName, conversationId }) {
    const data = await this.store.loadConversation(bookName, conversationId)
    return this.store.withLock(`knowledge-write:${bookName}:${conversationId}`, async () => {
      const proposals = await this.readRecords(bookName, conversationId)
      await this.reconcileApplying(data.state, proposals)
      return proposals.map(publicWriteProposal)
    })
  }

  async findRecord(bookName, conversationId, proposalId) {
    const proposals = await this.readRecords(bookName, conversationId)
    return proposals.find((item) => item.proposalId === proposalId) || null
  }

  async reject({ bookName, conversationId, proposalId }) {
    const data = await this.store.loadConversation(bookName, conversationId)
    return this.store.withLock(`knowledge-write:${bookName}:${conversationId}`, async () => {
      const proposals = await this.readRecords(bookName, conversationId)
      const record = proposals.find((item) => item.proposalId === proposalId)
      if (!record) throw new HarnessError('WRITE_PROPOSAL_NOT_FOUND', '修改提案不存在')
      if (record.status === 'rejected') return publicWriteProposal(record)
      if (!['pending', 'failed'].includes(record.status))
        throw new HarnessError('WRITE_PROPOSAL_ALREADY_RESOLVED', '该提案已经处理')
      const previousStatus = transitionWriteProposal(record, 'rejected', { failure: null })
      return this.stateMachine.persist({
        state: data.state,
        proposals,
        record,
        write: this.writeRecords,
        previousStatus,
        reasonCode: 'WRITE_PROPOSAL_REJECTED'
      })
    })
  }

  async apply({ bookName, conversationId, proposalId }) {
    const data = await this.store.loadConversation(bookName, conversationId)
    if (data.state.status === 'running' || data.state.activeTurnId) {
      throw new HarnessError(
        'WRITE_PROPOSAL_TURN_RUNNING',
        '当前回答仍在生成，请等待本轮结束后再确认写入'
      )
    }
    return this.store.withLock(`knowledge-write:${bookName}:${conversationId}`, async () => {
      const proposals = await this.readRecords(bookName, conversationId)
      await this.reconcileApplying(data.state, proposals)
      const record = proposals.find((item) => item.proposalId === proposalId)
      if (!record) throw new HarnessError('WRITE_PROPOSAL_NOT_FOUND', '修改提案不存在')
      if (!['pending', 'failed'].includes(record.status))
        throw new HarnessError('WRITE_PROPOSAL_ALREADY_RESOLVED', '该提案已经处理')
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) {
        const previousStatus = transitionWriteProposal(record, 'stale', {
          failure: {
            code: 'WRITE_PROPOSAL_EXPIRED',
            message: '提案已过期，请重新生成',
            retryable: false
          }
        })
        await this.stateMachine.persist({
          state: data.state,
          proposals,
          record,
          write: this.writeRecords,
          previousStatus,
          reasonCode: 'WRITE_PROPOSAL_EXPIRED'
        })
        throw new HarnessError('WRITE_PROPOSAL_EXPIRED', record.failure.message)
      }

      let materialized
      let current
      try {
        if (record.target.create) {
          materialized = {
            source: this.documentService.createTemplateSource(
              record.target.scope,
              record.target.documentId,
              {
                title: record.arguments.title,
                kind: record.arguments.kind,
                metadata: record.arguments.metadata,
                sections: record.arguments.sections
              }
            )
          }
        } else if (record.target.type === 'note') {
          current = noteSnapshot(this.snapshotService, bookName)
          if (current.fileHash !== record.baseSavedHash)
            throw new HarnessError('QUICK_NOTE_VERSION_CONFLICT', '速记已发生变化，这条提案已失效')
          materialized = materializeNoteOperation(current.content, record.arguments)
        } else {
          current = this.documentService.readDocument({
            bookName,
            scope: record.target.scope,
            documentId: record.target.documentId
          })
          const baseSectionHashes = {
            ...(record.baseSectionHashes || {}),
            ...(record.baseSectionHash && record.arguments.sectionKey
              ? { [record.arguments.sectionKey]: record.baseSectionHash }
              : {})
          }
          const canRebaseSections = Object.keys(baseSectionHashes).length > 0
          for (const [sectionKey, expectedHash] of Object.entries(baseSectionHashes)) {
            const section = sectionOf(current.document, sectionKey)
            if (section.contentHash !== expectedHash)
              throw new HarnessError(
                'KNOWLEDGE_SECTION_VERSION_CONFLICT',
                `目标 section 已发生变化，这条提案已失效：${sectionKey}`
              )
          }
          if (current.fileHash !== record.baseSavedHash && !canRebaseSections) {
            throw new HarnessError(
              'KNOWLEDGE_DOCUMENT_VERSION_CONFLICT',
              '知识文档已发生变化，这条提案已失效'
            )
          }
          materialized = record.operation === 'patch_document'
            ? materializeKnowledgePatch(
                current.source,
                record.target.type,
                record.arguments.changes || []
              )
            : materializeKnowledgeOperation(
                current.source,
                record.target.type,
                record.arguments
              )
        }
      } catch (error) {
        const previousStatus = transitionWriteProposal(record, 'conflicted', {
          failure: writeProposalFailure(error, 'KNOWLEDGE_DOCUMENT_VERSION_CONFLICT')
        })
        await this.stateMachine.persist({
          state: data.state,
          proposals,
          record,
          write: this.writeRecords,
          previousStatus,
          reasonCode: record.failure.code
        })
        throw error
      }

      const previousStatus = transitionWriteProposal(record, 'applying', {
        failure: null,
        resolved: false
      })
      record.appliedHash = sha256(Buffer.from(materialized.source, 'utf8'))
      await this.stateMachine.persist({
        state: data.state,
        proposals,
        record,
        write: this.writeRecords,
        previousStatus,
        reasonCode: 'WRITE_PROPOSAL_APPLYING'
      })
      try {
        let result
        if (record.target.create) {
          result = await this.documentService.createDocumentFromSource({
            bookName,
            scope: record.target.scope,
            documentId: record.target.documentId,
            source: materialized.source
          })
          record.undoToken = 'created-document'
        } else if (record.target.type === 'note') {
          await this.store.writeUndoSnapshot(bookName, conversationId, proposalId, {
            proposalId,
            content: current.content,
            contentHash: current.fileHash,
            createdAt: nowIso()
          })
          await fs.promises.mkdir(join(current.filePath, '..'), { recursive: true })
          await writeFileAtomically(current.filePath, Buffer.from(materialized.source, 'utf8'))
          const after = noteSnapshot(this.snapshotService, bookName)
          result = {
            fileHash: after.fileHash,
            savedAt: nowIso(),
            ...(await this.refreshNotesIndex(bookName))
          }
          record.undoToken = `proposal:${proposalId}`
        } else {
          result = await this.documentService.writeDocument({
            bookName,
            scope: record.target.scope,
            documentId: record.target.documentId,
            expectedFileHash: current.fileHash,
            source: materialized.source,
            mode: 'formal'
          })
          record.undoToken = result.undoToken
        }
        const applyingStatus = transitionWriteProposal(record, 'applied', { failure: null })
        record.appliedHash = result.fileHash
        record.indexStale = result.indexStale === true
        record.indexError = result.indexError || null
        await this.stateMachine.persist({
          state: data.state,
          proposals,
          record,
          write: this.writeRecords,
          previousStatus: applyingStatus,
          reasonCode: 'WRITE_PROPOSAL_APPLIED'
        })
        return {
          proposal: publicWriteProposal(record),
          contentHash: result.fileHash,
          savedAt: result.savedAt,
          indexStale: result.indexStale,
          indexError: result.indexError
        }
      } catch (error) {
        const status = [
          'KNOWLEDGE_DOCUMENT_VERSION_CONFLICT',
          'KNOWLEDGE_SECTION_VERSION_CONFLICT',
          'QUICK_NOTE_VERSION_CONFLICT'
        ].includes(error?.code)
          ? 'conflicted'
          : 'failed'
        const applyingStatus = transitionWriteProposal(record, status, {
          failure: writeProposalFailure(error),
          resolved: status !== 'failed'
        })
        await this.stateMachine.persist({
          state: data.state,
          proposals,
          record,
          write: this.writeRecords,
          previousStatus: applyingStatus,
          reasonCode: record.failure.code
        })
        throw new HarnessError(record.failure.code, record.failure.message, {
          retryable: record.failure.retryable,
          cause: error
        })
      }
    })
  }

  async undo({ bookName, conversationId, proposalId }) {
    const data = await this.store.loadConversation(bookName, conversationId)
    return this.store.withLock(`knowledge-write:${bookName}:${conversationId}`, async () => {
      const proposals = await this.readRecords(bookName, conversationId)
      const record = proposals.find((item) => item.proposalId === proposalId)
      if (!record) throw new HarnessError('WRITE_PROPOSAL_NOT_FOUND', '修改提案不存在')
      if (record.status === 'undone') return { proposal: publicWriteProposal(record) }
      if (record.status !== 'applied')
        throw new HarnessError('WRITE_PROPOSAL_INVALID_TRANSITION', '当前提案不能撤销')
      let result
      if (record.target.create) {
        result = await this.documentService.undoCreateDocument({
          bookName,
          scope: record.target.scope,
          documentId: record.target.documentId,
          expectedCurrentHash: record.appliedHash
        })
      } else if (record.target.type === 'note') {
        const current = noteSnapshot(this.snapshotService, bookName)
        if (current.fileHash !== record.appliedHash)
          throw new HarnessError(
            'WRITE_PROPOSAL_UNDO_CONFLICT',
            '速记在写入后已发生变化，无法安全撤销'
          )
        const undo = await this.store.readUndoSnapshot(bookName, conversationId, proposalId)
        if (!undo || undo.contentHash !== record.baseSavedHash)
          throw new HarnessError('WRITE_PROPOSAL_UNDO_MISSING', '撤销快照不可用')
        await writeFileAtomically(current.filePath, Buffer.from(undo.content, 'utf8'))
        const restored = noteSnapshot(this.snapshotService, bookName)
        result = { fileHash: restored.fileHash, ...(await this.refreshNotesIndex(bookName)) }
        await this.store.deleteUndoSnapshot(bookName, conversationId, proposalId)
      } else {
        result = await this.documentService.undoWrite({
          bookName,
          undoToken: record.undoToken,
          expectedCurrentHash: record.appliedHash
        })
      }
      const previousStatus = transitionWriteProposal(record, 'undone', { failure: null })
      await this.stateMachine.persist({
        state: data.state,
        proposals,
        record,
        write: this.writeRecords,
        previousStatus,
        reasonCode: 'WRITE_PROPOSAL_UNDONE'
      })
      return {
        proposal: publicWriteProposal(record),
        contentHash: result.fileHash || null,
        indexStale: result.indexStale,
        indexError: result.indexError
      }
    })
  }
}

export default KnowledgeWriteProposalService
