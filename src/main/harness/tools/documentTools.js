import { HarnessError } from '../harnessErrors.js'
import { documentToolContracts } from './contracts/documentToolContracts.js'
import { assertWholeDocumentRead, trackWholeDocumentRead } from '../documents/wholeDocumentTask.js'
import { DEFAULT_TOOL_READ_BUDGET } from '../../services/agentBudgets.js'

function unsupported(name) {
  throw new HarnessError(
    'RESOURCE_NOT_SUPPORTED',
    `${name} 尚未在当前里程碑接入；P2 仅开放安全读取`,
    { retryable: false, nextAction: '继续使用 read；写入能力将在后续里程碑启用' }
  )
}

function readContractBudget(contract, budget) {
  if (!['read', 'list_files'].includes(contract.name)) return {}
  const inputSchema = structuredClone(contract.inputSchema)
  inputSchema.properties.maxChars.maximum = budget.maxPageChars
  return { inputSchema, resultBudget: { maxChars: budget.maxResultChars } }
}

export function createDocumentTools({ documentService, proposalService = null } = {}) {
  if (!documentService?.read) throw new Error('documentService.read is required')
  return documentToolContracts.map((contract) => ({
    ...contract,
    ...readContractBudget(contract, documentService.readBudget || DEFAULT_TOOL_READ_BUDGET),
    async execute(context, args, signal) {
      if (contract.name === 'list_files') return documentService.listFiles(context, args)
      if (contract.name === 'read') {
        const result = await documentService.read(context, args, signal)
        trackWholeDocumentRead(context.wholeDocumentTask, result)
        return result
      }
      if (!proposalService?.[contract.name]) return unsupported(contract.name)
      await assertWholeDocumentRead(context, proposalService.readSnapshotLedger, documentService)
      return proposalService[contract.name](context, args, signal)
    }
  }))
}

export function createDocumentReadTool({ documentService } = {}) {
  return createDocumentTools({ documentService })[0]
}

export default createDocumentTools
