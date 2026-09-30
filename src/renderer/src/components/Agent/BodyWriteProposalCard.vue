<template>
  <article class="proposal-card" :class="`is-${proposal.status}`">
    <header>
      <div>
        <strong>{{ summaryText }}</strong>
        <small>{{ targetText }}</small>
      </div>
      <span class="proposal-status">{{ statusText }}</span>
    </header>

    <div class="proposal-operation">{{ operationText }}</div>
    <p v-if="proposal.reason" class="proposal-reason">{{ proposal.reason }}</p>
    <template v-if="isCompactEdit">
      <template v-if="selectionPreview">
        <p class="proposal-changes">仅替换本轮选中文本，选区外保持不变。</p>
        <section><label>选中原文</label><pre>{{ selectionPreview.before }}</pre></section>
        <section><label>替换后文本</label><pre class="proposed">{{ selectionPreview.after || '（删除选中文本）' }}</pre></section>
      </template>
      <template v-else>
      <p class="proposal-changes">仅显示改动及少量上下文，省略未修改的正文。</p>
      <section v-for="(fragment, index) in editFragments" :key="index" class="edit-fragment">
        <label>改动 {{ index + 1 }} · {{ !fragment.before ? '新增' : !fragment.after ? '删除' : '替换' }}</label>
        <label>原文片段</label>
        <pre><span v-if="fragment.omittedBefore" class="diff-context">…</span><span class="diff-context">{{ fragment.leading }}</span><span class="diff-removed">{{ fragment.before }}</span><span v-if="!fragment.before" class="diff-position">〔插入位置〕</span><span class="diff-context">{{ fragment.trailing }}</span><span v-if="fragment.omittedAfter" class="diff-context">…</span></pre>
        <label>建议片段</label>
        <pre class="proposed"><span v-if="fragment.omittedBefore" class="diff-context">…</span><span class="diff-context">{{ fragment.leading }}</span><span class="diff-added">{{ fragment.after }}</span><span v-if="!fragment.after" class="diff-position">〔删除此处内容〕</span><span class="diff-context">{{ fragment.trailing }}</span><span v-if="fragment.omittedAfter" class="diff-context">…</span></pre>
      </section>
      <p v-if="!editFragments.length" class="proposal-changes">文本没有变化。</p>
      </template>
      <details class="full-preview">
        <summary>查看全文对照</summary>
        <section><label>完整原文</label><pre>{{ originalText }}</pre></section>
        <section><label>完整建议文本</label><pre class="proposed">{{ proposedText }}</pre></section>
      </details>
    </template>
    <template v-else>
      <section v-if="originalText">
        <label>原文</label>
        <pre>{{ originalText }}</pre>
      </section>
      <section v-else-if="proposal.operation === 'append_to_chapter' || proposal.operation === 'append_note'">
        <label>位置</label>
        <div class="proposal-end">{{ proposal.operation === 'append_note' ? '速记末尾' : '章节末尾' }}</div>
      </section>
      <section>
        <label>建议文本</label>
        <pre class="proposed">{{ proposedText }}</pre>
      </section>
    </template>
    <div v-if="proposal.affectedSections?.length" class="proposal-changes">
      影响 section：{{ proposal.affectedSections.join('、') }}
    </div>
    <div v-if="proposal.referenceChanges?.length" class="proposal-changes">
      引用变化：{{ proposal.referenceChanges.map((item) => item.reference).join('、') }}
    </div>

    <p v-if="proposal.failure?.message" class="proposal-failure">
      {{ proposal.failure.message }}
    </p>
    <p v-if="proposal.requiresRegeneration" class="proposal-failure">旧提案未冻结完整候选，需在四工具模式下重新生成。</p>
    <p v-if="proposal.requiresReview" class="proposal-failure">旧提案的写入结果尚未核对，请检查正式资料后再处理。</p>
    <p v-if="proposal.status === 'pending'" class="proposal-safety">
      {{ proposal.proposalType ? '确认前不会改变正式资料。' : '应用前不会改变正文。' }}
    </p>
    <p v-else-if="proposal.status === 'applied'" class="proposal-safety success">
      已写入正式资料。
    </p>
    <p v-if="turnRunning && (actions.canConfirm || actions.canUndo)" class="proposal-safety">
      对话生成中，请等待本轮结束后再操作。
    </p>

    <footer>
      <button type="button" :disabled="busy" @click="$emit('copy', proposal)">{{ isCompactEdit ? '复制完整建议文本' : '复制' }}</button>
      <template v-if="actions.canConfirm">
        <button type="button" :disabled="busy || turnRunning" @click="$emit('reject', proposal)">取消</button>
        <button class="primary" type="button" :disabled="busy || turnRunning" @click="$emit('confirm', proposal)">
          {{ busy ? '处理中…' : proposal.status === 'failed' ? '重试写入' : '确认写入' }}
        </button>
      </template>
      <button
        v-else-if="actions.canUndo"
        class="primary"
        type="button"
        :disabled="busy || turnRunning"
        @click="$emit('undo', proposal)"
      >
        {{ busy ? '处理中…' : '撤销' }}
      </button>
    </footer>
  </article>
</template>

<script setup>
import { computed } from 'vue'
import { bodyWriteProposalActions } from './bodyWriteProposalUi.js'
import { editPreviewFragments } from './editProposalPreview.js'

const props = defineProps({
  proposal: { type: Object, required: true },
  busy: { type: Boolean, default: false },
  turnRunning: { type: Boolean, default: false }
})

defineEmits(['confirm', 'reject', 'copy', 'undo'])

const actions = computed(() => bodyWriteProposalActions(props.proposal))
const summaryText = computed(() => {
  if (typeof props.proposal.summary === 'string') return props.proposal.summary
  const summary = props.proposal.summary || {}
  return `${operationText.value}：${summary.beforeChars ?? 0} → ${summary.afterChars ?? 0} 字符`
})
const originalText = computed(() => props.proposal.originalText || props.proposal.preview?.before || '')
const proposedText = computed(() => props.proposal.proposedText || props.proposal.preview?.after || '')
const isCompactEdit = computed(() => props.proposal.operation === 'edit' && props.proposal.preview?.complete === true)
const selectionPreview = computed(() => props.proposal.preview?.selection || null)
const editFragments = computed(() => isCompactEdit.value && !selectionPreview.value
  ? editPreviewFragments(originalText.value, proposedText.value) : [])
const targetText = computed(() => {
  const target = props.proposal.target || {}
  if (target.volumeName || target.chapterName) return [target.volumeName, target.chapterName].filter(Boolean).join(' / ')
  const labels = { character: '人物', setting: '设定', outline: '大纲', chapter: '正文', note: '速记' }
  return `${labels[target.type] || '资料'} · ${target.title || target.documentId || target.path || ''}`
})

const operationText = computed(
  () =>
    ({
      replace_selection: '替换选区',
      insert_before_selection: '在选区前插入',
      insert_after_selection: '在选区后插入',
      append_to_chapter: '追加到章节末尾',
      create_document: '创建文档',
      update_metadata: '更新元数据',
      replace_section: '替换 section',
      append_to_section: '追加到 section',
      insert_section: '插入 section',
      rename_section_label: '重命名 section 标题',
      add_reference: '添加稳定引用',
      remove_reference: '移除稳定引用',
      archive_document: '归档文档',
      change_order: '调整大纲顺序',
      link_chapter: '关联章节',
      unlink_chapter: '取消章节关联',
      link_outline: '关联大纲',
      unlink_outline: '取消大纲关联',
      append_note: '追加速记',
      insert_heading_block: '插入速记标题块',
      replace_range: '替换速记范围',
      archive_block: '归档速记块',
      create: '创建完整文档',
      write: '替换完整文档',
      edit: '局部编辑文档'
    })[props.proposal.operation] || props.proposal.operation
)

const statusText = computed(
  () =>
    ({
      pending: '待确认',
      applying: '正在写入',
      applied: '已写入',
      rejected: '已取消',
      superseded: '已被新提案替代',
      stale: '已失效',
      conflicted: '存在冲突',
      failed: '写入失败',
      undone: '已撤销'
    })[props.proposal.status] || props.proposal.status
)
</script>

<style scoped>
.proposal-card { margin: 10px 0 14px; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 8px; background: var(--el-fill-color-light); }
.proposal-card header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.proposal-card header div { min-width: 0; }
.proposal-card header strong, .proposal-card header small { display: block; }
.proposal-card header small, .proposal-operation, .proposal-safety, .proposal-reason, .proposal-changes { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 12px; }
.proposal-status { flex: 0 0 auto; padding: 2px 6px; border-radius: 10px; background: var(--el-color-primary-light-8); color: var(--el-color-primary); font-size: 11px; }
.proposal-card section { margin-top: 10px; }
.proposal-card label { display: block; margin-bottom: 4px; color: var(--el-text-color-secondary); font-size: 11px; }
.proposal-card pre, .proposal-end { max-height: 180px; margin: 0; overflow: auto; padding: 8px; border-radius: 6px; background: var(--el-bg-color); font: inherit; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.proposal-card pre.proposed { border-left: 3px solid var(--el-color-success); }
.edit-fragment pre + label { margin-top: 8px; }
.diff-context, .diff-position { color: var(--el-text-color-secondary); }
.diff-removed { background: var(--el-color-danger-light-9); color: var(--el-color-danger); }
.diff-added { background: var(--el-color-success-light-9); color: var(--el-color-success); }
.full-preview { margin-top: 10px; font-size: 12px; }
.full-preview summary { cursor: pointer; color: var(--el-color-primary); }
.proposal-failure { color: var(--el-color-danger); font-size: 12px; }
.proposal-safety.success { color: var(--el-color-success); }
.proposal-card footer { display: flex; justify-content: flex-end; gap: 7px; margin-top: 10px; }
.proposal-card button { padding: 5px 9px; border: 1px solid var(--el-border-color); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.proposal-card button.primary { border-color: var(--el-color-primary); background: var(--el-color-primary); color: white; }
.proposal-card button:disabled { cursor: not-allowed; opacity: 0.55; }
.proposal-card.is-stale, .proposal-card.is-conflicted, .proposal-card.is-rejected, .proposal-card.is-superseded, .proposal-card.is-undone { opacity: 0.78; }
</style>
