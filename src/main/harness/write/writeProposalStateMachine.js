import { nowIso } from '../ids.js'

export const TERMINAL_PROPOSAL_STATUSES = Object.freeze([
  'applied',
  'rejected',
  'superseded',
  'stale',
  'conflicted',
  'undone'
])

export function publicWriteProposal(record) {
  if (!record) return null
  const proposal = structuredClone(record)
  delete proposal.createdBy
  delete proposal.undoSnapshotRef
  delete proposal.previewSource
  return proposal
}

export function writeProposalFailure(error, fallbackCode = 'WRITE_PROPOSAL_APPLY_FAILED') {
  return {
    code: String(error?.code || fallbackCode),
    message: String(error?.message || '写入失败'),
    retryable: error?.retryable === true
  }
}

export function transitionWriteProposal(
  record,
  status,
  { failure = undefined, resolved = undefined } = {}
) {
  const previousStatus = record.status
  record.status = status
  if (failure !== undefined) record.failure = failure
  const shouldResolve =
    resolved === true || (resolved !== false && TERMINAL_PROPOSAL_STATUSES.includes(status))
  record.resolvedAt = shouldResolve ? record.resolvedAt || nowIso() : null
  return previousStatus
}

export class WriteProposalStateMachine {
  constructor({ store, eventSink = () => {}, eventPrefix = 'write.proposal' } = {}) {
    if (!store) throw new TypeError('store is required')
    this.store = store
    this.eventSink = eventSink
    this.eventPrefix = eventPrefix
  }

  async conversationState(bookKey, conversationId, preferred = null) {
    if (preferred?.bookKey === bookKey && preferred?.conversationId === conversationId) {
      return preferred
    }
    return (await this.store.loadConversation(bookKey, conversationId)).state
  }

  emit(type, record) {
    this.eventSink({
      type,
      bookName: record.bookKey,
      conversationId: record.conversationId,
      proposalId: record.proposalId,
      proposal: publicWriteProposal(record)
    })
  }

  async persist({ state, proposals, record, write, previousStatus, reasonCode = null }) {
    await write(state.bookKey, state.conversationId, proposals)
    if (previousStatus !== record.status) {
      await this.store.appendTranscript(
        state,
        `${this.eventPrefix}.status.changed`,
        record.turnId,
        null,
        {
          proposalId: record.proposalId,
          previousStatus,
          status: record.status,
          reasonCode,
          resolvedAt: record.resolvedAt
        }
      )
    }
    this.emit(`${this.eventPrefix}.updated`, record)
    return publicWriteProposal(record)
  }

  async recordCreated({ state, proposals, record, write }) {
    await write(state.bookKey, state.conversationId, proposals)
    await this.store.appendTranscript(state, `${this.eventPrefix}.created`, record.turnId, null, {
      proposal: publicWriteProposal(record)
    })
    this.emit(`${this.eventPrefix}.created`, record)
    return publicWriteProposal(record)
  }
}

export default WriteProposalStateMachine
