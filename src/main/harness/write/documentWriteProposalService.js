import { logSaveDiagnostic, saveErrorDetails } from '../../services/saveDiagnostics.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { dirname } from 'node:path'
import yaml from 'js-yaml'
import { createId, nowIso } from '../ids.js'
import { HarnessError } from '../harnessErrors.js'
import { workspaceDocumentPath } from '../documents/editorDirtyStateRegistry.js'
import {
  KNOWLEDGE_SECTION_CONTENT_MAX_LENGTH,
  KNOWLEDGE_SECTIONS_TOTAL_MAX_LENGTH
} from '../../services/knowledgeDocumentContract.js'
import {
  parseKnowledgeMarkdown,
  validateKnowledgeDocument
} from '../../services/knowledgeMarkdownParser.js'
import { writeFileAtomically } from '../../services/chapterWriteService.js'
import { makeSourceReference } from '../../services/bookSavedSnapshotService.js'
import { normalizeDocumentPathReferences } from '../documents/documentPathReferences.js'
import {
  transitionWriteProposal,
  writeProposalFailure
} from './writeProposalStateMachine.js'

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000

const DEFAULTS = Object.freeze({
  character: Object.freeze({ status: 'draft', aliases: [], tags: [] }),
  setting: Object.freeze({ kind: 'custom', status: 'draft', aliases: [], tags: [] }),
  outline: Object.freeze({
    status: 'planned',
    tags: [],
    order: null,
    relatedOutlines: [],
    chapterRefs: [],
    characterRefs: [],
    settingRefs: []
  })
})
const CREATE_PREFIXES = Object.freeze({ characters: 'char', settings: 'setting', outlines: 'outline' })

function fail(code, message, options = {}) {
  throw new HarnessError(code, message, { retryable: false, ...options })
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
}

function scopeFrom(context) {
  const scope = context?.bookScope || context?.scope
  if (!scope) fail('BOOK_SCOPE_MISMATCH', '修改提案缺少受信任的当前书籍 scope')
  if (!context?.conversationId)
    fail('BOOK_SCOPE_MISMATCH', '修改提案缺少受信任的会话')
  if (
    (scope.conversationId && scope.conversationId !== context.conversationId) ||
    (context.turnId && scope.turnId && scope.turnId !== context.turnId)
  )
    fail('BOOK_SCOPE_MISMATCH', '修改提案与绑定的会话或轮次不一致')
  return scope
}

function sourcesFrom(args) {
  return [...new Set((Array.isArray(args.sources) ? args.sources : []).map(String))]
}

async function validateEvidence(context, args, ledger, documentService, target) {
  const basis = String(args.basis || '')
  const sources = sourcesFrom(args)
  if (!['creative', 'source_grounded'].includes(basis))
    fail('EVIDENCE_BASIS_REQUIRED', '知识文档修改必须声明 basis')
  if (basis === 'creative') {
    if (sources.length) fail('FIELD_NOT_APPLICABLE', 'creative 提案不能附带 sources')
    return { basis, sources: [], evidence: [] }
  }
  if (!sources.length)
    fail('KNOWLEDGE_EVIDENCE_NOT_READ', 'source_grounded 提案必须引用本轮实际读取的来源')
  const delivered = ledger.list(context)
  const byReference = new Map(
    delivered.flatMap((entry) => entry.references.map((reference) => [reference, entry]))
  )
  const resolvedSources = []
  const evidence = []
  for (const reference of sources) {
    if (/^book(?:\/|$)/i.test(reference)) {
      const path = documentService.canonicalPath(scopeFrom(context), reference)
      const deliveredForPath = delivered.filter((entry) => entry.path === path)
      if (!deliveredForPath.length)
        fail('KNOWLEDGE_EVIDENCE_NOT_READ', 'sources 中的文档尚未在本轮实际读取', {
          retryable: true, nextAction: `先 read ${path}，再使用返回的 path 作为 sources`
        })
      const { snapshot } = await documentService.currentWritableSnapshot(context, path)
      const entry = deliveredForPath.find((item) => item.savedHash === snapshot.savedHash)
      if (!entry) fail('READ_VERSION_CHANGED', '来源文档已经变化，请重新读取后再引用', {
        retryable: true, nextAction: `重新 read ${path}`
      })
      if (!entry.references.length) fail('KNOWLEDGE_EVIDENCE_NOT_READ', '来源缺少已交付的版本引用')
      resolvedSources.push(...entry.references)
      evidence.push(entry)
      continue
    }
    const entry = byReference.get(reference)
    if (!entry) fail('KNOWLEDGE_EVIDENCE_NOT_READ', 'sources 包含本轮未实际交付的读取引用')
    resolvedSources.push(reference)
    evidence.push(entry)
  }
  if (!evidence.some((entry) => entry.authorityStatus === 'authoritative_saved' ||
    (target.type === 'outline' && entry.sourceType === 'outline' && entry.authorityStatus === 'planned_saved')))
    fail('KNOWLEDGE_EVIDENCE_NOT_READ', 'source_grounded 需要正式资料来源；大纲整理也允许已保存的大纲计划来源')
  return { basis, sources: [...new Set(resolvedSources)], evidence: [...new Set(evidence)] }
}

function isKnowledgeTarget(target) {
  return ['character', 'setting', 'outline'].includes(target?.type)
}

async function validateSourceFields(context, args, ledger, target, documentService) {
  if (isKnowledgeTarget(target)) return validateEvidence(context, args, ledger, documentService, target)
  if (args.basis !== undefined || sourcesFrom(args).length)
    fail('FIELD_NOT_APPLICABLE', '正文和速记不接受 basis 或 sources')
  return { basis: null, sources: [], evidence: [] }
}

function validatePlainCandidate(source, target) {
  if (target.type === 'note') {
    if (source.length > 500_000) fail('DOCUMENT_FORMAT_INVALID', '速记内容超过 50 万字符')
    return
  }
  if (target.type !== 'chapter') return
  if (/^---(?:\r?\n|$)/.test(source))
    fail('DOCUMENT_FORMAT_INVALID', '正文章节不能包含 YAML frontmatter')
  if (/<\/?(?:html|head|body|script|style|div|p|br|span)\b[^>]*>/i.test(source))
    fail('DOCUMENT_FORMAT_INVALID', '正文章节必须是纯文本，不能包含 HTML 标记')
}

function validateTargetCandidate(source, target) {
  if (isKnowledgeTarget(target)) return validateCandidate(source, target)
  validatePlainCandidate(source, target)
  return null
}

function validateCandidate(source, target) {
  const parsed = parseKnowledgeMarkdown(source)
  const validation = validateKnowledgeDocument(parsed, {
    expectedType: target.type,
    mode: 'formal'
  })
  const diagnostics = [...validation.diagnostics]
  if (String(parsed.metadata.id || '') !== target.documentId)
    diagnostics.push({ code: 'ID_MISMATCH', path: 'metadata.id', message: 'id 与目标文档不一致' })
  const lengths = parsed.sections.map((section) => section.rawContent.length)
  lengths.forEach((length, index) => {
    if (length > KNOWLEDGE_SECTION_CONTENT_MAX_LENGTH)
      diagnostics.push({
        code: 'SECTION_TOO_LONG',
        path: `sections.${parsed.sections[index].key}`,
        message: `分区正文超过 ${KNOWLEDGE_SECTION_CONTENT_MAX_LENGTH} 个 UTF-16 code unit`
      })
  })
  if (lengths.reduce((sum, length) => sum + length, 0) > KNOWLEDGE_SECTIONS_TOTAL_MAX_LENGTH)
    diagnostics.push({
      code: 'SECTIONS_TOTAL_TOO_LONG',
      path: 'sections',
      message: `分区正文总长度超过 ${KNOWLEDGE_SECTIONS_TOTAL_MAX_LENGTH} 个 UTF-16 code unit`
    })
  if (diagnostics.some((item) => item.severity !== 'warning'))
    fail('DOCUMENT_FORMAT_INVALID', '知识文档候选未通过格式校验', {
      retryStrategy: 'repair_document',
      violations: diagnostics.slice(0, 3).map((item) => ({
        path: item.path || '/',
        keyword: item.code || 'invalid',
        message: item.message || '格式无效',
        params: {}
      })),
      nextAction: `读取 help/${target.collection}.md 后修正文档格式`
    })
  return parsed
}

function createSource(content, target) {
  const input = parseKnowledgeMarkdown(content)
  if (input.diagnostics.some((item) => item.code.startsWith('FRONTMATTER_')))
    fail('DOCUMENT_FORMAT_INVALID', '新建知识文档必须包含有效 YAML frontmatter')
  const eol = input.lineEnding || '\n'
  const metadata = {
    ...DEFAULTS[target.type],
    ...input.metadata,
    id: target.documentId,
    type: target.type
  }
  const frontmatter = yaml
    .dump(metadata, {
      schema: yaml.JSON_SCHEMA,
      noRefs: true,
      lineWidth: 120,
      noCompatMode: true,
      sortKeys: false
    })
    .trimEnd()
    .replace(/\r\n|\n|\r/g, eol)
  return `---${eol}${frontmatter}${eol}---${eol}${content.slice(input.frontmatter.end)}`
}

function decodedRaw(raw) {
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    fail('DOCUMENT_ENCODING_INVALID', '知识文档不是有效 UTF-8')
  }
  return { source: source.replace(/^\uFEFF/, ''), bom: source.startsWith('\uFEFF') }
}

function normalizedToRawOffsets(source) {
  const offsets = [0]
  for (let raw = 0; raw < source.length; ) {
    if (source[raw] === '\r' && source[raw + 1] === '\n') {
      raw += 2
      offsets.push(raw)
    } else {
      raw += 1
      offsets.push(raw)
    }
  }
  return offsets
}

function locateEdits(text, edits) {
  const located = edits.map((edit, index) => {
    if (typeof edit.oldText !== 'string' || !edit.oldText.length)
      fail('EDIT_OLD_TEXT_REQUIRED', '无正文选区时，每项 edit 必须提供非空 oldText 和 newText。')
    const oldText = String(edit.oldText)
    const start = text.indexOf(oldText)
    if (start < 0 || text.indexOf(oldText, start + 1) >= 0)
      fail('EDIT_NOT_UNIQUE', `第 ${index + 1} 项 oldText 必须在同一基线中恰好匹配一次`, {
        retryStrategy: 'expand_context'
      })
    return { index, start, end: start + oldText.length, newText: String(edit.newText) }
  })
  const sorted = [...located].sort(
    (left, right) => left.start - right.start || left.end - right.end
  )
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start < sorted[index - 1].end)
      fail('EDIT_OVERLAP', '多项编辑在原始基线中的范围互相重叠')
  }
  return located
}

function summaryFor(baseText, candidateText, operation, edits = []) {
  return {
    operation,
    beforeChars: baseText.length,
    afterChars: candidateText.length,
    changedChars: Math.abs(candidateText.length - baseText.length),
    editCount: edits.length
  }
}

function publicProposal(record) {
  return {
    proposalType: 'document',
    conversationId: record.conversationId,
    proposalId: record.proposalId,
    revision: record.revision,
    status: record.status === 'pending' ? 'pending_confirmation' : record.status,
    operation: record.operation,
    target: {
      path: record.target.path,
      type: record.target.type,
      scope: record.target.collection,
      documentId: record.target.documentId
    },
    baseSavedHash: record.baseSavedHash,
    candidateHash: record.candidateHash,
    summary: record.summary,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt || null,
    resolvedAt: record.resolvedAt || null,
    appliedHash: record.appliedRawHash || null,
    indexStale: record.indexStale === true,
    indexError: record.indexError || null,
    failure: record.failure || null
  }
}

export class DocumentWriteProposalService {
  constructor({
    store,
    documentService,
    readSnapshotLedger,
    knowledgeDocumentService = null,
    chapterWriteService = null,
    isDocumentDirty = () => false,
    eventSink = () => {},
    idFactory = createId
  } = {}) {
    if (!store || !documentService || !readSnapshotLedger)
      throw new TypeError('store, documentService and readSnapshotLedger are required')
    this.store = store
    this.documentService = documentService
    this.readSnapshotLedger = readSnapshotLedger
    this.knowledgeDocumentService = knowledgeDocumentService
    this.chapterWriteService = chapterWriteService
    this.isDocumentDirty = isDocumentDirty
    this.eventSink = eventSink
    this.idFactory = idFactory
  }

  normalizeReferences(context, source, target, changedRanges = null) {
    if (target.type === 'chapter') return source
    return normalizeDocumentPathReferences(source, (path, expectedType) => {
      const canonical = this.documentService.canonicalPath(scopeFrom(context), path)
      const linked = canonical === target.path ? target
        : this.documentService.describeWritablePath(context, canonical)
      if (expectedType && linked.type !== expectedType)
        fail('DOCUMENT_FORMAT_INVALID', '关联字段的目标文档类型不匹配')
      return makeSourceReference({ sourceType: linked.type, targetId: linked.documentId })
    }, { knowledge: isKnowledgeTarget(target), changedRanges })
  }

  async persist(context, operation, target, candidateBytes, details) {
    const scope = scopeFrom(context)
    if (!context.turnId) fail('BOOK_SCOPE_MISMATCH', '修改提案缺少受信任的轮次')
    const proposalId = this.idFactory('docprop')
    const createdAt = nowIso()
    const record = {
      schemaVersion: 1,
      proposalId,
      revision: 1,
      status: 'pending',
      operation,
      scopeId: scope.scopeId,
      scopeGeneration: scope.policyVersion,
      bookIdentity: scope.bookIdentity,
      bookKey: scope.bookKey,
      conversationId: context.conversationId,
      turnId: context.turnId,
      internalToolCallId: context.toolCallId ? String(context.toolCallId) : null,
      target: {
        path: target.path,
        relativePath: target.relativePath,
        collection: target.collection,
        type: target.type,
        documentId: target.documentId,
        volumeName: target.volumeName || null,
        chapterName: target.chapterName || null,
        create: operation === 'create'
      },
      baseSavedHash: details.baseSavedHash || null,
      baseRawHash: details.baseSavedHash || null,
      candidateHash: sha256(candidateBytes),
      candidateBytes: candidateBytes.length,
      candidateSize: candidateBytes.length,
      basis: details.basis,
      sources: details.sources,
      evidence: details.evidence.map((entry) => ({
        path: entry.path,
        savedHash: entry.savedHash,
        authorityStatus: entry.authorityStatus,
        references: entry.references
      })),
      summary: details.summary,
      selectionReplacement: details.selectionReplacement || null,
      createdAt,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
      resolvedAt: null,
      failure: null,
      undoSnapshotRef: null,
      appliedRawHash: null,
      commitOutcome: null
    }
    const lockKey = `document-proposal:${scope.bookIdentity}:${context.conversationId}`
    await this.store.withLock(lockKey, async () => {
      const records = await this.store.readDocumentProposals(scope.bookKey, context.conversationId)
      if (record.internalToolCallId) {
        const duplicate = records.find((item) => item.internalToolCallId === record.internalToolCallId)
        if (duplicate) {
          const same = duplicate.operation === operation && duplicate.candidateHash === record.candidateHash
          if (!same) fail('TOOL_CALL_REPLAY_MISMATCH', '相同工具调用 ID 的参数与原提案不一致')
          record.proposalId = duplicate.proposalId
          return
        }
      }
      if (records.some((item) => item.proposalId === proposalId))
        fail('PROPOSAL_ID_CONFLICT', '提案 ID 冲突，请重新生成')
      for (const existing of records) {
        if (existing.status !== 'pending' || existing.target?.relativePath !== target.relativePath)
          continue
        transitionWriteProposal(existing, 'superseded', {
          failure: { code: 'PROPOSAL_SUPERSEDED', message: '已由同一文档的新提案替代', retryable: false }
        })
      }
      await this.store.writeDocumentCandidate(
        scope.bookKey,
        context.conversationId,
        proposalId,
        candidateBytes
      )
      await this.store.writeDocumentBase(
        scope.bookKey,
        context.conversationId,
        proposalId,
        details.baseBytes || Buffer.alloc(0)
      )
      try {
        await this.store.writeDocumentProposals(scope.bookKey, context.conversationId, [
          ...records,
          record
        ])
      } catch (error) {
        await this.store.deleteDocumentCandidate(scope.bookKey, context.conversationId, proposalId)
        await this.store.deleteDocumentBase(scope.bookKey, context.conversationId, proposalId)
        throw error
      }
    })
    const persisted = await this.findRecord(scope.bookKey, context.conversationId, record.proposalId)
    return {
      data: { kind: 'write_proposal', ...publicProposal(persisted || record) },
      references: details.sources,
      truncated: false,
      proposal: persisted || record
    }
  }

  async create(context, args) {
    const scope = scopeFrom(context)
    this.documentService.sandboxService.assertScope(scope)
    const directory = this.documentService.canonicalPath(scope, args.directory)
    const knowledgeCollection = /^book\/knowledge\/(characters|settings|outlines)\/$/.exec(directory)?.[1]
    let target
    if (knowledgeCollection) {
      const id = `${CREATE_PREFIXES[knowledgeCollection]}_${crypto.randomUUID().replaceAll('-', '')}`
      target = this.documentService.prepareKnowledgeCreate(context, directory, id)
    } else {
      const conversations = await this.store.listConversations(scope.bookKey)
      const existing = (
        await Promise.all(
          conversations.map((conversation) =>
            this.store.readDocumentProposals(scope.bookKey, conversation.conversationId)
          )
        )
      ).flat()
      target = this.documentService.prepareCreate(context, directory, {
        reservedPaths: existing
          .filter((record) => ['pending', 'applying', 'applied'].includes(record.status))
          .map((record) => record.target?.relativePath)
          .filter(Boolean)
      })
    }
    this.selectionEdits(context, target, null, null)
    const evidence = await validateSourceFields(context, args, this.readSnapshotLedger, target, this.documentService)
    let source = isKnowledgeTarget(target)
      ? createSource(String(args.content), target)
      : String(args.content)
    source = this.normalizeReferences(context, source, target)
    validateTargetCandidate(source, target)
    const bytes = Buffer.from(source, 'utf8')
    return this.persist(context, 'create', target, bytes, {
      ...evidence,
      summary: summaryFor('', source, 'create')
    })
  }

  async baseline(context, path, { full = false } = {}) {
    const { target, snapshot: current } = await this.documentService.currentWritableSnapshot(
      context,
      path
    )
    const entry = this.readSnapshotLedger.find(context, target.path, current.savedHash)
    if (!entry || (full && !entry.complete))
      fail('FULL_READ_REQUIRED', '必须先完整读取目标文档的当前版本', {
        retryable: true,
        retryStrategy: 'reread',
        nextAction: `从头完整读取 ${target.path}`
      })
    const snapshot = this.documentService.getSnapshot(context, target.path, current.savedHash)
    if (!snapshot) fail('AMBIGUOUS_READ_BASE', '已读基线已过期，请重新读取目标文档')
    return { target, entry, snapshot }
  }

  async write(context, args) {
    const { target, snapshot } = await this.baseline(context, args.path, { full: true })
    this.selectionEdits(context, target, snapshot, null)
    const evidence = await validateSourceFields(context, args, this.readSnapshotLedger, target, this.documentService)
    const source = this.normalizeReferences(context, String(args.content), target)
    const parsed = validateTargetCandidate(source, target)
    if (isKnowledgeTarget(target)) {
      const before = parseKnowledgeMarkdown(snapshot.text)
      if (
        String(parsed.metadata.id) !== String(before.metadata.id) ||
        String(parsed.metadata.type) !== String(before.metadata.type)
      )
        fail('DOCUMENT_FORMAT_INVALID', 'write 不得修改知识文档的 id 或 type')
    }
    const { bom } = decodedRaw(snapshot.raw)
    const bytes = Buffer.concat([
      bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
      Buffer.from(source, 'utf8')
    ])
    return this.persist(context, 'write', target, bytes, {
      ...evidence,
      baseSavedHash: snapshot.savedHash,
      baseBytes: snapshot.raw,
      summary: summaryFor(snapshot.text, source, 'write')
    })
  }

  selectionEdits(context, target, snapshot, edits) {
    const workspace = context.workspace || {}
    if (target.type !== 'chapter' || !workspace.selectionText ||
      (workspace.currentModule !== 'editor' && workspace.metadata?.file_type !== 'chapter')) return null
    const workspacePath = workspaceDocumentPath(workspace)
    if (workspacePath && !workspacePath.startsWith('book/chapters/')) return null
    if (!workspacePath) fail('SELECTION_BASE_CHANGED', '无法定位选区所属章节，请重新选择并发送。')
    const selectedPath = this.documentService.canonicalPath(scopeFrom(context), workspacePath)
    if (target.path !== selectedPath || !edits || edits.length !== 1 ||
      Object.hasOwn(edits[0], 'oldText') || typeof edits[0].newText !== 'string') {
      fail('SELECTION_SCOPE_REQUIRED', '本轮正文修改仅允许一次替换完整选区；只提交 path 和 edits:[{newText:"替换后的完整选区"}]，不传 oldText 或坐标。整章重写请取消选区后重新发送。')
    }
    const { start, end } = workspace.textRange || {}
    if (workspace.hasUnsavedChanges || !Number.isInteger(start) || !Number.isInteger(end) ||
      start < 0 || end <= start || workspace.currentDocumentSavedHash !== snapshot.savedHash ||
      snapshot.text.slice(start, end) !== workspace.selectionText) {
      fail('SELECTION_BASE_CHANGED', '选区与已保存正文不一致，请保存或放弃草稿后重新选择并发送。')
    }
    // Use the frozen, validated range, never model-supplied old text or coordinates.
    return [{ index: 0, start, end, newText: String(edits[0].newText) }]
  }

  async edit(context, args) {
    const { target, entry, snapshot } = await this.baseline(context, args.path)
    const evidence = await validateSourceFields(context, args, this.readSnapshotLedger, target, this.documentService)
    const selectionEdits = this.selectionEdits(context, target, snapshot, args.edits)
    const located = selectionEdits || locateEdits(snapshot.text, args.edits)
    for (const edit of located) {
      if (
        !this.readSnapshotLedger.coversRange(
          context,
          target.path,
          snapshot.savedHash,
          edit.start,
          edit.end
        )
      )
        fail('FULL_READ_REQUIRED', 'edit 目标范围尚未实际交付，请读取该范围后重试', {
          retryable: true,
          retryStrategy: 'reread'
        })
    }
    const decoded = decodedRaw(snapshot.raw)
    const offsets = normalizedToRawOffsets(decoded.source)
    let source = decoded.source
    for (const edit of [...located].sort((left, right) => right.start - left.start)) {
      source = `${source.slice(0, offsets[edit.start])}${edit.newText}${source.slice(offsets[edit.end])}`
    }
    let shift = 0
    const changedRanges = [...located].sort((left, right) => left.start - right.start).map((edit) => {
      const start = offsets[edit.start] + shift
      shift += edit.newText.length - (offsets[edit.end] - offsets[edit.start])
      return { start, end: start + edit.newText.length }
    })
    source = this.normalizeReferences(context, source, target, changedRanges)
    validateTargetCandidate(source, target)
    const bytes = Buffer.concat([
      decoded.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
      Buffer.from(source, 'utf8')
    ])
    return this.persist(context, 'edit', target, bytes, {
      ...evidence,
      baseSavedHash: snapshot.savedHash,
      baseBytes: snapshot.raw,
      summary: summaryFor(snapshot.text, source, 'edit', located),
      selectionReplacement: selectionEdits ? {
        beforeStart: offsets[located[0].start],
        beforeEnd: offsets[located[0].end],
        afterStart: offsets[located[0].start],
        afterEnd: offsets[located[0].start] + located[0].newText.length
      } : null,
      readCoverage: entry.ranges
    })
  }

  async list(context) {
    const scope = scopeFrom(context)
    return this.store.withLock(`document-list:${scope.bookIdentity}:${context.conversationId}`, async () => {
      const records = await this.store.readDocumentProposals(scope.bookKey, context.conversationId)
      await this.reconcileApplying(context, records)
      let rebound = false
      for (const record of records) {
        if (
          record.bookIdentity === scope.bookIdentity &&
          record.scopeId !== scope.scopeId &&
          context.allowScopeRebind?.(record.scopeId) === true
        ) {
          record.scopeId = scope.scopeId
          rebound = true
        }
      }
      if (rebound) await this.saveRecords(scope, context.conversationId, records)
      return Promise.all(records.map(async (record) => {
        const proposal = publicProposal(record)
        // UI 使用内部状态名判断确认按钮；模型工具结果仍使用 pending_confirmation。
        proposal.status = record.status
        proposal.confirmationAllowed = record.scopeId === scope.scopeId
        try {
          const [base, candidate] = await Promise.all([
            this.store.readDocumentBase(scope.bookKey, context.conversationId, record.proposalId),
            this.store.readDocumentCandidate(scope.bookKey, context.conversationId, record.proposalId)
          ])
          proposal.preview = {
            before: decodedRaw(base).source,
            after: decodedRaw(candidate).source,
            complete: true
          }
          if (record.selectionReplacement) {
            const range = record.selectionReplacement
            proposal.preview.selection = {
              before: proposal.preview.before.slice(range.beforeStart, range.beforeEnd),
              after: proposal.preview.after.slice(range.afterStart, range.afterEnd)
            }
          }
          proposal.target.title = isKnowledgeTarget(record.target)
            ? String(
                parseKnowledgeMarkdown(proposal.preview.after).metadata.title ||
                  proposal.target.documentId
              )
            : record.target.type === 'note'
              ? '助手速记'
              : record.target.chapterName || proposal.target.documentId
        } catch {
          proposal.preview = { before: '', after: '', complete: false }
        }
        return proposal
      }))
    })
  }

  async findRecord(bookKey, conversationId, proposalId) {
    const records = await this.store.readDocumentProposals(bookKey, conversationId)
    return records.find((item) => item.proposalId === proposalId) || null
  }

  assertRecordScope(context, record) {
    const scope = scopeFrom(context)
    this.documentService.sandboxService.assertScope(scope)
    if (
      record.bookIdentity !== scope.bookIdentity ||
      record.scopeId !== scope.scopeId ||
      record.conversationId !== context.conversationId
    ) fail('BOOK_SCOPE_MISMATCH', '提案与当前窗口、书籍或会话绑定不一致')
    return scope
  }

  async saveRecords(scope, conversationId, records) {
    await this.store.writeDocumentProposals(scope.bookKey, conversationId, records)
  }

  resolveRecordTarget(scope, record, { mustExist = false } = {}) {
    const relativePath = record.target.relativePath
    if (relativePath.startsWith('.51mazi/'))
      return mustExist
        ? this.documentService.sandboxService.resolveInternal(scope, relativePath, { kind: 'file' })
        : this.documentService.sandboxService.prepareInternalPath(scope, relativePath, {
            kind: 'file'
          })
    return mustExist
      ? this.documentService.sandboxService.resolveReadable(scope, relativePath, { kind: 'file' })
      : this.documentService.sandboxService.prepareCandidateTarget(scope, relativePath, {
          kind: 'file'
        })
  }

  emit(type, record) {
    this.eventSink({
      type,
      bookName: record.bookKey || null,
      conversationId: record.conversationId,
      proposalId: record.proposalId,
      proposal: publicProposal(record)
    })
  }

  async notifyIndex(record, action) {
    if (!isKnowledgeTarget(record.target)) return { indexStale: false }
    if (!this.knowledgeDocumentService?.notifyCommitted) return { indexStale: false }
    return this.knowledgeDocumentService.notifyCommitted({
      action,
      bookName: record.bookKey,
      scope: record.target.collection,
      documentId: record.target.documentId,
      previousHash: action === 'undo' ? record.appliedRawHash : record.baseRawHash,
      fileHash: action === 'undo' ? record.baseRawHash : record.appliedRawHash
    })
  }

  async commitCandidate(record, candidate, targetPath) {
    if (record.target.type !== 'chapter' || !this.chapterWriteService) {
      await fs.promises.mkdir(dirname(targetPath), { recursive: true })
      await writeFileAtomically(targetPath, candidate)
      return
    }
    const payload = {
      bookName: record.bookKey,
      volumeName: record.target.volumeName,
      chapterName: record.target.chapterName,
      content: candidate
    }
    if (record.operation === 'create') await this.chapterWriteService.createChapter(payload)
    else
      await this.chapterWriteService.writeChapterWithExpectedHash({
        ...payload,
        expectedHash: record.baseRawHash
      })
  }

  async undoCommitted(record, restored, targetPath) {
    if (record.target.type !== 'chapter' || !this.chapterWriteService) {
      if (record.operation === 'create') await fs.promises.unlink(targetPath)
      else await writeFileAtomically(targetPath, restored)
      return
    }
    const payload = {
      bookName: record.bookKey,
      volumeName: record.target.volumeName,
      chapterName: record.target.chapterName,
      expectedHash: record.appliedRawHash
    }
    if (record.operation === 'create')
      await this.chapterWriteService.deleteChapterWithExpectedHash(payload)
    else
      await this.chapterWriteService.writeChapterWithExpectedHash({ ...payload, content: restored })
  }

  async reconcileApplying(context, records) {
    const scope = scopeFrom(context)
    let changed = false
    for (const record of records) {
      if (record.status !== 'applying' || record.bookIdentity !== scope.bookIdentity) continue
      const targetPath = this.resolveRecordTarget(scope, record)
      let currentHash = null
      try { currentHash = sha256(await fs.promises.readFile(targetPath)) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (currentHash === record.candidateHash) {
        if (record.target.type === 'chapter' && this.chapterWriteService) {
          const [base, candidate] = await Promise.all([
            this.store.readDocumentBase(scope.bookKey, context.conversationId, record.proposalId),
            this.store.readDocumentCandidate(
              scope.bookKey,
              context.conversationId,
              record.proposalId
            )
          ])
          await this.chapterWriteService.reconcileCommittedChapter({
            bookName: scope.bookKey,
            volumeName: record.target.volumeName,
            chapterName: record.target.chapterName,
            previousContent: decodedRaw(base).source.replace(/^\uFEFF/, ''),
            content: decodedRaw(candidate).source.replace(/^\uFEFF/, '')
          })
        }
        transitionWriteProposal(record, 'applied', { failure: null })
        record.appliedRawHash = currentHash
        record.commitOutcome = 'committed_recovered'
        const index = await this.notifyIndex({ ...record, bookKey: scope.bookKey }, record.operation)
        record.indexStale = index.indexStale === true
        record.indexError = index.indexError || null
      } else if (record.operation === 'create' ? currentHash === null : currentHash === record.baseRawHash) {
        logSaveDiagnostic('proposal.recovered-not-committed', { proposalId: record.proposalId, previousFailure: record.failure, currentHash })
        transitionWriteProposal(record, 'pending', { failure: null, resolved: false })
        record.commitOutcome = 'not_committed'
      } else {
        transitionWriteProposal(record, 'conflicted', {
          failure: { code: 'COMMIT_OUTCOME_CONFLICT', message: '恢复时发现目标既非基线也非候选', retryable: false }
        })
        record.commitOutcome = 'conflicted'
      }
      changed = true
    }
    if (changed) await this.saveRecords(scope, context.conversationId, records)
  }

  async reject(context, proposalId, revision) {
    const scope = scopeFrom(context)
    const initial = await this.findRecord(scope.bookKey, context.conversationId, proposalId)
    if (!initial) fail('WRITE_PROPOSAL_NOT_FOUND', '修改提案不存在')
    return this.store.withLock(`document:${scope.bookIdentity}:${initial.target.relativePath}`, async () => {
      const records = await this.store.readDocumentProposals(scope.bookKey, context.conversationId)
      const record = records.find((item) => item.proposalId === proposalId)
      if (!record) fail('WRITE_PROPOSAL_NOT_FOUND', '修改提案不存在')
      this.assertRecordScope(context, record)
      if (Number(revision) !== Number(record.revision)) fail('PROPOSAL_STALE', '提案版本已变化')
      if (record.status === 'rejected') return publicProposal(record)
      transitionWriteProposal(record, 'rejected', { failure: null })
      await this.saveRecords(scope, context.conversationId, records)
      this.emit('write.proposal.updated', { ...record, bookKey: scope.bookKey })
      return publicProposal(record)
    })
  }

  async apply(context, { proposalId, revision, candidateHash }) {
    logSaveDiagnostic('proposal.apply-request', { proposalId, revision, candidateHash, conversationId: context.conversationId })
    const scope = scopeFrom(context)
    const data = await this.store.loadConversation(scope.bookKey, context.conversationId)
    if (data.state.status === 'running' || data.state.activeTurnId)
      fail('WRITE_PROPOSAL_TURN_RUNNING', '当前回答仍在生成，请等待本轮结束后再确认写入')
    const initial = await this.findRecord(scope.bookKey, context.conversationId, proposalId)
    if (!initial) fail('WRITE_PROPOSAL_NOT_FOUND', '修改提案不存在')
    const lockKey = `document:${scope.bookIdentity}:${initial.target.relativePath}`
    return this.store.withLock(lockKey, async () => {
      const records = await this.store.readDocumentProposals(scope.bookKey, context.conversationId)
      await this.reconcileApplying(context, records)
      const record = records.find((item) => item.proposalId === proposalId)
      this.assertRecordScope(context, record)
      if (Number(revision) !== Number(record.revision) || candidateHash !== record.candidateHash)
        fail('PROPOSAL_STALE', '确认凭据与当前提案版本不一致')
      if (record.status === 'applied') return { proposal: publicProposal(record), contentHash: record.appliedRawHash }
      if (record.status !== 'pending') fail('WRITE_PROPOSAL_ALREADY_RESOLVED', '该提案已经处理')
      if (await this.isDocumentDirty({
        bookKey: scope.bookKey,
        bookIdentity: scope.bookIdentity,
        conversationId: context.conversationId,
        path: record.target.path,
        documentId: record.target.documentId
      })) fail('EDITOR_DIRTY', '目标文档存在未保存的编辑内容，请先处理编辑器草稿')
      if (Date.parse(record.expiresAt) < Date.now()) {
        transitionWriteProposal(record, 'stale', {
          failure: { code: 'WRITE_PROPOSAL_EXPIRED', message: '提案已过期，请重新生成', retryable: false }
        })
        await this.saveRecords(scope, context.conversationId, records)
        fail('WRITE_PROPOSAL_EXPIRED', '提案已过期，请重新生成')
      }
      const targetPath = this.resolveRecordTarget(scope, record)
      let before = null
      try { before = await fs.promises.readFile(targetPath) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const beforeHash = before ? sha256(before) : null
      if (record.operation === 'create' ? before !== null : beforeHash !== record.baseRawHash) {
        transitionWriteProposal(record, 'conflicted', {
          failure: { code: record.operation === 'create' ? 'CREATE_TARGET_EXISTS' : 'PROPOSAL_STALE', message: '正式文档已发生变化', retryable: false }
        })
        await this.saveRecords(scope, context.conversationId, records)
        fail(record.failure.code, record.failure.message)
      }
      const candidate = await this.store.readDocumentCandidate(scope.bookKey, context.conversationId, proposalId)
      if (sha256(candidate) !== record.candidateHash) fail('PROPOSAL_CANDIDATE_CORRUPT', '冻结候选内容校验失败')
      await this.store.writeUndoSnapshot(scope.bookKey, context.conversationId, proposalId, {
        proposalId,
        baseExists: before !== null,
        contentBase64: before?.toString('base64') || '',
        contentHash: beforeHash,
        createdAt: nowIso()
      })
      logSaveDiagnostic('proposal.applying', { proposalId, targetId: record.target.documentId, baseRawHash: record.baseRawHash, candidateHash: record.candidateHash })
      transitionWriteProposal(record, 'applying', { failure: null, resolved: false })
      record.undoSnapshotRef = `proposal:${proposalId}`
      record.commitOutcome = 'applying'
      await this.saveRecords(scope, context.conversationId, records)
      try {
        await this.commitCandidate({ ...record, bookKey: scope.bookKey }, candidate, targetPath)
        record.appliedRawHash = record.candidateHash
        record.commitOutcome = 'committed'
        transitionWriteProposal(record, 'applied', { failure: null })
        const index = await this.notifyIndex({ ...record, bookKey: scope.bookKey }, record.operation)
        record.indexStale = index.indexStale === true
        record.indexError = index.indexError || null
        await this.saveRecords(scope, context.conversationId, records)
        this.emit('write.proposal.updated', { ...record, bookKey: scope.bookKey })
        return {
          proposal: publicProposal(record),
          contentHash: record.appliedRawHash,
          ...(record.target.type === 'chapter'
            ? { content: decodedRaw(candidate).source.replace(/^\uFEFF/, '') }
            : {}),
          ...index
        }
      } catch (error) {
        logSaveDiagnostic('proposal.commit-failed', { proposalId, error: saveErrorDetails(error) })
        record.failure = writeProposalFailure(error, 'COMMIT_OUTCOME_UNKNOWN')
        await this.saveRecords(scope, context.conversationId, records).catch(() => {})
        throw error
      }
    })
  }

  async undo(context, proposalId) {
    const scope = scopeFrom(context)
    const data = await this.store.loadConversation(scope.bookKey, context.conversationId)
    if (data.state.status === 'running' || data.state.activeTurnId)
      fail('WRITE_PROPOSAL_TURN_RUNNING', '当前回答仍在生成，请等待本轮结束后再撤销')
    const initial = await this.findRecord(scope.bookKey, context.conversationId, proposalId)
    if (!initial) fail('WRITE_PROPOSAL_NOT_FOUND', '修改提案不存在')
    return this.store.withLock(`document:${scope.bookIdentity}:${initial.target.relativePath}`, async () => {
      const records = await this.store.readDocumentProposals(scope.bookKey, context.conversationId)
      const record = records.find((item) => item.proposalId === proposalId)
      this.assertRecordScope(context, record)
      if (record.status === 'undone') return { proposal: publicProposal(record) }
      if (record.status !== 'applied') fail('WRITE_PROPOSAL_INVALID_TRANSITION', '当前提案不能撤销')
      if (await this.isDocumentDirty({
        bookKey: scope.bookKey, bookIdentity: scope.bookIdentity,
        conversationId: context.conversationId,
        path: record.target.path, documentId: record.target.documentId
      })) fail('EDITOR_DIRTY', '目标文档存在未保存的编辑内容，请先处理编辑器草稿')
      const targetPath = this.resolveRecordTarget(scope, record, { mustExist: true })
      const current = await fs.promises.readFile(targetPath)
      if (sha256(current) !== record.appliedRawHash) fail('WRITE_PROPOSAL_UNDO_CONFLICT', '正式资料在写入后已变化，无法安全撤销')
      const undo = await this.store.readUndoSnapshot(scope.bookKey, context.conversationId, proposalId)
      const restored = Buffer.from(String(undo.contentBase64 || ''), 'base64')
      if (record.operation !== 'create' && sha256(restored) !== record.baseRawHash)
        fail('WRITE_PROPOSAL_UNDO_CORRUPT', '撤销快照校验失败')
      await this.undoCommitted({ ...record, bookKey: scope.bookKey }, restored, targetPath)
      transitionWriteProposal(record, 'undone', { failure: null })
      record.commitOutcome = 'undone'
      const index = await this.notifyIndex({ ...record, bookKey: scope.bookKey }, 'undo')
      record.indexStale = index.indexStale === true
      record.indexError = index.indexError || null
      await this.saveRecords(scope, context.conversationId, records)
      this.emit('write.proposal.updated', { ...record, bookKey: scope.bookKey })
      return {
        proposal: publicProposal(record),
        ...(record.target.type === 'chapter'
          ? {
              content: record.operation === 'create' ? '' : decodedRaw(restored).source.replace(/^\uFEFF/, ''),
              contentHash: record.operation === 'create' ? null : sha256(restored)
            }
          : {}),
        ...index
      }
    })
  }

  async readFrozenCandidate(context, proposalId) {
    const scope = scopeFrom(context)
    const records = await this.store.readDocumentProposals(scope.bookKey, context.conversationId)
    const record = records.find((item) => item.proposalId === proposalId)
    if (!record || record.bookIdentity !== scope.bookIdentity)
      fail('BOOK_SCOPE_MISMATCH', '提案不属于当前书籍 scope')
    const bytes = await this.store.readDocumentCandidate(
      scope.bookKey,
      context.conversationId,
      proposalId
    )
    if (sha256(bytes) !== record.candidateHash)
      fail('PROPOSAL_CANDIDATE_CORRUPT', '冻结候选内容校验失败')
    return { record, bytes }
  }
}

export default DocumentWriteProposalService
