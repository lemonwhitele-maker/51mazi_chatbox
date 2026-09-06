import { baseInstructions } from '../prompts/baseInstructions.js'
import { developerInstructions } from '../prompts/developerInstructions.js'

const DEFAULT_POLICY = Object.freeze({
  contextWindowTokens: 32000,
  maxOutputTokens: 4096,
  maxInputTokens: 24000,
  instructionTokens: 1200,
  memoryTokens: 4500,
  recentConversationTokens: 6000,
  workspaceTokens: 2500,
  selectionMaxChars: 8000,
  recentTurns: 8,
  minRecentTurns: 3,
  maxUserChars: 16000,
  safetyRatio: 1.15
})

function estimate(text) {
  return Math.ceil((String(text || '').length / 4) * 1.2)
}

function trimHeadTail(value, maxChars, marker = '……内容已按预算截断……') {
  const text = String(value || '')
  if (text.length <= maxChars) return { text, truncated: false }
  const available = Math.max(0, maxChars - marker.length - 2)
  const head = Math.ceil(available * 0.65)
  const tail = Math.max(0, available - head)
  return { text: `${text.slice(0, head)}\n${marker}\n${text.slice(-tail)}`, truncated: true }
}

function boundedSelection(value, max) {
  return trimHeadTail(value, max, '……选区已截断……')
}

function compactMemory(memory = {}, maxTokens) {
  const source = memory && typeof memory === 'object' ? memory : {}
  const result = {
    schemaVersion: source.schemaVersion || 2,
    summaryVersion: Number(source.summaryVersion || 0),
    objective: String(source.objective || ''),
    userPreferences: Array.isArray(source.userPreferences) ? source.userPreferences.slice(-12) : [],
    confirmedDecisions: Array.isArray(source.confirmedDecisions) ? source.confirmedDecisions.slice(-16) : [],
    modelSuggestions: Array.isArray(source.modelSuggestions) ? source.modelSuggestions.slice(-12) : [],
    workingFacts: Array.isArray(source.workingFacts) ? source.workingFacts.slice(-16) : [],
    unresolvedQuestions: Array.isArray(source.unresolvedQuestions) ? source.unresolvedQuestions.slice(-12) : [],
    currentWork: Array.isArray(source.currentWork) ? source.currentWork.slice(-12) : [],
    sourceReferences: Array.isArray(source.sourceReferences) ? source.sourceReferences.slice(-24) : [],
    coveredThroughMessageId: source.coveredThroughMessageId || null
  }
  let text = JSON.stringify(result, null, 2)
  if (estimate(text) <= maxTokens) return { value: result, text, truncated: false }
  for (const key of ['currentWork', 'workingFacts', 'modelSuggestions', 'unresolvedQuestions', 'userPreferences', 'sourceReferences']) {
    while (result[key].length > 0 && estimate(JSON.stringify(result)) > maxTokens) result[key].shift()
  }
  text = JSON.stringify(result, null, 2)
  return { value: result, text, truncated: estimate(text) > maxTokens }
}

function messageText(item) {
  return String(item?.payload?.text || '').trim()
}

function recentConversation(transcript, policy) {
  const messages = transcript.filter((item) => item.type === 'message.user' || item.type === 'message.assistant')
  const turnIds = [...new Set(messages.map((item) => item.turnId).filter(Boolean))]
  let selected = turnIds.slice(-policy.recentTurns)
  let text = '（暂无近期对话）'
  while (selected.length >= policy.minRecentTurns) {
    const keep = new Set(selected)
    text = messages.filter((item) => keep.has(item.turnId)).map((item) => `${item.type === 'message.user' ? '用户' : '助手'}：${messageText(item)}`).join('\n\n') || text
    if (estimate(text) <= policy.recentConversationTokens) return { text, truncated: false }
    selected = selected.slice(1)
  }
  const fallback = trimHeadTail(text, policy.recentConversationTokens * 4, '……近期对话已按预算截断……')
  return { text: fallback.text, truncated: fallback.truncated }
}

export class ContextAssembler {
  constructor(options = {}) { this.policy = { ...DEFAULT_POLICY, ...options } }

  getPolicy(runtimeCapabilities = {}) {
    const contextWindowTokens = Number(runtimeCapabilities.contextWindowTokens) || this.policy.contextWindowTokens
    const maxOutputTokens = Number(runtimeCapabilities.maxOutputTokens) || this.policy.maxOutputTokens
    const available = Math.max(1, contextWindowTokens - maxOutputTokens)
    return { ...this.policy, contextWindowTokens, maxOutputTokens, maxInputTokens: Math.min(this.policy.maxInputTokens, available) }
  }

  assemble({ transcript = [], memory, workspace = {}, userText, runtimeCapabilities = {} }) {
    const policy = this.getPolicy(runtimeCapabilities)
    const userRequest = String(userText || '').trim()
    if (userRequest.length > policy.maxUserChars) {
      const error = new Error('用户请求超出当前 Runtime 的输入上限')
      error.code = 'USER_INPUT_TOO_LARGE'
      throw error
    }
    const selection = boundedSelection(workspace.selectionText, policy.selectionMaxChars)
    const current = [
      `module=${workspace.currentModule || '未提供'}`,
      `documentId=${workspace.currentDocumentId || '未提供'}`,
      `entityId=${workspace.currentEntityId || '未提供'}`,
      `savedHash=${workspace.currentDocumentSavedHash || '未提供'}`,
      `hasUnsavedChanges=${workspace.hasUnsavedChanges === true}`,
      selection.text ? `<selection truncated="${selection.truncated}">${selection.text}</selection>` : '<selection empty="true" />',
      Object.keys(workspace.metadata || {}).length ? `<metadata>${JSON.stringify(workspace.metadata)}</metadata>` : '<metadata empty="true" />'
    ].join('\n')
    const memoryLayer = compactMemory(memory, policy.memoryTokens)
    const recentLayer = recentConversation(transcript, policy)
    const contextLayers = [
      `<conversation_memory>\n${memoryLayer.text}\n</conversation_memory>`,
      `<recent_conversation truncated="${recentLayer.truncated}">\n${recentLayer.text}\n</recent_conversation>`,
      `<current_workspace>\n${current}\n</current_workspace>`
    ]
    let contextText = contextLayers.join('\n\n')
    const userLayer = `<user_request>\n${userRequest}\n</user_request>`
    const fixedTokens = estimate(baseInstructions.text) + estimate(developerInstructions.text) + estimate(userLayer)
    if (fixedTokens > policy.maxInputTokens) {
      const error = new Error('当前指令与用户请求超过 Runtime 输入上限')
      error.code = 'USER_INPUT_TOO_LARGE'
      throw error
    }
    const contextBudget = Math.max(0, policy.maxInputTokens - fixedTokens)
    if (estimate(contextText) > contextBudget) {
      const currentText = trimHeadTail(current, Math.max(400, Math.floor(contextBudget * 4 * 0.35)), '……workspace 已按预算截断……')
      const recentText = trimHeadTail(recentLayer.text, Math.max(400, Math.floor(contextBudget * 4 * 0.3)), '……近期对话已按预算截断……')
      const memoryText = trimHeadTail(memoryLayer.text, Math.max(400, Math.floor(contextBudget * 4 * 0.35)), '……memory 已按预算裁剪……')
      contextText = [
        `<conversation_memory truncated="${memoryText.truncated}">\n${memoryText.text}\n</conversation_memory>`,
        `<recent_conversation truncated="${recentLayer.truncated || recentText.truncated}">\n${recentText.text}\n</recent_conversation>`,
        `<current_workspace truncated="${currentText.truncated}">\n${currentText.text}\n</current_workspace>`
      ].join('\n\n')
    }
    const inputText = `${contextText}\n\n${userLayer}`
    const estimatedInputTokens = estimate(inputText) + estimate(baseInstructions.text) + estimate(developerInstructions.text)
    if (estimatedInputTokens > policy.maxInputTokens) {
      const error = new Error('组装后的输入仍超过 Runtime 预算')
      error.code = 'CONTEXT_BUDGET_EXCEEDED'
      throw error
    }
    return {
      inputText,
      contextText,
      userText: userRequest,
      instructions: { base: baseInstructions, developer: developerInstructions },
      estimatedInputTokens,
      budget: policy,
      layers: { memory: memoryLayer.value, recentConversation: recentLayer.text, currentWorkspace: current, userRequest, selectionTruncated: selection.truncated }
    }
  }
}

export { DEFAULT_POLICY, estimate, trimHeadTail }
export default ContextAssembler
