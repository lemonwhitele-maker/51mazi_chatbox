export class HarnessError extends Error {
  constructor(code, message, {
    retryable = false,
    cause = undefined,
    category = undefined,
    retryStrategy = undefined,
    terminal = undefined,
    violations = undefined,
    nextAction = undefined
  } = {}) {
    super(message, { cause })
    this.name = 'HarnessError'
    this.code = code
    this.retryable = retryable
    this.category = category
    this.retryStrategy = retryStrategy
    this.terminal = terminal
    this.violations = violations
    this.nextAction = nextAction
  }
}

export function asHarnessError(error, fallbackCode = 'HARNESS_ERROR') {
  if (error instanceof HarnessError) return error
  return new HarnessError(fallbackCode, String(error?.message || error || 'Harness 执行失败'), {
    retryable: false,
    cause: error
  })
}

export function errorResult(error, fallbackCode = 'TOOL_EXECUTION_FAILED') {
  const normalized = asHarnessError(error, fallbackCode)
  const optional = Object.fromEntries(
    ['category', 'retryStrategy', 'terminal', 'violations', 'nextAction']
      .filter((key) => normalized[key] !== undefined)
      .map((key) => [key, normalized[key]])
  )
  return {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...optional
    }
  }
}
