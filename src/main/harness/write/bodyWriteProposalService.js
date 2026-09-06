import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { chapterTargetId } from '../../services/chapterWriteService.js'
import { HarnessError } from '../harnessErrors.js'
import { createId, nowIso } from '../ids.js'
import {
  applyBodyOperation,
  BODY_WRITE_OPERATIONS,
  materializeLineEndings,
  normalizeBodyText
} from '../../../shared/bodyWrite.js'
import {
  publicWriteProposal as publicProposal,
  writeProposalFailure as proposalFailure
} from './writeProposalStateMachine.js'
import WriteProposalStateMachine from './writeProposalStateMachine.js'

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/i
const SELECTION_OPERATIONS = new Set([
  'replace_selection',
  'insert_before_selection',
  'insert_after_selection'
])

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')}`
}

function sameRange(left, right) {
  if (!left || !right) return left === right
  return left.start === right.start && left.end === right.end
}

export class BodyWriteProposalService {
  constructor({ store, snapshotService, chapterWriteService, eventSink = () => {} } = {}) {
    if (!store || !snapshotService || !chapterWriteService) {
      throw new TypeError('BodyWriteProposalService dependencies are required')
    }
    this.store = store
    this.snapshotService = snapshotService
    this.chapterWriteService = chapterWriteService
    this.eventSink = eventSink
    this.stateMachine = new WriteProposalStateMachine({ store, eventSink })
  }

  emit(type, record) {
    this.stateMachine.emit(type, record)
  }

  async conversationState(bookKey, conversationId, preferred = null) {
    return this.stateMachine.conversationState(bookKey, conversationId, preferred)
  }

  async persistStatus(state, proposals, record, previousStatus, reasonCode = null) {
    return this.stateMachine.persist({
      state,
      proposals,
      record,
      write: this.store.writeWriteProposals.bind(this.store),
      previousStatus,
      reasonCode
    })
  }

  validateWorkspace(workspace, operation) {
    const metadata = workspace?.metadata || {}
    if (workspace?.currentModule !== 'editor' || metadata.file_type !== 'chapter') {
      throw new HarnessError(
        'WRITE_PROPOSAL_EDITOR_REQUIRED',
        '请先打开要修改的正文章节'
      )
    }
    if (workspace.hasUnsavedChanges) {
      throw new HarnessError(
        'WRITE_PROPOSAL_UNSAVED_CHANGES',
        '请先保存正文，再生成可写入提案'
      )
    }
    if (!HASH_PATTERN.test(String(workspace.currentDocumentSavedHash || ''))) {
      throw new HarnessError(
        'WRITE_PROPOSAL_SAVED_HASH_REQUIRED',
        '当前章节缺少已保存版本，请重新打开章节后再试'
      )
    }
    const chapterName = String(metadata.chapter_name || '').trim()
    const volumeName = String(metadata.volume_name || '').trim()
    const documentId = String(workspace.currentDocumentId || metadata.chapter_id || '').trim()
    if (!chapterName || !volumeName || !documentId) {
      throw new HarnessError('WRITE_PROPOSAL_TARGET_INVALID', '当前正文章节信息不完整')
    }
    chapterTargetId(volumeName, chapterName)

    if (SELECTION_OPERATIONS.has(operation)) {
      const editorRange = workspace.editorRange
      const textRange = workspace.textRange
      const originalText = normalizeBodyText(workspace.selectionText)
      if (
        !editorRange ||
        !Number.isInteger(editorRange.from) ||
        !Number.isInteger(editorRange.to) ||
        editorRange.from >= editorRange.to ||
        !textRange ||
        !Number.isInteger(textRange.start) ||
        !Number.isInteger(textRange.end) ||
        textRange.start >= textRange.end ||
        !originalText
      ) {
        throw new HarnessError(
          'WRITE_PROPOSAL_SELECTION_REQUIRED',
          '请先选中要修改的正文'
        )
      }
    }
    return { metadata, chapterName, volumeName, documentId }
  }

  async createFromTool(context, args, signal) {
    if (signal?.aborted) throw new HarnessError('TOOL_CANCELLED', '工具调用已取消')
    const operation = String(args?.operation || '')
    if (!BODY_WRITE_OPERATIONS.includes(operation)) {
      throw new HarnessError('WRITE_PROPOSAL_OPERATION_INVALID', '不支持的正文修改操作')
    }
    const summary = String(args.summary || '').trim()
    const proposedText = normalizeBodyText(args.proposedText)
    if (!summary || summary.length > 120 || !proposedText || proposedText.length > 30000) {
      throw new HarnessError('TOOL_ARGUMENT_INVALID', '提案摘要或建议文本无效')
    }
    const workspace = context.workspace || {}
    const target = this.validateWorkspace(workspace, operation)
    const state = await this.conversationState(
      context.bookKey,
      context.conversationId,
      context.conversationState
    )

    return this.store.withLock(`write:${state.bookKey}:${state.conversationId}`, async () => {
      if (signal?.aborted) throw new HarnessError('TOOL_CANCELLED', '工具调用已取消')
      const proposals = await this.store.readWriteProposals(state.bookKey, state.conversationId)
      const internalToolCallId = context.idempotencyEnforced === true ? String(context.toolCallId || '') : ''
      const existingForCall = internalToolCallId
        ? proposals.find((item) => item.internalToolCallId === internalToolCallId || item.createdBy?.toolCallId === internalToolCallId)
        : null
      if (existingForCall) {
        return {
          data: { proposalId: existingForCall.proposalId, status: existingForCall.status, message: '已返回该工具调用创建的正文提案。' },
          proposal: publicProposal(existingForCall)
        }
      }
      const now = nowIso()
      const textRange = SELECTION_OPERATIONS.has(operation)
        ? { ...workspace.textRange }
        : null

      for (const existing of proposals) {
        if (
          existing.status === 'pending' &&
          existing.target?.documentId === target.documentId &&
          sameRange(existing.textRange, textRange)
        ) {
          const previousStatus = existing.status
          existing.status = 'superseded'
          existing.resolvedAt = now
          await this.persistStatus(
            state,
            proposals,
            existing,
            previousStatus,
            'WRITE_PROPOSAL_SUPERSEDED'
          )
        }
      }

      const record = {
        schemaVersion: 1,
        proposalType: 'chapter',
        proposalId: createId('proposal'),
        bookKey: state.bookKey,
        conversationId: state.conversationId,
        turnId: context.turnId,
        internalToolCallId,
        target: {
          documentId: target.documentId,
          chapterName: target.chapterName,
          volumeName: target.volumeName
        },
        operation,
        summary,
        originalText: SELECTION_OPERATIONS.has(operation)
          ? normalizeBodyText(workspace.selectionText)
          : '',
        proposedText,
        editorRange: SELECTION_OPERATIONS.has(operation)
          ? { ...workspace.editorRange }
          : null,
        textRange,
        baseSavedHash: workspace.currentDocumentSavedHash,
        status: 'pending',
        createdAt: now,
        resolvedAt: null,
        createdBy: {
          toolCallId: String(context.toolCallId || '')
        },
        appliedHash: null,
        undoSnapshotRef: null,
        failure: null
      }
      if (signal?.aborted) throw new HarnessError('TOOL_CANCELLED', '工具调用已取消')
      proposals.push(record)
      await this.stateMachine.recordCreated({
        state,
        proposals,
        record,
        write: this.store.writeWriteProposals.bind(this.store)
      })
      return {
        data: {
          proposalId: record.proposalId,
          status: record.status,
          message: '正文修改提案已创建，等待用户在界面确认；正文尚未写入。'
        },
        proposal: publicProposal(record)
      }
    })
  }

  async reconcileApplying(state, proposals) {
    let changed = false
    for (const record of proposals) {
      if (record.status !== 'applying') continue
      let currentHash = ''
      try {
        currentHash = this.snapshotService.readChapterSnapshot(
          state.bookKey,
          chapterTargetId(record.target.volumeName, record.target.chapterName)
        ).rawHash
      } catch {
        currentHash = ''
      }
      const previousStatus = record.status
      if (record.appliedHash && currentHash === record.appliedHash) {
        record.status = 'applied'
        record.resolvedAt = record.resolvedAt || nowIso()
        record.failure = null
      } else if (currentHash === record.baseSavedHash) {
        record.status = 'failed'
        record.failure = {
          code: 'WRITE_PROPOSAL_INTERRUPTED',
          message: '上次写入在完成前中断，可以安全重试',
          retryable: true
        }
      } else {
        record.status = 'stale'
        record.resolvedAt = nowIso()
        record.failure = {
          code: 'WRITE_PROPOSAL_CONTENT_STALE',
          message: '正文已发生变化，这条修改提案已失效',
          retryable: false
        }
      }
      await this.persistStatus(
        state,
        proposals,
        record,
        previousStatus,
        record.failure?.code || 'WRITE_PROPOSAL_RECOVERED'
      )
      changed = true
    }
    return changed
  }

  async list({ bookName, conversationId }) {
    const data = await this.store.loadConversation(bookName, conversationId)
    return this.store.withLock(`write:${bookName}:${conversationId}`, async () => {
      const proposals = await this.store.readWriteProposals(bookName, conversationId)
      await this.reconcileApplying(data.state, proposals)
      return proposals.map(publicProposal)
    })
  }

  async reject({ bookName, conversationId, proposalId }) {
    const data = await this.store.loadConversation(bookName, conversationId)
    return this.store.withLock(`write:${bookName}:${conversationId}`, async () => {
      const proposals = await this.store.readWriteProposals(bookName, conversationId)
      const record = proposals.find((item) => item.proposalId === proposalId)
      if (!record) throw new HarnessError('WRITE_PROPOSAL_NOT_FOUND', '修改提案不存在')
      if (record.status === 'rejected') return publicProposal(record)
      if (!['pending', 'failed'].includes(record.status)) {
        throw new HarnessError('WRITE_PROPOSAL_ALREADY_RESOLVED', '该提案已经处理')
      }
      const previousStatus = record.status
      record.status = 'rejected'
      record.resolvedAt = nowIso()
      record.failure = null
      const result = await this.persistStatus(
        data.state,
        proposals,
        record,
        previousStatus,
        'WRITE_PROPOSAL_REJECTED'
      )
      await this.store.deleteUndoSnapshot(bookName, conversationId, proposalId)
      return result
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
    return this.store.withLock(`write:${bookName}:${conversationId}`, async () => {
      const proposals = await this.store.readWriteProposals(bookName, conversationId)
      await this.reconcileApplying(data.state, proposals)
      const record = proposals.find((item) => item.proposalId === proposalId)
      if (!record) throw new HarnessError('WRITE_PROPOSAL_NOT_FOUND', '修改提案不存在')
      if (record.status === 'applied') {
        const snapshot = this.snapshotService.readChapterSnapshot(
          bookName,
          chapterTargetId(record.target.volumeName, record.target.chapterName)
        )
        return { proposal: publicProposal(record), content: snapshot.content, contentHash: snapshot.rawHash }
      }
      if (!['pending', 'failed'].includes(record.status)) {
        throw new HarnessError('WRITE_PROPOSAL_ALREADY_RESOLVED', '该提案已经处理')
      }

      const targetId = chapterTargetId(record.target.volumeName, record.target.chapterName)
      const before = this.snapshotService.readChapterSnapshot(bookName, targetId)
      if (before.rawHash !== record.baseSavedHash) {
        const previousStatus = record.status
        record.status = 'stale'
        record.resolvedAt = nowIso()
        record.failure = {
          code: 'CHAPTER_VERSION_CONFLICT',
          message: '正文已发生变化，这条修改提案已失效',
          retryable: false
        }
        await this.persistStatus(
          data.state,
          proposals,
          record,
          previousStatus,
          'CHAPTER_VERSION_CONFLICT'
        )
        throw new HarnessError('CHAPTER_VERSION_CONFLICT', record.failure.message)
      }

      const applied = applyBodyOperation({
        content: before.content,
        textRange: record.textRange,
        operation: record.operation,
        originalText: record.originalText,
        proposedText: record.proposedText
      })
      if (!applied.ok) {
        const previousStatus = record.status
        record.status = 'stale'
        record.resolvedAt = nowIso()
        record.failure = {
          code: applied.code,
          message: '正文目标已发生变化，这条修改提案已失效',
          retryable: false
        }
        await this.persistStatus(data.state, proposals, record, previousStatus, applied.code)
        throw new HarnessError(applied.code, record.failure.message)
      }

      const materializedContent = materializeLineEndings(
        applied.nextContent,
        before.metadata.lineEnding
      )
      const diskContent = before.metadata.hasBom
        ? `\uFEFF${materializedContent}`
        : materializedContent
      const undoContent = await fs.readFile(before.metadata.filePath, 'utf8')
      await this.store.writeUndoSnapshot(bookName, conversationId, proposalId, {
        proposalId,
        content: undoContent,
        contentHash: before.rawHash,
        createdAt: nowIso()
      })
      const previousStatus = record.status
      record.status = 'applying'
      record.appliedHash = sha256(diskContent)
      record.undoSnapshotRef = `proposal:${proposalId}`
      record.failure = null
      await this.persistStatus(
        data.state,
        proposals,
        record,
        previousStatus,
        'WRITE_PROPOSAL_APPLYING'
      )

      try {
        const result = await this.chapterWriteService.writeChapterWithExpectedHash({
          bookName,
          volumeName: record.target.volumeName,
          chapterName: record.target.chapterName,
          expectedHash: record.baseSavedHash,
          content: diskContent
        })
        const applyingStatus = record.status
        record.status = 'applied'
        record.appliedHash = result.contentHash
        record.resolvedAt = nowIso()
        record.failure = null
        await this.persistStatus(
          data.state,
          proposals,
          record,
          applyingStatus,
          'WRITE_PROPOSAL_APPLIED'
        )
        return {
          proposal: publicProposal(record),
          content: applied.nextContent,
          contentHash: result.contentHash,
          savedAt: result.savedAt
        }
      } catch (error) {
        const applyingStatus = record.status
        record.status = error?.code === 'CHAPTER_VERSION_CONFLICT' ? 'stale' : 'failed'
        record.resolvedAt = record.status === 'stale' ? nowIso() : null
        record.failure = proposalFailure(error)
        await this.persistStatus(
          data.state,
          proposals,
          record,
          applyingStatus,
          record.failure.code
        )
        throw new HarnessError(record.failure.code, record.failure.message, {
          retryable: record.failure.retryable,
          cause: error
        })
      }
    })
  }

  async undo({ bookName, conversationId, proposalId }) {
    const data = await this.store.loadConversation(bookName, conversationId)
    return this.store.withLock(`write:${bookName}:${conversationId}`, async () => {
      const proposals = await this.store.readWriteProposals(bookName, conversationId)
      await this.reconcileApplying(data.state, proposals)
      const record = proposals.find((item) => item.proposalId === proposalId)
      if (!record) throw new HarnessError('WRITE_PROPOSAL_NOT_FOUND', '修改提案不存在')
      if (record.status === 'undone') return { proposal: publicProposal(record) }
      if (record.status !== 'applied') {
        throw new HarnessError('WRITE_PROPOSAL_INVALID_TRANSITION', '当前提案不能撤销')
      }
      const targetId = chapterTargetId(record.target.volumeName, record.target.chapterName)
      const current = this.snapshotService.readChapterSnapshot(bookName, targetId)
      if (current.rawHash !== record.appliedHash) {
        throw new HarnessError(
          'WRITE_PROPOSAL_UNDO_CONFLICT',
          '正文在写入后已发生变化，无法安全撤销'
        )
      }
      const undo = await this.store.readUndoSnapshot(bookName, conversationId, proposalId)
      if (!undo || undo.contentHash !== record.baseSavedHash) {
        throw new HarnessError('WRITE_PROPOSAL_UNDO_MISSING', '撤销快照不可用')
      }
      const result = await this.chapterWriteService.writeChapterWithExpectedHash({
        bookName,
        volumeName: record.target.volumeName,
        chapterName: record.target.chapterName,
        expectedHash: record.appliedHash,
        content: undo.content
      })
      const previousStatus = record.status
      record.status = 'undone'
      record.resolvedAt = nowIso()
      record.failure = null
      record.undoSnapshotRef = null
      await this.persistStatus(
        data.state,
        proposals,
        record,
        previousStatus,
        'WRITE_PROPOSAL_UNDONE'
      )
      await this.store.deleteUndoSnapshot(bookName, conversationId, proposalId)
      return {
        proposal: publicProposal(record),
        content: normalizeBodyText(undo.content),
        contentHash: result.contentHash,
        savedAt: result.savedAt
      }
    })
  }
}

export default BodyWriteProposalService
