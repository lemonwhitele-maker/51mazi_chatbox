import { agentReasoningCapabilities } from '../../services/agentReasoning.js'

export class AgentRouterRuntime {
  constructor({ codexRuntime, agentRuntime, configService } = {}) {
    this.id = 'agent-router'
    this.codexRuntime = codexRuntime
    this.agentRuntime = agentRuntime
    this.configService = configService
    this.active = new Map()
    this.catalogRequest = null
    this.catalogTimeoutMs = 1500
  }

  async getCapabilities({ model } = {}) {
    const selected = this.resolve(model)
    if (typeof selected.runtime?.getCapabilities === 'function')
      return selected.runtime.getCapabilities({ model: selected.model })
    return {
      streaming: true,
      nativeToolCalling: true,
      isolatedTurn: true,
      cancellableTurn: true,
      instructionChannels: true,
      dynamicTools: true,
      usageReporting: true,
      contextWindowTokens: 32768,
      maxOutputTokens: 8192,
      experimental: []
    }
  }

  async getBookSandboxAdmission({ model = null, tools = [] } = {}) {
    const selected = this.resolve(model)
    if (typeof selected.runtime?.getBookSandboxAdmission !== 'function') {
      return {
        admitted: false,
        contractVersion: 1,
        runtimeId: selected.runtime?.id || 'unknown',
        protocolVersion: String(selected.runtime?.protocolVersion || 'unknown'),
        reason: '所选 Runtime 未提供单书准入证据'
      }
    }
    return selected.runtime.getBookSandboxAdmission({ model: selected.model, tools })
  }

  async listBookSandboxRuntimes() {
    const runtimes = [this.agentRuntime, this.codexRuntime]
    return Promise.all(runtimes.map(async (runtime) => {
      const admission = typeof runtime?.getBookSandboxAdmission === 'function'
        ? await runtime.getBookSandboxAdmission()
        : { admitted: false, runtimeId: runtime?.id || 'unknown', reason: '未提供准入证据' }
      return admission
    }))
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

  async listModels({ includeCodexModels = true } = {}) {
    const config = this.configService.getStoredConfig()
    const models = [
      {
        id: 'codex::default',
        displayName: 'Codex 反代（兼容模式 / 默认模型）',
        isDefault: config.defaultRuntime === 'codex-app-server',
        supportedReasoningEfforts: []
      }
    ]
    let codexModelsUnavailable = false
    if (includeCodexModels) {
      let timer
      try {
        if (!this.catalogRequest) {
          this.catalogRequest = Promise.resolve().then(() => this.codexRuntime.listModels())
          this.catalogRequest.then(
            () => {
              this.catalogRequest = null
            },
            () => {
              this.catalogRequest = null
            }
          )
        }
        const result = await Promise.race([
          this.catalogRequest,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Model catalogue timeout')),
              this.catalogTimeoutMs
            )
          })
        ])
        const source = Array.isArray(result)
          ? result
          : result?.models || result?.data?.models || result?.data || []
        for (const item of source) {
          const id = String(item?.model || item?.id || '').trim()
          if (!id) continue
          models.push({
            ...item,
            id: `codex::${id}`,
            displayName: `Codex 反代（兼容模式）/ ${item.displayName || item.display_name || item.name || id}`,
            isDefault: false
          })
          if (item.isDefault ?? item.is_default) {
            models[0].supportedReasoningEfforts =
              item.supportedReasoningEfforts || item.supported_reasoning_efforts || []
            models[0].defaultReasoningEffort =
              item.defaultReasoningEffort || item.default_reasoning_effort
          }
        }
      } catch {
        codexModelsUnavailable = true
        // Codex 反代仍保留为选项；目录暂不可用时使用其默认模型。
      } finally {
        clearTimeout(timer)
      }
    }
    for (const provider of this.configService.listConfiguredProviders()) {
      models.push({
        id: `agent::${provider.id}`,
        displayName: `${provider.name} / ${provider.model}`,
        isDefault: config.defaultRuntime === 'agent-api' && provider.isSelected,
        ...agentReasoningCapabilities(provider)
      })
    }
    return { models, codexModelsUnavailable }
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
