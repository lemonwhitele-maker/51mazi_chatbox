import fs from 'node:fs'
import { join } from 'node:path'

let logDirectory = null
export function configureSaveDiagnostics(directory) { logDirectory = directory }

export function saveErrorDetails(error, depth = 0) {
  if (!error || depth > 3) return null
  return {
    name: error.name, code: error.code, message: error.message,
    stack: error.stack, syscall: error.syscall, path: error.path, dest: error.dest,
    expectedHash: error.expectedHash, currentHash: error.currentHash,
    cause: saveErrorDetails(error.cause, depth + 1)
  }
}

// Diagnostics must never change whether a save succeeds. No document text is logged.
export function logSaveDiagnostic(event, details = {}) {
  if (!logDirectory) return
  try {
    fs.mkdirSync(logDirectory, { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    fs.appendFileSync(join(logDirectory, `save-diagnostics-${date}.jsonl`),
      `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...details })}\n`, 'utf8')
  } catch (error) { console.warn('保存诊断日志写入失败:', error.message) }
}

export function logRendererSaveDiagnostic(senderId, payload) {
  if (!payload || typeof payload.event !== 'string') return
  const details = { senderId }
  for (const key of ['bookName', 'path', 'name', 'volume', 'type', 'proposalId', 'targetId',
    'savedHash', 'previousHash', 'expectedHash', 'contentHash', 'currentHash', 'hasEditor',
    'dirty', 'success', 'code', 'reason', 'contentLength', 'manual']) {
    const value = payload[key]
    if (['string', 'boolean', 'number'].includes(typeof value))
      details[key] = typeof value === 'string' ? value.slice(0, 1024) : value
  }
  logSaveDiagnostic(`renderer.${payload.event.slice(0, 100)}`, details)
}
