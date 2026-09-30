# 大纲资料

新建时不填写 `id/type`；后端会补齐。大纲是计划资料，不应冒充已经发生的正文事实。

```markdown
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
```

`order` 是数字或 `null`；`relatedOutlines`、`chapterRefs`、`characterRefs`、`settingRefs` 可直接填相应文档的 `book/...` 路径数组，后端在提案中转换为稳定引用，也兼容已有稳定引用。
