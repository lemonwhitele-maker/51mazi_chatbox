import { DEFAULT_EXECUTION_BUDGET } from '../../services/agentBudgets.js'

export const REQUIRED_RUNTIME_CAPABILITIES = [
  'streaming',
  'nativeToolCalling',
  'isolatedTurn',
  'cancellableTurn',
  'instructionChannels'
]

export const BOOK_SANDBOX_RUNTIME_CONTRACT_VERSION = 1
export const BOOK_SANDBOX_TOOL_NAMES = Object.freeze(['read', 'create', 'write', 'edit', 'list_files'])

export const RUNTIME_TURN_BUDGET_V2 = Object.freeze({
  maxAcceptedToolCalls: DEFAULT_EXECUTION_BUDGET.maxToolCalls,
  maxToolRounds: DEFAULT_EXECUTION_BUDGET.maxToolRounds,
  maxReadToolCalls: DEFAULT_EXECUTION_BUDGET.maxReadToolCalls,
  maxReadToolRounds: DEFAULT_EXECUTION_BUDGET.maxReadToolRounds,
  maxConcurrentReadTools: DEFAULT_EXECUTION_BUDGET.toolConcurrency,
  maxArgumentRepairsPerChain: 2,
  maxSameTransientRetryPerSignature: 1,
  defaultToolTimeoutMs: DEFAULT_EXECUTION_BUDGET.toolTimeoutMs,
  resultAckTimeoutMs: DEFAULT_EXECUTION_BUDGET.resultAckTimeoutMs,
  finalizationPasses: 1
})

export function assertRuntimeCapabilities(runtime, options = {}) {
  const capabilities = runtime.getCapabilities(options)
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

function normalizedToolNames(tools) {
  return [...new Set((tools || []).map((tool) => String(tool?.name || tool).trim()).filter(Boolean))]
    .sort()
}

function unsupported(message, admission = null) {
  const error = new Error(message)
  error.code = 'RUNTIME_BOOK_SANDBOX_UNSUPPORTED'
  error.retryable = false
  error.admission = admission
  return error
}

export async function assertBookSandboxRuntime(runtime, { model = null, tools = [], allowedReadTools = null } = {}) {
  await assertRuntimeCapabilities(runtime)
  const actualTools = normalizedToolNames(tools)
  const requiredTools = Array.isArray(allowedReadTools)
    ? [...allowedReadTools].sort()
    : [...BOOK_SANDBOX_TOOL_NAMES].sort()
  if (
    actualTools.length !== requiredTools.length ||
    actualTools.some((name, index) => name !== requiredTools[index])
  ) {
    throw unsupported('当前工具集合不符合已固定的单书模式')
  }
  if (typeof runtime?.getBookSandboxAdmission !== 'function') {
    throw unsupported(`Runtime ${runtime?.id || 'unknown'} 未提供可验证的单书准入证据`)
  }
  const admission = await runtime.getBookSandboxAdmission({ model, tools: actualTools })
  const compatibleCodex =
    admission?.mode === 'codex-readonly-compatibility' &&
    admission?.runtimeId === 'codex-app-server' &&
    admission?.sandbox === 'read-only' &&
    admission?.networkAccess === false &&
    admission?.localFilesystemAccess === 'read-only-sandbox-is-not-book-scoped'
  const strictIsolation =
    admission?.modelExecutableTools === 'registered-functions-only' &&
    admission?.nativeTools === 'not-present-in-model-protocol' &&
    admission?.localFilesystemAccess === 'none'
  const evidenceValid =
    admission?.admitted === true &&
    admission?.contractVersion === BOOK_SANDBOX_RUNTIME_CONTRACT_VERSION &&
    typeof admission?.runtimeId === 'string' &&
    typeof admission?.protocolVersion === 'string' &&
    admission.protocolVersion.length > 0 &&
    (strictIsolation || compatibleCodex)
  if (!evidenceValid) {
    throw unsupported(
      admission?.reason || `Runtime ${runtime?.id || 'unknown'} 不满足四工具单书隔离条件`,
      admission || null
    )
  }
  return admission
}
