import {
  KNOWLEDGE_SECTION_CONTENT_MAX_LENGTH,
  KNOWLEDGE_SECTIONS_TOTAL_MAX_LENGTH,
  SETTING_KINDS
} from '../../services/knowledgeDocumentContract.js'

const index = `# 51码字文档工具

内置帮助使用 help/... 路径，例如 read({"path":"help/index.md"})，不要加 book/。当前书籍文档可使用工作区提供的 toolPath 读取；其他文档用 list_files 一次列出，再使用返回的自然语言 path。多个文件可用 read({paths:[...]}) 批量读取，逐项检查 complete、nextCursor 及 pendingPaths。book/ 表示当前绑定书籍，不含书名。knowledge/... 等磁盘相对路径不能作为工具 path。修改前按需读取对应说明；分页只需 read({"cursor":"返回的短 nextCursor"})；list_files 同样支持仅传 cursor。游标绑定当前轮次，失效后用原路径重新读取。

书籍文档的 read/write/edit.path、create.directory、sources 和文档关联使用 book/... 地址；内置帮助的 read.path 使用 help/...。目录末尾的 / 可省略，后端返回标准路径；固定目录名不区分大小写，卷名和文件名按当前书中唯一匹配的实际名称解析。不要使用磁盘盘符、反斜杠或 ..。来源版本、稳定 ID 和中文章节引用的编码由后端补齐。

- help/characters.md：人物资料格式
- help/settings.md：设定资料格式
- help/outlines.md：大纲格式
- help/chapters.md：正文格式
- help/notes.md：速记格式
- help/references.md：来源与稳定引用

目录或集合可传 query 做当前书籍内的文字检索。检索摘要、目录、view 和 help 不是正文读取证据；需要依据内容写作时继续读取命中的文件。`

const characters = `# 人物资料

新建时不填写 id/type；后端会补齐。已有文档全文替换时必须保留 id、type、自定义元数据及未删除的自定义分区。

\`\`\`markdown
---
title: 林舟
status: draft
aliases: []
tags: []
---

### 核心定位 <!-- 51:section=summary -->

年轻的渡船人。

### 外貌与衣着 <!-- 51:section=appearance -->

<!-- 已读取资料中存在相关信息时应完整记录；未提及则标注未提及，不自行编造。 -->
- 年龄特征：年轻，具体年龄未提及。
- 外貌特征：未提及。
- 服饰特征：未提及。

### 当前状态 <!-- 51:section=current-state -->

正在寻找失踪的同伴。

### 已确认事实 <!-- 51:section=facts -->

此处只写有来源支撑的事实；构想应明确标注。
\`\`\`

status 只能是 draft、confirmed、planned、deprecated。必填 section 键不可删除、重复；标题可改。单分区及全部分区正文上限均为 ${KNOWLEDGE_SECTION_CONTENT_MAX_LENGTH} 个 UTF-16 code units（总上限 ${KNOWLEDGE_SECTIONS_TOTAL_MAX_LENGTH}）。`

const settings = `# 设定资料

新建时不填写 id/type；后端会补齐。

\`\`\`markdown
---
title: 潮汐城
kind: location
status: draft
aliases: []
tags: []
---

### 定义 <!-- 51:section=definition -->

沿海城镇。

### 规则与边界 <!-- 51:section=rules -->

每天两次开闭水门。

### 已确认事实 <!-- 51:section=facts -->

待依据正文补充。
\`\`\`

kind 可用值：${SETTING_KINDS.join('、')}。status 只能是 draft、confirmed、planned、deprecated。`

const outlines = `# 大纲资料

新建时不填写 id/type；后端会补齐。大纲是计划资料，不应冒充已经发生的正文事实。

\`\`\`markdown
---
title: 第一卷主线
status: planned
tags: []
order: 1
relatedOutlines: []
chapterRefs: []
characterRefs: []
settingRefs: []
---

### 核心内容 <!-- 51:section=summary -->

主角追寻同伴的去向。

### 展开说明 <!-- 51:section=details -->

先调查渡口，再进入城内。

### 约束与结果 <!-- 51:section=constraints -->

记录故事计划及约束。
\`\`\`

order 是数字或 null；relatedOutlines、chapterRefs、characterRefs、settingRefs 可直接填相应文档的 book/... 路径数组，后端在提案中转换为稳定引用，也兼容已有稳定引用。`

const chapters = `# 正文章节

章节是 UTF-8 纯文本，不使用 YAML frontmatter、Markdown 包装、HTML 或工具说明。章节 path 使用当前工作区的 toolPath，或从 book/chapters/ 的目录结果原样复制。

read 返回的 text 是不带展示行号的规范化原文。超长章节使用 nextCursor 连续读取；write 前必须读完同一版本，edit 目标范围必须已实际读取。

正文有选区时，润色、改写、扩写只传 path 和 edits:[{newText:"替换后的完整选区"}]，不传 oldText 或坐标。后端按本轮固定选区位置替换，重复句子也不会改错位置。针对选区续写时，newText 为原选区加续写内容，不修改选区外文本。无选区时每项必须传 oldText/newText，可提交同一文档多处唯一匹配、互不重叠的局部替换。整章重写须先取消选区，再使用 write。用户确认或撤销后自动保存。

新建章节时，create.directory 使用已有卷的目录路径，后端会冻结唯一的“新章节-N”文件名。正文不使用 basis 或 sources。`

const notes = `# 助手速记

速记位于 book/notes/quick-notes.md，是普通 Markdown，authorityStatus 为 private_note。它可以保存构思和工作记录，但不能冒充正式正文事实。

读取时可分页。已有速记可用 write 或 edit 生成提案；文件缺失时，只能对 book/notes/ 使用 create。速记不使用 basis 或 sources。

归档时在文档内使用“## 归档”分区，通过一次 edit 将完整内容块移入该分区；不创建其他速记文件。`

const references = `# 来源与引用

根据正式资料整理知识文档时使用 basis=source_grounded，sources 填本轮实际读取的文件 path，例如 ["book/knowledge/characters/char_001.md"]。后端从本轮已交付记录补齐版本引用；未读来源不能自动补证据，版本变化须重读。兼容旧的完整 reference。目录、检索摘要、view 和 help 不构成已读证据；至少一项来源必须是 authoritative_saved；目标为大纲时，也允许 planned_saved 大纲作为整理计划的来源。

用户明确要求创作时可使用 basis=creative，且不要附带 sources。

知识文档和速记内的链接可写 [[book/knowledge/characters/char_001.md|林舟]]；大纲关联字段也可填文档路径数组。后端校验目标后转换为稳定引用，转换结果在提案预览中展示。正文为纯文本，不作引用转换。旧的稳定引用继续有效；read 返回的 links 提供已有引用对应的可读路径。edit.oldText 仍须复制实际返回的原文，不要自行转换旧文本。历史对话是只读参考，不能单独证明正式事实。`

export const HELP_DOCUMENTS = Object.freeze({
  'help/index.md': index,
  'help/characters.md': characters,
  'help/settings.md': settings,
  'help/outlines.md': outlines,
  'help/chapters.md': chapters,
  'help/notes.md': notes,
  'help/references.md': references
})

export function getHelpDocument(path) {
  return HELP_DOCUMENTS[String(path || '')] ?? null
}

export default HELP_DOCUMENTS
