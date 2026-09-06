import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

const agentDiffPreviewKey = new PluginKey('agentDiffPreview')
const supportedOperations = new Set([
  'replace_selection',
  'insert_before_selection',
  'insert_after_selection',
  'append_to_chapter'
])

function createDecorations(doc, diff) {
  const operation = String(diff?.operation || 'replace_selection')
  if (!supportedOperations.has(operation)) return DecorationSet.empty
  const isAppend = operation === 'append_to_chapter'
  const from = isAppend ? doc.content.size : Number(diff?.range?.from)
  const to = isAppend ? doc.content.size : Number(diff?.range?.to)
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from < 0 ||
    to > doc.content.size ||
    (!isAppend && from >= to)
  ) return DecorationSet.empty

  const decorations = []
  if (operation === 'replace_selection') {
    decorations.push(
      Decoration.inline(
        from,
        to,
        {
          class: 'agent-diff-preview-original',
          'data-agent-diff-id': String(diff.id || '')
        },
        { inclusiveStart: false, inclusiveEnd: false }
      )
    )
  }
  const widgetPosition = operation === 'insert_before_selection' ? from : to
  const replacement = Decoration.widget(
    widgetPosition,
    () => {
      const element = document.createElement('span')
      element.className = 'agent-diff-preview-inserted'
      element.dataset.agentDiffId = String(diff.id || '')
      element.setAttribute('contenteditable', 'false')
      element.setAttribute('role', 'note')
      element.textContent = String(diff.replacementText || '')
      return element
    },
    {
      side: operation === 'insert_before_selection' ? -1 : 1,
      key: `agent-diff-${String(diff.id || 'pending')}`
    }
  )
  decorations.push(replacement)

  return DecorationSet.create(doc, decorations)
}

export const AgentDiffPreview = Extension.create({
  name: 'agentDiffPreview',

  addCommands() {
    return {
      showAgentDiffPreview:
        (diff) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(agentDiffPreviewKey, { action: 'show', diff }))
          return true
        },
      clearAgentDiffPreview:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(agentDiffPreviewKey, { action: 'clear' }))
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: agentDiffPreviewKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, previous) {
            const meta = tr.getMeta(agentDiffPreviewKey)
            if (meta?.action === 'clear') return DecorationSet.empty
            if (meta?.action === 'show') return createDecorations(tr.doc, meta.diff)
            return previous.map(tr.mapping, tr.doc)
          }
        },
        props: {
          decorations(state) {
            return agentDiffPreviewKey.getState(state)
          }
        }
      })
    ]
  }
})
