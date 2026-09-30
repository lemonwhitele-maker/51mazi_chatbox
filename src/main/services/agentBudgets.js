// Capacities, per-response output, tool results and execution limits have
// different units and owners. Do not derive one policy from another.
export const DEFAULT_MODEL_LIMITS = Object.freeze({
  contextWindowTokens: 32768,
  maxOutputTokens: 8192
})
export const DEFAULT_GENERATION_BUDGET = Object.freeze({ maxOutputTokens: 8192 })
export const DEFAULT_TOOL_READ_BUDGET = Object.freeze({
  defaultPageChars: 8000,
  maxPageChars: 12000,
  maxResultChars: 20000,
  batchResultChars: 16000,
  maxWholeDocumentChars: 24000
})
export const DEFAULT_EXECUTION_BUDGET = Object.freeze({
  maxToolCalls: 24,
  maxToolRounds: 24,
  maxReadToolCalls: 18,
  maxReadToolRounds: 18,
  toolTimeoutMs: 30000,
  turnTimeoutMs: 180000,
  maxTurnTimeoutMs: 300000,
  toolConcurrency: 3,
  resultAckTimeoutMs: 5000
})

function integer(value, fallback, name, minimum = 1, maximum = 10000000) {
  const selected = value === undefined ? fallback : value
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum)
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`)
  return selected
}

export function resolveModelBudgets(provider = {}, requestedOutputTokens) {
  const contextWindowTokens = integer(
    provider.modelLimits?.contextWindowTokens,
    DEFAULT_MODEL_LIMITS.contextWindowTokens,
    '上下文容量',
    1024
  )
  const maxOutputTokens = integer(
    provider.modelLimits?.maxOutputTokens,
    Math.min(DEFAULT_MODEL_LIMITS.maxOutputTokens, contextWindowTokens - 1),
    '模型最大输出量'
  )
  if (maxOutputTokens >= contextWindowTokens) throw new Error('模型最大输出量必须小于上下文容量')
  const requested = integer(
    requestedOutputTokens ?? provider.generationBudget?.maxOutputTokens,
    DEFAULT_GENERATION_BUDGET.maxOutputTokens,
    '单次生成预算'
  )
  return {
    modelLimits: { contextWindowTokens, maxOutputTokens },
    generationBudget: {
      maxOutputTokens: Math.min(requested, maxOutputTokens),
      // Retrying with a larger budget is opt-in and never invents model capacity.
      truncationRetryMaxOutputTokens: Math.min(
        integer(
          provider.generationBudget?.truncationRetryMaxOutputTokens,
          requested,
          '截断重试生成预算'
        ),
        maxOutputTokens
      )
    }
  }
}

export function resolveToolReadBudget(value = {}) {
  const result = Object.fromEntries(
    Object.entries(DEFAULT_TOOL_READ_BUDGET).map(([key, fallback]) => [
      key,
      integer(
        value[key],
        fallback,
        `工具读取预算 ${key}`,
        key.includes('Result') ? 4000 : 512,
        120000
      )
    ])
  )
  if (result.defaultPageChars > result.maxPageChars)
    throw new Error('默认读取页大小不能超过最大页大小')
  if (result.maxPageChars + 2500 > result.maxResultChars)
    throw new Error('工具结果预算必须为分页正文留出元数据空间')
  if (result.batchResultChars > result.maxResultChars)
    throw new Error('批量读取预算不能超过工具结果预算')
  return Object.freeze(result)
}

export function resolveExecutionBudget(value = {}) {
  const defaults = { ...DEFAULT_EXECUTION_BUDGET }
  // Preserve explicitly configured smaller hard limits without requiring a migration.
  defaults.maxReadToolCalls = Math.min(
    defaults.maxReadToolCalls,
    value.maxToolCalls ?? defaults.maxToolCalls
  )
  defaults.maxReadToolRounds = Math.min(
    defaults.maxReadToolRounds,
    value.maxToolRounds ?? defaults.maxToolRounds
  )
  const result = Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      integer(value[key], fallback, `执行预算 ${key}`, 1, key.endsWith('Ms') ? 86400000 : 10000)
    ])
  )
  if (result.toolConcurrency > 3) throw new Error('当前工具并发上限为 3')
  if (
    result.maxReadToolCalls > result.maxToolCalls ||
    result.maxReadToolRounds > result.maxToolRounds
  )
    throw new Error('阅读预算不能超过工具执行硬上限')
  if (result.turnTimeoutMs > result.maxTurnTimeoutMs)
    throw new Error('任务时限不能超过最长任务时限')
  return Object.freeze(result)
}
