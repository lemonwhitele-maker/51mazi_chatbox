import yaml from 'js-yaml'
import { HarnessError } from '../harnessErrors.js'
import { parseKnowledgeMarkdown } from '../../services/knowledgeMarkdownParser.js'

const REFERENCE_FIELDS = {
  relatedOutlines: 'outline', chapterRefs: 'chapter', characterRefs: 'character', settingRefs: 'setting'
}
const isPath = (value) => typeof value === 'string' && /^book\//i.test(value)

function invalid(message) {
  throw new HarnessError('DOCUMENT_FORMAT_INVALID', message, {
    retryable: true, nextAction: '引用路径使用普通 YAML 字符串数组；edit 请包含完整的引用值'
  })
}

// Replace only reference tokens, preserving surrounding metadata, comments,
// line endings and body bytes. During edit, untouched tokens stay untouched.
export function normalizeDocumentPathReferences(source, resolveReference, { knowledge = true, changedRanges = null } = {}) {
  const replacements = new Map()
  const include = (start, end) => {
    if (!changedRanges) return true
    if (changedRanges.some((range) => start >= range.start && end <= range.end)) return true
    if (changedRanges.some((range) => start < range.end && end > range.start))
      invalid('路径引用的局部修改需要包含完整引用值')
    return false
  }
  const add = (start, end, text) => replacements.set(`${start}:${end}`, { start, end, text })
  let bodyStart = 0
  if (knowledge) {
    const parsed = parseKnowledgeMarkdown(source)
    if (parsed.diagnostics.some((item) => item.code.startsWith('FRONTMATTER_'))) return source
    bodyStart = parsed.frontmatter.bodyStart
    const raw = parsed.frontmatter.raw
    const offset = source.indexOf(raw, source.indexOf('\n') + 1)
    const nodes = []
    const stack = []
    const metadata = yaml.load(raw, {
      schema: yaml.JSON_SCHEMA,
      listener(event, state) {
        if (event === 'open') stack.push({ start: state.position })
        else nodes.push({ ...stack.pop(), end: state.position, kind: state.kind, value: state.result, anchor: state.anchor })
      }
    })
    for (const [field, type] of Object.entries(REFERENCE_FIELDS)) {
      const values = metadata?.[field]
      if (!Array.isArray(values) || !values.some(isPath)) continue
      const sequences = nodes.filter((node) => node.value === values)
      if (changedRanges && !sequences.some((node) => changedRanges.some((range) =>
        offset + node.start < range.end && offset + node.end > range.start))) continue
      if (sequences.length !== 1 || sequences[0].anchor || sequences[0].kind !== 'sequence')
        invalid(`${field} 的路径引用不支持 YAML 锚点或别名`)
      const sequence = sequences[0]
      for (const node of nodes) {
        if (node.start < sequence.start || node.end > sequence.end || !isPath(node.value)) continue
        const token = raw.slice(node.start, node.end)
        const leading = /^\s*/.exec(token)[0].length
        const trailing = /\s*$/.exec(token)[0].length
        const start = offset + node.start + leading
        const end = offset + node.end - trailing
        if (!include(start, end)) continue
        if (node.anchor || node.kind !== 'scalar' || /^[&*!>|]/.test(token.trimStart()))
          invalid(`${field} 的路径引用必须使用普通字符串`)
        add(start, end, JSON.stringify(resolveReference(node.value, type)))
      }
    }
  }
  const body = source.slice(bodyStart)
  for (const match of body.matchAll(/\[\[(book\/[^\]|\r\n]+)(?:\|[^\]\r\n]*)?\]\]/gi)) {
    const start = bodyStart + match.index + 2
    const end = start + match[1].length
    if (include(start, end)) add(start, end, resolveReference(match[1]))
  }
  for (const item of [...replacements.values()].sort((left, right) => right.start - left.start))
    source = source.slice(0, item.start) + item.text + source.slice(item.end)
  return source
}
