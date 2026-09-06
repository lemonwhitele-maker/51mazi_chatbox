export const BODY_WRITE_OPERATIONS = Object.freeze([
  'replace_selection',
  'insert_before_selection',
  'insert_after_selection',
  'append_to_chapter'
])

export const BODY_WRITE_STATUSES = Object.freeze([
  'pending',
  'applying',
  'applied',
  'rejected',
  'superseded',
  'stale',
  'failed',
  'undone'
])

export const BODY_WRITE_TERMINAL_STATUSES = Object.freeze(
  new Set(['rejected', 'superseded', 'stale', 'undone'])
)

export function normalizeBodyText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function validRange(range, contentLength) {
  const start = Number(range?.start)
  const end = Number(range?.end)
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end >= start &&
    end <= contentLength
  )
}

function appendSeparator(content, proposedText) {
  if (!content || !proposedText) return ''
  const trailing = content.match(/\n*$/)?.[0]?.length || 0
  const leading = proposedText.match(/^\n*/)?.[0]?.length || 0
  return '\n'.repeat(Math.max(0, 2 - trailing - leading))
}

export function applyBodyOperation({
  content,
  textRange,
  operation,
  originalText,
  proposedText
} = {}) {
  const source = normalizeBodyText(content)
  const original = normalizeBodyText(originalText)
  const proposed = normalizeBodyText(proposedText)

  if (!BODY_WRITE_OPERATIONS.includes(operation)) {
    return { ok: false, code: 'WRITE_PROPOSAL_OPERATION_INVALID' }
  }
  if (!proposed) return { ok: false, code: 'WRITE_PROPOSAL_TEXT_REQUIRED' }

  if (operation === 'append_to_chapter') {
    const separator = appendSeparator(source, proposed)
    return {
      ok: true,
      nextContent: `${source}${separator}${proposed}`,
      changedRange: {
        start: source.length,
        end: source.length + separator.length + proposed.length
      }
    }
  }

  if (!validRange(textRange, source.length) || textRange.start === textRange.end) {
    return { ok: false, code: 'WRITE_PROPOSAL_RANGE_INVALID' }
  }
  const current = source.slice(textRange.start, textRange.end)
  if (current !== original) return { ok: false, code: 'WRITE_PROPOSAL_CONTENT_STALE' }

  let insertionStart = textRange.start
  let insertionEnd = textRange.end
  if (operation === 'insert_before_selection') insertionEnd = insertionStart
  if (operation === 'insert_after_selection') insertionStart = insertionEnd

  return {
    ok: true,
    nextContent: `${source.slice(0, insertionStart)}${proposed}${source.slice(insertionEnd)}`,
    changedRange: { start: insertionStart, end: insertionStart + proposed.length }
  }
}

export function materializeLineEndings(content, lineEnding = 'LF') {
  const normalized = normalizeBodyText(content)
  if (lineEnding === 'CRLF') return normalized.replace(/\n/g, '\r\n')
  if (lineEnding === 'CR') return normalized.replace(/\n/g, '\r')
  return normalized
}
