<template>
  <div class="editor-container">
    <el-splitter>
      <el-splitter-panel :size="240" :min="200" :max="400">
        <!-- 左侧面板：笔记章节 -->
        <NoteChapter ref="noteChapterRef" :book-name="bookName" />
      </el-splitter-panel>
      <el-splitter-panel>
        <!-- 中间编辑区 -->
        <EditorPanel
          ref="editorPanelRef"
          :book-name="bookName"
          @refresh-notes="refreshNotes"
          @refresh-chapters="refreshChapters"
          @agent-diff-resolved="handleAgentDiffResolved"
        />
      </el-splitter-panel>
    </el-splitter>
  </div>
</template>

<script setup>
import { ref, nextTick, onActivated, onDeactivated } from 'vue'
import { useRoute } from 'vue-router'

defineOptions({ name: 'Editor' })
const emit = defineEmits(['agent-diff-resolved'])
import NoteChapter from '@renderer/components/Editor/NoteChapter.vue'
import EditorPanel from '@renderer/components/Editor/EditorPanel.vue'

const route = useRoute()

// 解析新窗口参数
let bookName = null
if (window.process && window.process.argv) {
  // Electron 传递的 additionalArguments
  for (const arg of window.process.argv) {
    if (arg.startsWith('bookName=')) bookName = decodeURIComponent(arg.replace('bookName=', ''))
  }
}
if (!bookName) {
  // 回退到 hash/query
  bookName = route.query.name
}

const noteChapterRef = ref(null)
const editorPanelRef = ref(null)

function getAgentContext(mode) {
  return editorPanelRef.value?.getAgentContext?.(mode) || null
}

function proposeAgentDiff(diff) {
  return editorPanelRef.value?.proposeAgentDiff?.(diff) || false
}

function validateBodyWriteProposal(proposal) {
  return editorPanelRef.value?.validateBodyWriteProposal?.(proposal)
}

function previewBodyWriteProposal(proposal) {
  return editorPanelRef.value?.previewBodyWriteProposal?.(proposal) || false
}

function clearBodyWriteProposalPreview(proposalId) {
  editorPanelRef.value?.clearBodyWriteProposalPreview?.(proposalId)
}

function applyBodyWriteProposalResult(payload) {
  editorPanelRef.value?.applyBodyWriteProposalResult?.(payload)
}

async function openPendingReference() {
  try {
    const key = `51mazi.reference-jump:${bookName}`
    const target = JSON.parse(window.sessionStorage.getItem(key) || 'null')
    if (!target || target.type !== 'chapter') return
    window.sessionStorage.removeItem(key)
    const parts = String(target.targetId || '').replaceAll('\\', '/').split('/')
    const volumeName = parts.at(-2) || ''
    const chapterName = parts.at(-1)?.replace(/\.txt$/i, '') || ''
    await noteChapterRef.value?.openChapterReference?.(volumeName, chapterName)
    await nextTick()
    await editorPanelRef.value?.highlightReferenceLines?.(
      target.line || 1,
      target.endLine || target.line || 1
    )
  } catch {
    // 无效引用不影响编辑器正常工作。
  }
}

async function openAgentReference(target) {
  if (!target || target.type !== 'chapter') return false
  const parts = String(target.targetId || '').replaceAll('\\', '/').split('/')
  const volumeName = parts.at(-2) || ''
  const chapterName = parts.at(-1)?.replace(/\.txt$/i, '') || ''
  await noteChapterRef.value?.openChapterReference?.(volumeName, chapterName)
  await nextTick()
  await editorPanelRef.value?.highlightReferenceLines?.(
    target.line || 1,
    target.endLine || target.line || 1
  )
  return true
}

function handleAgentDiffResolved({ id, status }) {
  emit('agent-diff-resolved', { id, status })
}

function refreshNotes() {
  noteChapterRef.value && noteChapterRef.value.reloadNotes && noteChapterRef.value.reloadNotes()
}

function refreshChapters() {
  noteChapterRef.value &&
    noteChapterRef.value.reloadChapters &&
    noteChapterRef.value.reloadChapters()
}

defineExpose({
  getAgentContext,
  proposeAgentDiff,
  validateBodyWriteProposal,
  previewBodyWriteProposal,
  clearBodyWriteProposalPreview,
  applyBodyWriteProposalResult,
  openPendingReference,
  openAgentReference
})

// keep-alive 下用 activated/deactivated 绑定窗口事件，避免停用页仍监听刷新
onActivated(() => {
  if (bookName) {
    document.title = `${bookName} - 51码字`
  }
  window.addEventListener('refresh-chapters-requested', refreshChapters)
  void nextTick(() => {
    refreshNotes()
    void openPendingReference()
  })
})

onDeactivated(() => {
  window.removeEventListener('refresh-chapters-requested', refreshChapters)
})

// function handleSelectFile(file) {
//   // 预留：可做高亮、聚焦等
// }
</script>

<style lang="scss" scoped>
.editor-container {
  height: 100vh;
  background-color: var(--bg-primary);
  position: relative;
  overflow: hidden;
}
</style>
