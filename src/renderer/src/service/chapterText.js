import { getText, getTextBetween } from '@tiptap/core'

export const CHAPTER_BLOCK_SEPARATOR = '\n\n'

const textOptions = Object.freeze({ blockSeparator: CHAPTER_BLOCK_SEPARATOR })

export function serializeChapterDocument(document) {
  if (!document) return ''
  return getText(document, textOptions)
}

export function serializeChapterEditor(editor) {
  const document = editor?.state?.doc
  return document ? serializeChapterDocument(document) : ''
}

export function editorRangeToTextRange(document, range) {
  if (!document || !range) throw new TypeError('document and range are required')
  const from = Math.floor(Number(range.from))
  const to = Math.floor(Number(range.to))
  const max = document.content.size
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from || to > max) {
    throw new RangeError('editor range is invalid')
  }

  const fullText = serializeChapterDocument(document)
  const before = getTextBetween(document, { from: 0, to: from }, textOptions)
  const originalText = getTextBetween(document, { from, to }, textOptions)
  const start = before.length
  const end = start + originalText.length

  if (fullText.slice(start, end) !== originalText) {
    throw new RangeError('editor range cannot be mapped to serialized chapter text')
  }

  return {
    editorRange: { from, to },
    textRange: { start, end },
    originalText
  }
}
