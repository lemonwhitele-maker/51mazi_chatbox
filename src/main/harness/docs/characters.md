# 人物资料

新建时不填写 `id/type`；后端会补齐。已有文档全文替换时必须保留身份、自定义元数据及未删除的自定义分区。

```markdown
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
```

`status` 使用 `draft`、`confirmed`、`planned` 或 `deprecated`。必填 section 键不可删除或重复，标题可改。单分区及全部分区正文上限均为 30000 个 UTF-16 code units。
