import { proposeChapterEditSchema } from './toolSchemas.js'

export function createBodyWriteProposalTools({ proposalService }) {
  if (!proposalService) throw new TypeError('proposalService is required')
  return [
    {
      name: 'propose_chapter_edit',
      version: '2',
      risk: 'proposal',
      description:
        '为当前已保存的正文章节和选区创建结构化修改提案。只创建待确认提案，不会写入正文。',
      inputSchema: proposeChapterEditSchema,
      execute(context, args, signal) {
        return proposalService.createFromTool(context, args, signal)
      }
    }
  ]
}

export default createBodyWriteProposalTools
