import assert from 'node:assert/strict'
import { generateImageBuffer, listConfiguredImageProviders } from '../src/main/services/imageGenerationRouter.js'
import tongyi from '../src/main/services/tongyiwanxiang.js'
import { DeepSeekService } from '../src/main/services/deepseek.js'

const originalFetch = globalThis.fetch
const requests = []
const bytes = Buffer.from('synthetic image for offline verification')
let values = {
  'tongyiwanxiang.apiKey': 'synthetic-only-library-a',
  'gemini.apiKey': 'synthetic-only-gemini',
  'doubao.apiKey': 'synthetic-only-doubao',
  'doubao.model': 'synthetic-image-model',
  'doubao.baseUrl': 'https://offline.invalid/v1'
}
const store = {
  get: (key, fallback) => values[key] ?? fallback,
  bindApiStore() {
    const snapshot = { ...values }
    return { get: (key, fallback) => snapshot[key] ?? fallback }
  }
}

try {
  globalThis.fetch = async (url, options) => {
    if (!options) return { ok: true, arrayBuffer: async () => bytes }
    const body = JSON.parse(options.body)
    requests.push({ url, headers: options.headers, body })
    if (String(url).includes(':predict')) {
      return { ok: true, json: async () => ({ predictions: [{ bytesBase64Encoded: bytes.toString('base64') }] }) }
    }
    if (String(url).endsWith('/images/generations')) {
      return { ok: true, json: async () => ({ data: [{ b64_json: bytes.toString('base64') }] }) }
    }
    return { ok: true, json: async () => ({ output: { choices: [{ message: { content: [{ image: 'https://offline.invalid/image.png' }] } }] } }) }
  }

  assert.deepEqual(listConfiguredImageProviders(store), ['tongyi', 'gemini', 'doubao'])
  tongyi.setApiKey('synthetic-stale-singleton')
  const first = generateImageBuffer(store, { imageProvider: 'tongyi', prompt: '合成测试人物', size: '720*1280' })
  values['tongyiwanxiang.apiKey'] = 'synthetic-only-library-b'
  const second = generateImageBuffer(store, { imageProvider: 'tongyi', prompt: '合成测试人物', size: '720*1280' })
  assert.deepEqual(await first, bytes)
  assert.deepEqual(await second, bytes)
  assert.equal(requests[0].headers.Authorization, 'Bearer synthetic-only-library-a')
  assert.equal(requests[1].headers.Authorization, 'Bearer synthetic-only-library-b')
  assert.equal(requests[0].body.parameters.size, '720*1280')
  values['tongyiwanxiang.apiKey'] = ''
  await assert.rejects(generateImageBuffer(store, { imageProvider: 'tongyi', prompt: '合成测试', size: '720*1280' }), /Key 未设置/)
  assert.equal(requests.length, 2, 'Cleared library keys must not fall back to cached credentials')

  assert.deepEqual(await generateImageBuffer(store, { imageProvider: 'gemini', prompt: '合成测试', size: '720*1280' }), bytes)
  assert.equal(requests[2].headers['x-goog-api-key'], 'synthetic-only-gemini')
  assert.equal(requests[2].body.parameters.aspectRatio, '9:16')
  assert.deepEqual(await generateImageBuffer(store, { imageProvider: 'doubao', prompt: '合成测试', size: '720*1280' }), bytes)
  assert.equal(requests[3].headers.Authorization, 'Bearer synthetic-only-doubao')
  assert.equal(requests[3].body.size, '720x1280')

  let legacyKey = 'synthetic-current-deepseek'
  const deepseek = new DeepSeekService()
  deepseek.setApiKey('synthetic-stale-deepseek')
  deepseek.setApiKeyProvider(() => legacyKey)
  assert.equal(await deepseek.getApiKey(), legacyKey)
  legacyKey = ''
  assert.equal(await deepseek.getApiKey(), null)
  await assert.rejects(deepseek.chat({ messages: [] }), /尚未配置/)
  console.log('Image API configuration checks passed: provider routing, portrait size, and per-request credentials.')
} finally {
  globalThis.fetch = originalFetch
  tongyi.setApiKey(null)
}
