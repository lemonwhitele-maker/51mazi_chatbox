const STORE_KEY = 'agentApi.modelConfig.v1'

export const AGENT_PROVIDER_CATALOG = Object.freeze([
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    apiKeyOptional: true
  },
  {
    id: 'local_openai',
    name: '本地 OpenAI 兼容服务',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: '',
    apiKeyOptional: true
  },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { id: 'gpt', name: 'OpenAI（GPT）', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  {
    id: 'gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash'
  },
  {
    id: 'anthropic',
    name: 'Anthropic（Claude）',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5'
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus'
  },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', model: '' },
  { id: 'grok', name: 'Grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-4' },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-pro'
  },
  {
    id: 'qwen',
    name: '通义千问（云端）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-max'
  }
])

const CATALOG_BY_ID = new Map(AGENT_PROVIDER_CATALOG.map((provider) => [provider.id, provider]))

function cleanString(value, maxLength = 1000) {
  return String(value || '')
    .trim()
    .slice(0, maxLength)
}

function normalizeProviderId(value) {
  const id = cleanString(value, 100)
  return CATALOG_BY_ID.has(id) ? id : 'deepseek'
}

function normalizeProviderConfig(providerId, value = {}, previous = {}) {
  const defaults = CATALOG_BY_ID.get(providerId) || {}
  const apiKeyProvided = Object.prototype.hasOwnProperty.call(value, 'apiKey')
  return {
    baseUrl: cleanString(value.baseUrl ?? previous.baseUrl ?? defaults.baseUrl, 1000),
    model: cleanString(value.model ?? previous.model ?? defaults.model, 300),
    apiKey: apiKeyProvided ? cleanString(value.apiKey, 4096) : cleanString(previous.apiKey, 4096),
    proxyPort: cleanString(value.proxyPort ?? previous.proxyPort, 5),
    thinkingEnabled: value.thinkingEnabled !== false
  }
}

function normalizeConfig(value = {}, previous = {}) {
  const providerEntries =
    value.providers && typeof value.providers === 'object'
      ? value.providers
      : previous.providers || {}
  const providers = {}
  for (const provider of AGENT_PROVIDER_CATALOG) {
    const incoming = providerEntries[provider.id]
    const existing = previous.providers?.[provider.id] || {}
    if (incoming || Object.keys(existing).length) {
      providers[provider.id] = normalizeProviderConfig(provider.id, incoming || {}, existing)
    }
  }
  const selectedProvider = normalizeProviderId(value.selectedProvider ?? previous.selectedProvider)
  return {
    defaultRuntime: value.defaultRuntime === 'agent-api' ? 'agent-api' : 'codex-app-server',
    selectedProvider,
    providers
  }
}

function publicConfig(config) {
  return {
    ...config,
    providers: Object.fromEntries(
      Object.entries(config.providers || {}).map(([id, provider]) => [
        id,
        { ...provider, apiKeyConfigured: Boolean(provider.apiKey) }
      ])
    ),
    catalog: AGENT_PROVIDER_CATALOG.map((provider) => ({ ...provider }))
  }
}

export class AgentModelConfigService {
  constructor({ store } = {}) {
    this.store = store
  }

  getStoredConfig() {
    const stored = this.store?.get(STORE_KEY, {}) || {}
    const config = normalizeConfig(stored)
    if (!Object.keys(config.providers).length) {
      const legacyKey = cleanString(this.store?.get('deepseek.apiKey', ''), 4096)
      if (legacyKey) {
        config.providers.deepseek = normalizeProviderConfig('deepseek', { apiKey: legacyKey })
      }
    }
    return config
  }

  getConfig() {
    return publicConfig(this.getStoredConfig())
  }

  setConfig(value = {}) {
    const previous = this.getStoredConfig()
    const next = normalizeConfig(value, previous)
    this.store?.set(STORE_KEY, next)
    return publicConfig(next)
  }

  saveProvider(providerId, value = {}) {
    const id = normalizeProviderId(providerId)
    const previous = this.getStoredConfig()
    const provider = normalizeProviderConfig(id, value, previous.providers[id] || {})
    if (value.defaultRuntime === 'agent-api') {
      if (!provider.baseUrl || !provider.model) {
        throw new Error('请先填写完整的 Agent API 地址和模型名称')
      }
      if (!provider.apiKey && !CATALOG_BY_ID.get(id)?.apiKeyOptional) {
        throw new Error(`请先填写 ${CATALOG_BY_ID.get(id)?.name || id} 的 API Key`)
      }
    }
    const next = {
      ...previous,
      defaultRuntime:
        value.defaultRuntime === 'agent-api'
          ? 'agent-api'
          : value.defaultRuntime === 'codex-app-server'
            ? 'codex-app-server'
            : previous.defaultRuntime,
      selectedProvider: id,
      providers: { ...previous.providers, [id]: provider }
    }
    this.store?.set(STORE_KEY, next)
    return this.getConfig()
  }

  getProvider(providerId) {
    const config = this.getStoredConfig()
    const id = normalizeProviderId(providerId || config.selectedProvider)
    const provider = config.providers[id]
    if (!provider?.model)
      throw new Error(`请先配置 ${CATALOG_BY_ID.get(id)?.name || id} 的模型名称`)
    if (!provider.apiKey && !CATALOG_BY_ID.get(id)?.apiKeyOptional) {
      throw new Error(`请先配置 ${CATALOG_BY_ID.get(id)?.name || id} 的 API Key`)
    }
    return { id, ...provider, displayName: CATALOG_BY_ID.get(id)?.name || id }
  }

  listConfiguredProviders() {
    const config = this.getStoredConfig()
    return Object.entries(config.providers)
      .filter(
        ([id, provider]) =>
          provider?.baseUrl &&
          provider?.model &&
          (provider.apiKey || CATALOG_BY_ID.get(id)?.apiKeyOptional)
      )
      .map(([id, provider]) => ({
        id,
        name: CATALOG_BY_ID.get(id)?.name || id,
        model: provider.model,
        isSelected: id === config.selectedProvider
      }))
  }
}

export default AgentModelConfigService
