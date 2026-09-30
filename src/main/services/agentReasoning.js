// Only advertise controls implemented by this Chat Completions adapter.
// Codex models use their own runtime model catalogue instead.
export function agentReasoningCapabilities(provider = {}) {
  const model = String(provider.model || '').toLowerCase()
  if (provider.id === 'deepseek') {
    const v4 = /^deepseek-v4-(flash|pro)(?:-|$)/.test(model)
    if (v4 || ['deepseek-chat', 'deepseek-reasoner'].includes(model)) {
      return {
        protocol: 'deepseek',
        supportedReasoningEfforts: v4 ? ['none', 'low', 'high', 'max'] : ['none', 'high'],
        reasoningEffortLabels: v4 ? {} : { none: '关闭思考', high: '开启思考' },
        defaultReasoningEffort: provider.thinkingEnabled === false ? 'none' : 'high'
      }
    }
  }
  if (provider.id === 'gpt') {
    // Do not infer capabilities for arbitrary aliases, chat-only or pro variants.
    const families = [
      [/^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/, ['minimal', 'low', 'medium', 'high']],
      [/^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/, ['none', 'low', 'medium', 'high']],
      [/^gpt-5\.2(?:-\d{4}-\d{2}-\d{2})?$/, ['none', 'low', 'medium', 'high', 'xhigh']],
      [/^(?:o1|o3|o3-mini|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/, ['low', 'medium', 'high']]
    ]
    const match = families.find(([pattern]) => pattern.test(model))
    if (match) return { protocol: 'openai', supportedReasoningEfforts: match[1] }
  }
  return { protocol: null, supportedReasoningEfforts: [] }
}

export function agentReasoningParameters(provider, effort) {
  const capability = agentReasoningCapabilities(provider)
  const selected = !effort || effort === 'codex-default' ? null : String(effort)
  if (selected && !capability.supportedReasoningEfforts.includes(selected)) {
    throw new Error('当前模型不支持所选思考强度，请在对话中重新选择或跟随默认')
  }
  if (capability.protocol === 'deepseek') {
    const enabled = selected ? selected !== 'none' : provider.thinkingEnabled !== false
    return {
      thinking: { type: enabled ? 'enabled' : 'disabled' },
      ...(enabled && selected && /^deepseek-v4-/.test(provider.model)
        ? { reasoning_effort: selected }
        : {})
    }
  }
  return selected ? { reasoning_effort: selected } : {}
}
