// Compare the frozen preview, so restored proposals and normalized text use the
// same display as new proposals. This never changes the candidate being saved.
export function editPreviewFragments(before, after) {
  if (before === after) return []
  const left = before.match(/[^\n]*\n|[^\n]+$/g) || []
  const right = after.match(/[^\n]*\n|[^\n]+$/g) || []
  let head = 0
  while (head < left.length && head < right.length && left[head] === right[head]) head++
  let tail = 0
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  )
    tail++
  const a = left.slice(head, left.length - tail)
  const b = right.slice(head, right.length - tail)
  const ranges = []
  // Bound memory and work for unusually large documents. The fallback includes
  // every changed character rather than silently dropping an unaligned change.
  if (a.length * b.length > 1000000) {
    ranges.push({ aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length })
  } else {
    const width = b.length + 1
    const table = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    let range = null
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        if (range) ranges.push({ ...range, aEnd: i, bEnd: j })
        range = null
        i++
        j++
      } else {
        range ||= { aStart: i, bStart: j }
        if (
          i < a.length &&
          (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])
        )
          i++
        else j++
      }
    }
    if (range) ranges.push({ ...range, aEnd: i, bEnd: j })
  }
  return ranges.map((range) => {
    // Code points prevent clipping half of an emoji at the display boundary.
    const oldChars = Array.from(a.slice(range.aStart, range.aEnd).join(''))
    const newChars = Array.from(b.slice(range.bStart, range.bEnd).join(''))
    let start = 0
    while (
      start < oldChars.length &&
      start < newChars.length &&
      oldChars[start] === newChars[start]
    )
      start++
    let end = 0
    while (
      end < oldChars.length - start &&
      end < newChars.length - start &&
      oldChars[oldChars.length - 1 - end] === newChars[newChars.length - 1 - end]
    )
      end++
    const prefix = left.slice(0, head + range.aStart).join('') + oldChars.slice(0, start).join('')
    const suffix =
      oldChars.slice(oldChars.length - end).join('') + left.slice(head + range.aEnd).join('')
    const prefixChars = Array.from(prefix)
    const suffixChars = Array.from(suffix)
    return {
      before: oldChars.slice(start, oldChars.length - end).join(''),
      after: newChars.slice(start, newChars.length - end).join(''),
      leading: prefixChars.slice(-40).join(''),
      trailing: suffixChars.slice(0, 40).join(''),
      omittedBefore: prefixChars.length > 40,
      omittedAfter: suffixChars.length > 40
    }
  })
}
