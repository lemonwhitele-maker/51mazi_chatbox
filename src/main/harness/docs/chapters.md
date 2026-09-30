# 正文章节

章节是 UTF-8 纯文本，不使用 YAML frontmatter、Markdown 包装、HTML 或工具说明。路径使用当前工作区的 `toolPath`，或从目录结果原样复制。

`read` 返回的 `text` 是不带展示行号的规范化原文。超长章节使用 `nextCursor` 连续读取；`write` 前必须读完同一版本，`edit` 目标范围必须已实际读取。

正文有选区时，润色、改写、扩写只传 `path` 和 `edits:[{newText:"替换后的完整选区"}]`，不传 `oldText` 或坐标。后端按本轮固定选区位置替换，重复句子也不会改错位置。针对选区续写时，`newText` 为原选区加续写内容，不修改选区外文本。无选区时每项必须传 `oldText/newText`，可提交同一文档多处唯一匹配、互不重叠的局部替换。整章重写须先取消选区，再使用 `write`。用户确认或撤销后自动保存。

新建章节时，将 `create.directory` 设为目录结果返回的已有卷路径（例如 `book/chapters/第一卷/`）。后端会冻结唯一的“新章节-N”文件名，确认前不创建正式文件。正文不使用 `basis` 或 `sources`。
