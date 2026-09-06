export function bodyWriteProposalActions(proposal = {}) {
  const retryableFailure = proposal.status === 'failed' && proposal.failure?.retryable === true
  return {
    canConfirm: proposal.status === 'pending' || retryableFailure,
    canReject: proposal.status === 'pending' || retryableFailure,
    canCopy: Boolean(proposal.proposedText || proposal.preview?.after),
    canUndo: proposal.status === 'applied'
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
