// Compatibility export. Canonical Tool Contract v2 lives in contracts/.
export { TOOL_SCOPES } from './contracts/commonSchemas.js'
export {
  listBookStructureSchema,
  searchBookKnowledgeSchema,
  readBookSourceSchema,
  readBookBacklinksSchema,
  readOutlineContextSchema
} from './contracts/readToolContracts.js'
export {
  proposeChapterEditSchema,
  proposeCharacterEditSchema,
  proposeSettingEditSchema,
  proposeOutlineEditSchema,
  proposeQuickNoteChangeSchema
} from './contracts/proposalToolContracts.js'
