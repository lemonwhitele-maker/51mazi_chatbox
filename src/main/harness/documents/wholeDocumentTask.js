import { HarnessError } from '../harnessErrors.js'

// This state is created from user input by the host, never from tool arguments.
export function createWholeDocumentTask(text = '', previousUserText = '') {
  let request = String(text).trim()
  if (/^(再次尝试|再试一次|继续|继续吧|好的，?继续)[。！!\s]*$/.test(request))
    request = previousUserText
  if (/(只|仅).{0,8}(开头|前.{0,6}[字章段]|选区|片段|局部)/.test(request)) return null
  const whole = /全文|整篇|完整阅读|读完|通读/.test(request)
  const outline = /总纲|大纲|划分章节|章节划分|章节规划|分章节|分为.{0,6}章|拆[分成].{0,6}章/.test(
    request
  )
  if (!whole && !(outline && /速记|草稿|正文|文档/.test(request))) return null
  const notesOnly = /速记/.test(request) && !/正文|全书/.test(request)
  const paths = new Set(notesOnly ? ['book/notes/quick-notes.md'] : [])
  for (const path of request.match(/book\/[\w\u3400-\u9fff./-]+\.(?:md|txt)/gi) || [])
    paths.add(path)
  return { notesOnly, paths, versions: new Map() }
}

export function trackWholeDocumentRead(task, result) {
  if (!task) return
  if (result?.data?.resultType === 'document_batch') {
    for (const item of result.data.items) trackWholeDocumentRead(task, item)
    for (const path of result.data.pendingPaths || []) {
      if (path.startsWith('book/') && (!task.notesOnly || path.startsWith('book/notes/')))
        task.paths.add(path)
    }
    return
  }
  const data = result?.data
  if (data?.resultType !== 'document_read' || !data.evidenceEligible) return
  if (!task.notesOnly || data.sourceType === 'note') {
    task.paths.add(data.path)
    task.versions.set(data.path, data.savedHash)
  }
}

export async function assertWholeDocumentRead(context, ledger, documents) {
  const task = context.wholeDocumentTask
  if (!task) return
  if (!task.paths.size)
    throw new HarnessError(
      'TASK_READ_INCOMPLETE',
      '整篇整理尚未读取源文档，请先定位并完整读取材料。',
      { retryable: true }
    )
  for (const requestedPath of task.paths) {
    const path = documents.canonicalPath(context.bookScope, requestedPath)
    const { snapshot } = await documents.currentWritableSnapshot(context, path)
    task.versions.set(path, snapshot.savedHash)
    if (!ledger?.hasFullRead(context, path, snapshot.savedHash)) {
      const entry = ledger?.find(context, path, snapshot.savedHash)
      const readChars =
        entry?.ranges.reduce((total, range) => total + range.end - range.start, 0) || 0
      throw new HarnessError(
        'TASK_READ_INCOMPLETE',
        `整篇整理尚未完成：${path} 当前版本已读 ${readChars}/${snapshot.text.length} 字符。请先补齐原文；尚未创建修改提案。`,
        {
          retryable: true,
          nextAction: `继续 read ${path}：只需传入该版本上次返回的短 cursor；版本变化或游标失效时用 path 从头读取。`
        }
      )
    }
  }
}
