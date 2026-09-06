export class AgentRouterRuntime {
  constructor({ codexRuntime, agentRuntime, configService } = {}) {
    this.id = 'agent-router'
    this.codexRuntime = codexRuntime
    this.agentRuntime = agentRuntime
    this.configService = configService
    this.active = new Map()
  }

  async getCapabilities() {
    return {
      streaming: true,
      nativeToolCalling: true,
      isolatedTurn: true,
      cancellableTurn: true,
      instructionChannels: true,
      dynamicTools: true,
      usageReporting: true,
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      experimental: []
    }
  }

  resolve(model) {
    const preference = String(model || '').trim()
    if (preference.startsWith('agent::')) {
      return { runtime: this.agentRuntime, model: preference }
    }
    if (preference.startsWith('codex::')) {
      const codexModel = preference.slice('codex::'.length)
      return { runtime: this.codexRuntime, model: codexModel === 'default' ? null : codexModel }
    }
    if (preference && preference !== 'agent-default' && preference !== 'codex-default') {
      return { runtime: this.codexRuntime, model: preference }
    }
    const config = this.configService.getStoredConfig()
    if (config.defaultRuntime === 'agent-api') {
      return { runtime: this.agentRuntime, model: `agent::${config.selectedProvider}` }
    }
    return { runtime: this.codexRuntime, model: null }
  }

  async listModels() {
    const config = this.configService.getStoredConfig()
    const models = [
      {
        id: 'codex::default',
        displayName: 'Codex 反代（默认模型）',
        isDefault: config.defaultRuntime === 'codex-app-server',
        supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh']
      }
    ]
    if (config.defaultRuntime === 'codex-app-server') {
      try {
        const result = await this.codexRuntime.listModels()
        const source = Array.isArray(result)
          ? result
          : result?.models || result?.data?.models || result?.data || []
        for (const item of source) {
          const id = String(item?.id || item?.model || '').trim()
          if (!id) continue
          models.push({
            ...item,
            id: `codex::${id}`,
            displayName: `Codex 反代 / ${item.displayName || item.display_name || item.name || id}`,
            isDefault: false
          })
        }
      } catch {
        // Codex 反代仍保留为选项；目录暂不可用时使用其默认模型。
      }
    }
    for (const provider of this.configService.listConfiguredProviders()) {
      models.push({
        id: `agent::${provider.id}`,
        displayName: `${provider.name} / ${provider.model}`,
        isDefault: config.defaultRuntime === 'agent-api' && provider.isSelected,
        supportedReasoningEfforts: []
      })
    }
    return { models }
  }

  async *streamTurn(input) {
    const selected = this.resolve(input.model)
    this.active.set(input.turnId, selected.runtime)
    try {
      yield* selected.runtime.streamTurn({ ...input, model: selected.model })
    } finally {
      this.active.delete(input.turnId)
    }
  }

  async submitToolResult(input) {
    const runtime = this.active.get(input.turnId)
    if (!runtime) return { status: 'turn_missing' }
    return runtime.submitToolResult(input)
  }

  async cancelTurn(input) {
    await this.active.get(input.turnId)?.cancelTurn(input)
  }

  async disposeTurn(input) {
    await this.active.get(input.turnId)?.disposeTurn(input)
    this.active.delete(input.turnId)
  }

  async dispose() {
    this.active.clear()
  }
}

export default AgentRouterRuntime
