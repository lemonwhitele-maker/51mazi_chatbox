const sourceFields = {
  basis: { type: 'string', enum: ['source_grounded', 'creative'], description: '仅知识文档使用；正文和速记不得填写。' },
  sources: {
    type: 'array',
    description: '仅知识文档使用，正文和速记不得填写。本轮实际读过的文档虚拟路径；后端补齐来源版本，也兼容原始 reference。',
    maxItems: 24,
    uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 1500 }
  }
}

export const readToolSchema = Object.freeze({
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 1024 },
    paths: { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 1024 } },
    cursor: { type: 'string', minLength: 1, maxLength: 64, description: '后端返回的短游标；续读只需传 cursor，无须重复 path 或 query。' },
    query: { type: 'string', minLength: 1, maxLength: 500 },
    maxChars: { type: 'integer', minimum: 512, maximum: 12000 }
  },
  anyOf: [{ properties: { path: {} }, required: ['path'] }, { properties: { paths: {} }, required: ['paths'] }, { properties: { cursor: {} }, required: ['cursor'] }],
  additionalProperties: false
})

export const createToolSchema = Object.freeze({
  type: 'object',
  properties: {
    directory: { type: 'string', minLength: 1, maxLength: 1024 },
    content: { type: 'string', minLength: 1, maxLength: 120000 },
    ...sourceFields
  },
  required: ['directory', 'content'],
  additionalProperties: false
})

export const writeToolSchema = Object.freeze({
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 1024 },
    content: { type: 'string', maxLength: 120000 },
    ...sourceFields
  },
  required: ['path', 'content'],
  additionalProperties: false
})

export const editToolSchema = Object.freeze({
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 1024 },
    edits: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          oldText: { type: 'string', minLength: 1, maxLength: 30000, description: '仅无正文选区时必填，须为实际读过且唯一匹配的原文。有正文选区时不传此字段，后端按本轮固定选区位置替换。' },
          newText: { type: 'string', maxLength: 30000, description: '替换后的完整文本。选区润色、改写、扩写均替换整段选区；针对选区续写时保留原选区，再追加续写。不得填写插入位置或坐标。' }
        },
        required: ['newText'],
        additionalProperties: false
      }
    },
    ...sourceFields
  },
  required: ['path', 'edits'],
  additionalProperties: false
})

export const DOCUMENT_TOOLSET_ID = 'book-primitives-v1'

export const listFilesSchema = Object.freeze({
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 1024 },
    cursor: { type: 'string', minLength: 1, maxLength: 64, description: '后端返回的短游标；续读只需传 cursor，无须重复 path 或 query。' },
    maxChars: { type: 'integer', minimum: 512, maximum: 12000 }
  },
  additionalProperties: false
})

export const documentToolContracts = Object.freeze([
  {
    name: 'read',
    version: '2',
    risk: 'read',
    description:
      '读取当前书籍文档或内置格式说明。内置帮助使用 path="help/index.md" 等 help/... 地址，不要加 book/；书籍文档使用 book/... 地址，可复制当前工作区 toolPath 或返回的 path。目录可用 query 检索，续读只需原样传短 cursor，不必重复 path 或 query；游标仅在当前轮次有效。多个文件用 paths 数组批量读取（不可与 path/cursor/query 同用），逐项检查 complete 和 nextCursor；定位文件优先 list_files，无需逐层遍历目录。',
    inputSchema: readToolSchema
  },
  {
    name: 'create',
    version: '2',
    risk: 'proposal',
    description:
      '在当前书籍指定目录生成新建文档的待确认提案。不会立即创建正式文档。directory 使用目录虚拟路径；知识文档声明 basis，根据资料整理时 sources 填本轮已读文档路径。',
    inputSchema: createToolSchema
  },
  {
    name: 'write',
    version: '2',
    risk: 'proposal',
    description:
      '整章重写或全文重写使用 write，为完整读取过的已有文档生成全文替换提案。有正文选区时仅允许 edit 替换选区；整章重写须先取消选区重新发送。用户确认后自动保存。知识文档声明 basis；根据资料整理时 sources 填本轮已读文档路径。',
    inputSchema: writeToolSchema
  },
  {
    name: 'edit',
    version: '2',
    risk: 'proposal',
    description:
      '局部修改使用 edit。①正文有选区时，润色、改写、扩写只提交 path 和 edits:[{newText:"替换后的完整选区"}]，不传 oldText 或坐标；后端按本轮固定选区位置替换，选区外不变。②针对选区续写，用原选区加续写作为 newText。③无正文选区时支持同一文档多处局部替换，每项必须传 oldText/newText，oldText 在同一已读版本中须唯一匹配且互不重叠。④整章或全文重写使用 write，须先取消正文选区。选区定位由后端按本轮快照校验；必须先 read 目标原文。用户确认后自动保存；正文和速记不得填写 basis/sources。',
    inputSchema: editToolSchema
  },
  {
    name: 'list_files', version: '2', risk: 'read',
    description: '一次递归列出当前书籍文件的标题、类型和可读路径。默认列正文、人物、设定、大纲和速记；path 可指定 book/knowledge/outlines/ 等子目录，历史会话须显式指定 book/conversations/。清单不是正文证据；complete=false 时只传 cursor=nextCursor 续列，无须重复 path；游标仅在当前轮次有效。',
    inputSchema: listFilesSchema
  }
])

export default documentToolContracts
