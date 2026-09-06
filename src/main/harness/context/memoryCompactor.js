import { nowIso } from '../ids.js'

export const MEMORY_SCHEMA_VERSION = 2

export function emptyMemory(conversationId = null) {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    conversationId,
    summaryVersion: 0,
    coveredThroughMessageId: null,
    objective: '',
    userPreferences: [],
    confirmedDecisions: [],
    modelSuggestions: [],
    workingFacts: [],
    unresolvedQuestions: [],
    currentWork: [],
    sourceReferences: [],
    updatedAt: nowIso()
  }
}

export function validateMemoryV2(value) {
  const required = ['objective', 'userPreferences', 'confirmedDecisions', 'modelSuggestions', 'workingFacts', 'unresolvedQuestions', 'currentWork', 'sourceReferences', 'coveredThroughMessageId']
  if (!value || value.schemaVersion !== MEMORY_SCHEMA_VERSION) return { ok: false, errors: ['schemaVersion 必须为 2'] }
  const errors = required.filter((key) => !(key in value))
  for (const key of required.filter((key) => key !== 'objective' && key !== 'coveredThroughMessageId')) if (!Array.isArray(value[key])) errors.push(`${key} 必须是数组`)
  if (value.objective !== null && typeof value.objective !== 'string') errors.push('objective 必须是 string')
  return { ok: errors.length === 0, errors }
}

export class MemoryCompactor {
  constructor({ triggerRatio = 0.85, maxInputTokens = 24000, keepRecentMessages = 6 } = {}) { this.triggerRatio = triggerRatio; this.maxInputTokens = maxInputTokens; this.keepRecentMessages = keepRecentMessages }

  shouldCompact(estimatedTokens, transcript) { return estimatedTokens > this.maxInputTokens * this.triggerRatio || transcript.filter((item) => item.type === 'message.user').length > 24 }

  compact({ conversationId, transcript, previous = {}, sourceReferences = [] }) {
    const base = { ...emptyMemory(conversationId), ...previous, schemaVersion: MEMORY_SCHEMA_VERSION, conversationId, summaryVersion: Number(previous.summaryVersion || 0) + 1 }
    const messages = transcript.filter((item) => item.type === 'message.user' || item.type === 'message.assistant')
    const old = messages.slice(0, Math.max(0, messages.length - this.keepRecentMessages))
    const coveredIndex = messages.findIndex((item) => item.messageId === previous.coveredThroughMessageId)
    const newCovered = old.at(-1)?.messageId || null
    if (coveredIndex >= 0 && (!newCovered || messages.findIndex((item) => item.messageId === newCovered) <= coveredIndex)) {
      base.summaryVersion = Number(previous.summaryVersion || 0)
      base.updatedAt = nowIso()
      return base
    }
    const userMessages = old.filter((item) => item.type === 'message.user').map((item) => String(item.payload?.text || '').trim()).filter(Boolean)
    const assistantMessages = old.filter((item) => item.type === 'message.assistant').map((item) => String(item.payload?.text || '').trim()).filter(Boolean)
    base.coveredThroughMessageId = newCovered || previous.coveredThroughMessageId || null
    base.objective = userMessages.at(-1) || previous.objective || ''
    base.currentWork = [...userMessages.slice(-5), ...assistantMessages.slice(-3)].slice(-8)
    base.sourceReferences = [...new Map([...(previous.sourceReferences || []), ...sourceReferences].map((item) => [JSON.stringify(item), item])).values()].slice(-24)
    base.updatedAt = nowIso()
    return base
  }

  async compactWithRuntime({ runtime, conversationId, transcript, previous, signal }) {
    if (typeof runtime?.summarizeMemory !== 'function') return this.compact({ conversationId, transcript, previous })
    const candidate = await runtime.summarizeMemory({ conversationId, transcript, previous, signal })
    const validation = validateMemoryV2(candidate)
    if (!validation.ok) throw Object.assign(new Error(`Memory schema 无效：${validation.errors.join('；')}`), { code: 'MEMORY_SCHEMA_INVALID' })
    const previousIndex = transcript.findIndex((item) => item.messageId === previous?.coveredThroughMessageId)
    const candidateIndex = transcript.findIndex((item) => item.messageId === candidate.coveredThroughMessageId)
    if (previousIndex >= 0 && candidateIndex >= 0 && candidateIndex < previousIndex) throw Object.assign(new Error('Memory coveredThroughMessageId 不能回退'), { code: 'MEMORY_COVERAGE_REGRESSION' })
    return { ...candidate, conversationId, updatedAt: nowIso() }
  }
}

export default MemoryCompactor
