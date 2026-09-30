# 助手速记

速记位于 `book/notes/quick-notes.md`，是普通 Markdown，`authorityStatus` 为 `private_note`。它可以保存构思和工作记录，但不能冒充正式正文事实。

读取时可分页。文件已存在时可用 `write` 或 `edit` 生成提案；文件缺失时，只能用 `directory=book/notes/` 的 `create` 建立唯一的速记。速记不使用 `basis` 或 `sources`。

需要归档时，在文档内使用 `## 归档` 分区，通过一次 `edit` 将完整内容块从活跃区移入该分区；不要删除文件或创建其他速记文件。
