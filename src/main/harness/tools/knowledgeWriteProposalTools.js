import {
  proposeCharacterEditSchema,
  proposeOutlineEditSchema,
  proposeQuickNoteChangeSchema,
  proposeSettingEditSchema
} from './toolSchemas.js'

function normalizeKnowledgeProposalArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const normalized = { ...args }
  // `changes` uniquely identifies patch_document. Some OpenAI-compatible
  // providers omit the discriminator hidden in oneOf even though they emit a
  // valid patch payload; restoring it is deterministic and does not alter the
  // requested target, content, hashes, or side effects.
  if (!normalized.operation && Array.isArray(normalized.changes)) {
    normalized.operation = 'patch_document'
  }
  if (!normalized.summary && typeof normalized.reason === 'string' && normalized.reason.trim()) {
    normalized.summary = normalized.reason.trim().slice(0, 120)
  }
  if (!normalized.summary && normalized.operation === 'patch_document') {
    normalized.summary = '更新知识文档多个分区'
  }
  return normalized
}

export function createKnowledgeWriteProposalTools({ proposalService }) {
  if (!proposalService) throw new TypeError('proposalService is required')
  return [
    {
      name: 'propose_character_edit',
      version: '2',
      risk: 'proposal',
      description:
        '为人物 Markdown 创建待确认提案。新建文档必须填写 sections；同一文档的多处分区修改必须用一次 patch_document changes 原子提交。根据正式资料整理时 basis=source_grounded，并提供本轮 read_book_source 已读取的 sourceReferences；纯创作仅在用户明确要求时使用 basis=creative。',
      inputSchema: proposeCharacterEditSchema,
      normalizeArguments: normalizeKnowledgeProposalArguments,
      execute: (context, args, signal) => proposalService.createFromTool(context, 'character', args, signal)
    },
    {
      name: 'propose_setting_edit',
      version: '2',
      risk: 'proposal',
      description:
        '为设定 Markdown 创建待确认提案。新建文档必须填写 sections；同一文档的多处分区修改必须用一次 patch_document changes 原子提交。正式资料提案必须引用本轮 read_book_source 已读取的 authoritative_saved 来源。',
      inputSchema: proposeSettingEditSchema,
      normalizeArguments: normalizeKnowledgeProposalArguments,
      execute: (context, args, signal) => proposalService.createFromTool(context, 'setting', args, signal)
    },
    {
      name: 'propose_outline_edit',
      version: '2',
      risk: 'proposal',
      description:
        '唯一的大纲写入提案工具。每次调用都必须在顶层传 operation、summary 和 basis。修改多个分区时，顶层 operation 必须是 patch_document，并在顶层传 documentId、expectedFileHash、changes；changes 数组只放 replace_section 等子操作。新建大纲必须把 summary、details、constraints 分别放入 sections。basis=source_grounded 时必须提供本轮较早轮次 read_book_source 返回的原始 reference，并且至少一个来源为 authoritative_saved；planned_saved 大纲不能单独满足该门槛。',
      inputSchema: proposeOutlineEditSchema,
      normalizeArguments: normalizeKnowledgeProposalArguments,
      execute: (context, args, signal) => proposalService.createFromTool(context, 'outline', args, signal)
    },
    {
      name: 'propose_quick_note_change',
      version: '2',
      risk: 'proposal',
      description:
        '为助手速记创建追加、插入标题块、精确范围替换或归档提案；必须由用户确认后才会写入。',
      inputSchema: proposeQuickNoteChangeSchema,
      execute: (context, args, signal) => proposalService.createQuickNoteFromTool(context, args, signal)
    }
  ]
}

export default createKnowledgeWriteProposalTools
