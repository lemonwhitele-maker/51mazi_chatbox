function keyOf(context, path, version) {
  return [
    context?.scopeId || context?.bookScope?.scopeId || '',
    context?.conversationId || '',
    context?.turnId || '',
    path,
    version
  ].join('|')
}

function mergeRanges(ranges) {
  const sorted = ranges
    .map((range) => ({ start: range.start, end: range.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (!previous || range.start > previous.end) merged.push(range)
    else previous.end = Math.max(previous.end, range.end)
  }
  return merged
}

export class ReadSnapshotLedger {
  constructor() {
    this.entries = new Map()
    this.reusable = new Map()
  }

  recordDelivery(context, result, delivery = {}) {
    if (result?.ok && result.data?.resultType === 'document_batch')
      return result.data.items.map((item) => this.recordDelivery(context, item, delivery))
    const data = result?.data
    if (!result?.ok || data?.resultType !== 'document_read' || !data?.evidenceEligible) return null
    const range = data.returnedCoverage || data.range
    if (
      !data.path ||
      !data.savedHash ||
      !range ||
      !Number.isInteger(range.startOffset) ||
      !Number.isInteger(range.endOffset) ||
      !Number.isInteger(range.totalChars)
    ) {
      return null
    }
    // Cache only complete, acknowledged raw document results, never summaries.
    const bookIdentity = context?.bookScope?.bookIdentity
    if (bookIdentity && data.complete && range.startOffset === 0 && range.endOffset === range.totalChars && data.text?.length === range.totalChars) {
      const cacheKey = `${bookIdentity}|${context.conversationId}|${data.path}`
      this.reusable.delete(cacheKey)
      this.reusable.set(cacheKey, { bookIdentity, conversationId: context.conversationId, path: data.path, savedHash: data.savedHash })
      while (this.reusable.size > 64) this.reusable.delete(this.reusable.keys().next().value)
    }
    const key = keyOf(context, data.path, data.savedHash)
    const previous = this.entries.get(key) || {
      scopeId: context?.scopeId || context?.bookScope?.scopeId || null,
      conversationId: context?.conversationId || null,
      turnId: context?.turnId || null,
      path: data.path,
      savedHash: data.savedHash,
      sourceType: data.sourceType || null,
      objectId: data.objectId || null,
      authorityStatus: data.authorityStatus || null,
      totalChars: range.totalChars,
      references: [],
      ranges: [],
      complete: false
    }
    previous.ranges = mergeRanges([
      ...previous.ranges,
      { start: range.startOffset, end: range.endOffset }
    ])
    previous.references = [
      ...new Set([
        ...previous.references,
        ...(Array.isArray(result.references) ? result.references : [])
      ])
    ]
    previous.complete =
      previous.ranges.length === 1 &&
      previous.ranges[0].start === 0 &&
      previous.ranges[0].end >= previous.totalChars
    previous.deliveredAt = delivery.resultAckedAt || new Date().toISOString()
    previous.deliverySequence = Number.isInteger(delivery.deliverySequence)
      ? delivery.deliverySequence
      : null
    this.entries.set(key, previous)
    return Object.freeze({ ...previous, ranges: previous.ranges.map((item) => ({ ...item })) })
  }

  reusableReads(context) {
    return [...this.reusable.values()].filter((item) => item.bookIdentity === context?.bookScope?.bookIdentity && item.conversationId === context.conversationId).reverse().slice(0, 8)
  }

  find(context, path, version = null) {
    const prefix = keyOf(context, path, version || '')
    if (version) return this.entries.get(prefix) || null
    return [...this.entries.entries()].find(([key]) => key.startsWith(prefix))?.[1] || null
  }

  list(context) {
    const prefix = [
      context?.scopeId || context?.bookScope?.scopeId || '',
      context?.conversationId || '',
      context?.turnId || ''
    ].join('|')
    return [...this.entries.entries()]
      .filter(([key]) => key.startsWith(`${prefix}|`))
      .map(([, value]) => ({ ...value, ranges: value.ranges.map((range) => ({ ...range })) }))
  }

  coversRange(context, path, version, startOffset, endOffset) {
    const entry = this.find(context, path, version)
    if (!entry) return false
    return entry.ranges.some(
      (range) => range.start <= Number(startOffset) && range.end >= Number(endOffset)
    )
  }

  hasFullRead(context, path, version) {
    return this.find(context, path, version)?.complete === true
  }

  evidenceReferences(context, { authoritativeOnly = false } = {}) {
    return [
      ...new Set(
        this.list(context)
          .filter((entry) => !authoritativeOnly || entry.authorityStatus === 'authoritative_saved')
          .flatMap((entry) => entry.references)
      )
    ]
  }

  clearTurn(context) {
    for (const entry of this.list(context))
      this.entries.delete(keyOf(context, entry.path, entry.savedHash))
  }
}

export default ReadSnapshotLedger
