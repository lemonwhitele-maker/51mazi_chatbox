export const CLOUD_AI_PROVIDERS = Object.freeze([
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest'
  }
])

export function validateCloudAiBaseUrl(providerId, baseUrl) {
  if (providerId !== 'cloudflare') return
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('Cloudflare Workers AI Base URL 格式无效')
  }
  if (/[{}<>]/.test(decodeURIComponent(url.pathname))) {
    throw new Error('请将 Cloudflare Base URL 中的 {account_id} 替换为实际 Account ID')
  }
  if (
    url.hostname === 'api.cloudflare.com' &&
    !/^\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1(?:\/chat\/completions)?\/?$/i.test(url.pathname)
  ) {
    throw new Error(
      'Cloudflare Base URL 应为 https://api.cloudflare.com/client/v4/accounts/你的32位Account ID/ai/v1'
    )
  }
}
