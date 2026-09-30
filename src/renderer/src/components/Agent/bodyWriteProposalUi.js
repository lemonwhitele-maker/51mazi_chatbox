export function bodyWriteProposalActions(proposal = {}) {
  if (proposal.legacyReadOnly === true)
    return { canConfirm: false, canReject: false, canCopy: true, canUndo: false }
  const retryableFailure = proposal.status === 'failed' && proposal.failure?.retryable === true
  const trustedDocumentAction =
    proposal.proposalType !== 'document' || Boolean(proposal.confirmationCredential)
  return {
    canConfirm: trustedDocumentAction && (proposal.status === 'pending' || retryableFailure),
    canReject: trustedDocumentAction && (proposal.status === 'pending' || retryableFailure),
    canCopy: Boolean(proposal.proposedText || proposal.preview?.after),
    canUndo: trustedDocumentAction && proposal.status === 'applied'
  }
}

export function mergeHarnessTimeline(messages = [], proposals = []) {
  return [
    ...messages.map((value, index) => ({
      kind: 'message',
      key: `message:${value.id}`,
      value,
      createdAt: value.createdAt || '',
      order: index
    })),
    ...proposals.map((value, index) => ({
      kind: 'proposal',
      key: `proposal:${value.proposalId}`,
      value,
      createdAt: value.createdAt || '',
      order: messages.length + index
    }))
  ].sort((left, right) =>
    left.createdAt && right.createdAt
      ? left.createdAt.localeCompare(right.createdAt) || left.order - right.order
      : left.order - right.order
  )
}
