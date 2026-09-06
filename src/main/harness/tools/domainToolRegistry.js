import Ajv from 'ajv'
import { errorResult, HarnessError } from '../harnessErrors.js'
import { contractHash, toolsetHash } from './contracts/canonicalHash.js'
import { toolResultSchema } from './contracts/toolResultSchemas.js'

function violations(errors = []) {
  return errors.map((error) => ({
    path: error.instancePath || '/',
    keyword: error.keyword || 'invalid',
    message: error.message || '参数无效',
    params: error.params || {}
  }))
}

function describeViolations(items) {
  return items.slice(0, 12).map((item) => `${item.path} ${item.message}`.trim()).join('；')
}

export class DomainToolRegistry {
  constructor() {
    this.tools = new Map()
    this.ajv = new Ajv({
      strict: true,
      allErrors: true,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
      allowUnionTypes: true,
      allowMatchingProperties: true
    })
  }

  register(definition) {
    if (!definition?.name || this.tools.has(definition.name)) throw new HarnessError('TOOL_REGISTRATION_INVALID', `工具重复或缺少名称：${definition?.name || ''}`)
    if (definition.version !== '2' || !['read', 'proposal'].includes(definition.risk)) throw new HarnessError('TOOL_REGISTRATION_INVALID', `Tool Contract v2 只允许 v2 read/proposal 工具：${definition.name}`)
    if (!definition.inputSchema || typeof definition.inputSchema !== 'object' || Array.isArray(definition.inputSchema)) throw new HarnessError('TOOL_REGISTRATION_INVALID', `工具必须提供 input schema：${definition.name}`)
    if (definition.inputSchema.type !== 'object') throw new HarnessError(
      'TOOL_REGISTRATION_INVALID',
      `工具 input schema 顶层必须显式声明 type: "object"：${definition.name}`
    )
    try {
      const outputSchema = definition.outputSchema || toolResultSchema
      const registered = {
        sideEffect: definition.risk === 'proposal' ? 'proposal_store' : 'none',
        semanticPolicy: { id: `${definition.name}.semantic`, version: '1' },
        errorPolicy: { id: `${definition.name}.errors`, version: '1' },
        resultBudget: { maxChars: 20000 },
        ...definition,
        outputSchema
      }
      registered.validateInput = this.ajv.compile(registered.inputSchema)
      registered.validateOutput = this.ajv.compile(outputSchema)
      registered.contractHash = contractHash(registered)
      this.tools.set(definition.name, Object.freeze(registered))
    } catch (error) {
      throw new HarnessError('TOOL_REGISTRATION_INVALID', `工具 Schema 编译失败：${definition.name}：${error.message}`, { cause: error })
    }
  }

  listDefinitions() {
    return [...this.tools.values()].map((tool) =>
      Object.fromEntries(
        Object.entries(tool).filter(
          ([key]) => !['execute', 'normalizeArguments', 'semanticValidate', 'validateInput', 'validateOutput'].includes(key)
        )
      )
    )
  }

  get(name) { return this.tools.get(String(name || '')) || null }

  getToolsetHash() { return toolsetHash([...this.tools.values()]) }

  async execute(name, context, args, signal) {
    const tool = this.get(name)
    if (!tool) return errorResult(new HarnessError('TOOL_NOT_ALLOWED', `不允许调用工具：${name}`), 'TOOL_NOT_ALLOWED')
    let normalizedArgs = args
    try {
      if (typeof tool.normalizeArguments === 'function') {
        const normalized = tool.normalizeArguments(args)
        normalizedArgs = normalized?.value === undefined ? normalized : normalized.value
      }
    } catch (error) {
      return this.withMeta(tool, errorResult(error, 'TOOL_ARGUMENT_INVALID'))
    }
    if (!tool.validateInput(normalizedArgs)) {
      const items = violations(tool.validateInput.errors)
      return this.withMeta(tool, errorResult(new HarnessError(
        'TOOL_ARGUMENT_INVALID',
        describeViolations(items),
        { category: 'validation', retryStrategy: 'repair_arguments', terminal: false, violations: items }
      ), 'TOOL_ARGUMENT_INVALID'))
    }
    if (signal?.aborted) return this.withMeta(tool, errorResult(new HarnessError('TOOL_CANCELLED', '工具调用已取消'), 'TOOL_CANCELLED'))
    try {
      const result = await tool.execute(context, normalizedArgs, signal)
      const internalProposal = result?.proposal
      const publicResult = result && typeof result === 'object'
        ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'proposal'))
        : result
      const normalizedResult = this.withMeta(tool, publicResult?.ok === false
        ? publicResult
        : { ok: true, references: [], truncated: false, ...publicResult })
      if (!tool.validateOutput(normalizedResult)) {
        return this.withMeta(tool, errorResult(new HarnessError(
          'TOOL_OUTPUT_INVALID',
          '工具输出不符合公开契约',
          { category: 'internal', retryStrategy: 'none', terminal: true }
        ), 'TOOL_OUTPUT_INVALID'))
      }
      if (internalProposal !== undefined) {
        Object.defineProperty(normalizedResult, 'proposal', { value: internalProposal, enumerable: false })
      }
      return normalizedResult
    } catch (error) {
      return this.withMeta(tool, errorResult(error))
    }
  }

  withMeta(tool, result) {
    return {
      ...result,
      meta: { contractVersion: '2', toolVersion: tool.version, contractHash: tool.contractHash }
    }
  }
}

export default DomainToolRegistry
