import assert from 'node:assert/strict'
import { CLOUD_AI_PROVIDERS } from '../src/shared/cloudAiProviders.js'
import AgentModelConfigService from '../src/main/services/agentModelConfigService.js'
import {
  requestAgentCompletion,
  chatCompletionsEndpoint
} from '../src/main/services/agentCompletionClient.js'
import FunctionApiService from '../src/main/services/functionApiService.js'

const values = new Map()
const store = {
  get: (key, fallback) => structuredClone(values.get(key) ?? fallback),
  set: (key, value) => values.set(key, structuredClone(value))
}
const models = new AgentModelConfigService({ store })
const accountId = 'a'.repeat(32)
const tools = [
  { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }
]
for (const defaults of CLOUD_AI_PROVIDERS) {
  const baseUrl = defaults.baseUrl.replace('{account_id}', accountId)
  models.saveProvider(defaults.id, {
    baseUrl,
    apiKey: `${defaults.id}-test-key`,
    defaultRuntime: 'agent-api'
  })
  const provider = new AgentModelConfigService({ store }).getProvider(defaults.id)
  assert.equal(provider.id, defaults.id)
  assert.equal(provider.model, defaults.model)
  const endpoint = `${baseUrl}/chat/completions`
  assert.equal(chatCompletionsEndpoint({ ...provider, baseUrl: `${endpoint}/` }), endpoint)
  let calls = 0
  const fetchImpl = async (url, options) => {
    calls++
    assert.equal(url, endpoint)
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, `Bearer ${defaults.id}-test-key`)
    const body = JSON.parse(options.body)
    assert.equal(body.model, defaults.model)
    assert.equal(body.stream, false)
    assert.equal(body.max_tokens, 64)
    if (body.tools) {
      assert.deepEqual(body.tools, tools)
      assert.equal(body.tool_choice, 'required')
    } else {
      assert.equal(Object.hasOwn(body, 'tools'), false)
      assert.equal(Object.hasOwn(body, 'tool_choice'), false)
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }]
      })
    }
  }
  const messages = [{ role: 'user', content: 'hello' }]
  await requestAgentCompletion({
    provider,
    messages,
    tools,
    toolChoice: 'required',
    maxTokens: 64,
    fetchImpl
  })
  await requestAgentCompletion({ provider, messages, maxTokens: 64, fetchImpl })
  const functions = new FunctionApiService({ store, fetchImpl })
  functions.setConfig({
    provider: defaults.id,
    baseUrl,
    model: defaults.model,
    apiKey: provider.apiKey
  })
  const config = new FunctionApiService({ store }).getConfig()
  assert.equal(config.provider, defaults.id)
  assert.equal(await functions.request(config, messages), 'OK')
  assert.equal(await functions.request({ ...config, baseUrl: endpoint }, messages), 'OK')
  assert.equal(calls, 4)
}
assert.equal(
  models.listConfiguredProviders().filter((item) => ['cloudflare', 'mistral'].includes(item.id))
    .length,
  2
)
const cloudflare = CLOUD_AI_PROVIDERS.find((item) => item.id === 'cloudflare')
assert.throws(
  () => models.prepareProvider('cloudflare', { ...cloudflare, apiKey: 'test' }),
  /Account ID/
)
assert.throws(
  () =>
    chatCompletionsEndpoint({
      ...cloudflare,
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/invalid/ai/v1'
    }),
  /Account ID/
)
const functions = new FunctionApiService({
  store,
  fetchImpl: () => assert.fail('Invalid URL must not send a request')
})
const invalid = await functions.validateConfig({
  provider: 'cloudflare',
  baseUrl: cloudflare.baseUrl,
  model: cloudflare.model,
  apiKey: 'test'
})
assert.equal(invalid.isValid, false)
assert.match(invalid.message, /Account ID/)
const switched = functions.setConfig({ provider: 'mistral' })
assert.equal(switched.baseUrl, 'https://api.mistral.ai/v1')
assert.equal(switched.model, 'mistral-small-latest')
assert.equal(switched.apiKey, '')
console.log('Cloud AI provider configuration and request tests passed')
