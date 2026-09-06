import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

const agentSelectionHighlightKey = new PluginKey('agentSelectionHighlight')

export function createAgentSelectionDecorations(doc, selection) {
  const from = Number(selection?.from)
  const to = Number(selection?.to)
  if (
    !doc ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from < 0 ||
    to > doc.content.size ||
    from >= to
  )
    return DecorationSet.empty

  return DecorationSet.create(doc, [
    Decoration.inline(
      from,
      to,
      {
        class: 'agent-selection-highlight',
        'data-agent-selection': 'true'
      },
      { inclusiveStart: false, inclusiveEnd: false }
    )
  ])
}

export const AgentSelectionHighlight = Extension.create({
  name: 'agentSelectionHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: agentSelectionHighlightKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, previous) {
            if (tr.selectionSet || tr.docChanged) {
              return createAgentSelectionDecorations(tr.doc, tr.selection)
            }
            return previous
          }
        },
        props: {
          decorations(state) {
            return agentSelectionHighlightKey.getState(state)
          }
        }
      })
    ]
  }
})

export default AgentSelectionHighlight
