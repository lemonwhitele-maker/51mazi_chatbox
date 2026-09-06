export function normalizeMessageClipboardText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

export function setPlainTextClipboardEvent(event, value) {
  if (!event?.clipboardData || typeof event.clipboardData.setData !== 'function') return false
  event.preventDefault?.()
  event.clipboardData.setData('text/plain', normalizeMessageClipboardText(value))
  return true
}

export async function copyMessagePlainText(value, clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    throw new Error('当前环境不支持剪贴板写入')
  }
  const text = normalizeMessageClipboardText(value)
  await clipboard.writeText(text)
  return text
}
