# 来源与引用

根据正式资料整理知识文档时使用 `basis=source_grounded`，`sources` 填本轮实际读取的文件 `path`，例如 `["book/knowledge/characters/char_001.md"]`。后端从已交付记录补齐版本引用；未读来源不会自动补证据，来源版本变化须重读。旧的完整 `reference` 继续兼容。目录、检索摘要、只读视图和帮助文档不构成已读证据；至少一项来源必须是 `authoritative_saved`。

用户明确要求创作时可使用 `basis=creative`，且不要附带 `sources`。

知识文档和速记内的链接可写 `[[book/knowledge/characters/char_001.md|林舟]]`；大纲关联字段也可填文档路径数组。后端校验目标后转换为稳定引用，转换结果在提案预览中展示。正文为纯文本，不作引用转换。

旧的稳定引用继续有效；`read` 返回的 `links` 提供已有引用对应的可读路径。`edit.oldText` 仍须复制实际返回的原文，不要自行转换旧文本。历史对话是只读参考，`authorityStatus` 为 `unconfirmed_conversation`，不能单独证明正式事实。
