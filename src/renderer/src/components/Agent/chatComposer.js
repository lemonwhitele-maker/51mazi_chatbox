export function shouldSendOnComposerKeydown(event, { draft, loading, composing } = {}) {
  if (event?.key !== 'Enter' || event?.shiftKey) return false
  if (event?.isComposing || composing || event?.keyCode === 229) return false
  return loading !== true && Boolean(String(draft || '').trim())
}
