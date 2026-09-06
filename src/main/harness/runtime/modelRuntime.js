export const REQUIRED_RUNTIME_CAPABILITIES = [
  'streaming',
  'nativeToolCalling',
  'isolatedTurn',
  'cancellableTurn',
  'instructionChannels'
]

export const RUNTIME_TURN_BUDGET_V2 = Object.freeze({
  maxAcceptedToolCalls: 12,
  maxToolRounds: 6,
  maxConcurrentReadTools: 3,
  maxArgumentRepairsPerChain: 2,
  maxSameTransientRetryPerSignature: 1,
  defaultToolTimeoutMs: 30000,
  resultAckTimeoutMs: 5000,
  finalizationPasses: 1
})

export function assertRuntimeCapabilities(runtime) {
  const capabilities = runtime.getCapabilities()
  return Promise.resolve(capabilities).then((value) => {
    const missing = REQUIRED_RUNTIME_CAPABILITIES.filter((key) => value?.[key] !== true)
    if (missing.length) {
      const error = new Error(`Runtime 能力不足：${missing.join(', ')}`)
      error.code = 'RUNTIME_CAPABILITY_MISSING'
      error.missing = missing
      throw error
    }
    return value
  })
}
