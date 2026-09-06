<template>
  <div
    class="book-workspace"
    :class="{ 'is-agent-collapsed': agentSidebarCollapsed }"
    :style="layoutStyle"
  >
    <section class="book-workspace__left" aria-label="创作工作台">
      <aside class="book-workspace__nav">
        <EditorToolbar />
      </aside>

      <main class="book-workspace__function-area">
        <keep-alive :include="cachedRouteNames" :max="5">
          <component
            :is="component"
            ref="functionAreaRef"
            :key="route.fullPath"
            @agent-diff-resolved="handleAgentDiffResolved"
          />
        </keep-alive>
      </main>
    </section>

    <button
      v-if="!agentSidebarCollapsed"
      class="book-workspace__resize-handle"
      type="button"
      title="拖动调整工作台比例，双击恢复 1:1"
      aria-label="调整工作台比例"
      @pointerdown="startResize"
      @dblclick="resetLayout"
    >
      <span></span>
    </button>

    <section class="book-workspace__agent-dock" aria-label="51码字写作助手">
      <component
        :is="HarnessChatSidebar"
        ref="agentSidebarRef"
        v-model:collapsed="agentSidebarCollapsed"
        :book-name="bookName"
        :workspace-context="workspaceContext"
        :get-editor-context="getActiveContext"
        :validate-proposal="validateBodyWriteProposal"
        @propose-diff="handleAgentDiffProposed"
        @preview-proposal="previewBodyWriteProposal"
        @clear-proposal-preview="clearBodyWriteProposalPreview"
        @proposal-content-applied="applyBodyWriteProposalResult"
        @navigate-reference="navigateAgentReference"
      />
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import EditorToolbar from '@renderer/components/Editor/EditorToolbar.vue'
import HarnessChatSidebar from '@renderer/components/Agent/HarnessChatSidebar.vue'
import { normalizeHarnessWorkspaceContext } from '@renderer/service/harnessClient'

defineOptions({ name: 'BookWorkspace' })

defineProps({
  component: {
    type: [Object, Function],
    required: true
  }
})

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const cachedRouteNames = ['Editor']
const functionAreaRef = ref(null)
const agentSidebarRef = ref(null)
const agentSidebarCollapsed = ref(false)
const layoutRatio = ref(50)

const cliBookName = (() => {
  if (!window.process?.argv) return ''
  const argument = window.process.argv.find((item) => item.startsWith('bookName='))
  return argument ? decodeURIComponent(argument.replace('bookName=', '')) : ''
})()

const bookName = computed(() => String(route.query.name || cliBookName || '').trim())
const workspaceContext = computed(() => normalizeHarnessWorkspaceContext({
  currentModule: String(route.meta.workspaceModule || route.name || 'workspace'),
  currentDocumentId: route.query.id ? String(route.query.id) : null,
  currentEntityId: route.query.id ? String(route.query.id) : null,
  selectionText: '',
  currentDocumentSavedHash: null,
  hasUnsavedChanges: false,
  metadata: { file_type: String(route.name || '') }
}))
const layoutStorageKey = computed(
  () => `51mazi.workspace.layout.v1:${encodeURIComponent(bookName.value || 'global')}`
)
const layoutStyle = computed(() => ({
  gridTemplateColumns: agentSidebarCollapsed.value
    ? 'minmax(0, 1fr) 52px'
    : `${layoutRatio.value}% ${100 - layoutRatio.value}%`
}))

function readLayout() {
  try {
    const stored = Number(window.localStorage.getItem(layoutStorageKey.value))
    if (Number.isFinite(stored) && stored >= 35 && stored <= 65) layoutRatio.value = stored
  } catch {
    layoutRatio.value = 50
  }
}

function saveLayout() {
  try {
    window.localStorage.setItem(layoutStorageKey.value, String(layoutRatio.value))
  } catch {
    // 本地存储不可用时仍保持当前会话中的布局。
  }
}

function resetLayout() {
  layoutRatio.value = 50
  saveLayout()
}

function startResize(event) {
  if (agentSidebarCollapsed.value) return
  event.preventDefault()
  document.body.classList.add('is-resizing-workspace')

  const handlePointerMove = (moveEvent) => {
    const viewportWidth = Math.max(window.innerWidth, 1)
    const minLeft = Math.max(520, viewportWidth * 0.35)
    const maxLeft = Math.min(viewportWidth - 360, viewportWidth * 0.65)
    const nextLeft = Math.min(Math.max(moveEvent.clientX, minLeft), maxLeft)
    layoutRatio.value = Math.round((nextLeft / viewportWidth) * 1000) / 10
  }

  const stopResize = () => {
    document.body.classList.remove('is-resizing-workspace')
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', stopResize)
    saveLayout()
  }

  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', stopResize)
}

function getActiveContext(mode = 'selection') {
  const pageContext = functionAreaRef.value?.getAgentContext?.(mode) || {}
  const activeModule = String(route.meta.workspaceModule || route.name || 'workspace')
  const activeDocumentId = route.query.id ? String(route.query.id) : undefined
  return normalizeHarnessWorkspaceContext({
    ...pageContext,
    currentModule: pageContext.currentModule || activeModule,
    currentDocumentId: pageContext.currentDocumentId || activeDocumentId || null,
    currentEntityId: pageContext.currentEntityId || activeDocumentId || null,
    metadata: pageContext.metadata || {}
  })
}

function handleAgentDiffProposed(diff) {
  const handled = functionAreaRef.value?.proposeAgentDiff?.(diff)
  if (!handled && diff) {
    ElMessage.info(t('assistantDiff.diffOnlyEditor'))
  }
}

function handleAgentDiffResolved(payload) {
  agentSidebarRef.value?.resolveDiff?.(payload?.id, payload?.status)
}

function validateBodyWriteProposal(proposal) {
  return (
    functionAreaRef.value?.validateBodyWriteProposal?.(proposal) || {
      ok: false,
      code: 'WRITE_PROPOSAL_EDITOR_REQUIRED',
      message: '请先打开要修改的正文章节'
    }
  )
}

function previewBodyWriteProposal(proposal) {
  functionAreaRef.value?.previewBodyWriteProposal?.(proposal)
}

function clearBodyWriteProposalPreview(proposalId) {
  functionAreaRef.value?.clearBodyWriteProposalPreview?.(proposalId)
}

function applyBodyWriteProposalResult(payload) {
  functionAreaRef.value?.applyBodyWriteProposalResult?.(payload)
}

async function navigateAgentReference(reference) {
  let target
  if (reference && typeof reference === 'object') {
    target = { type: reference.sourceType, targetId: reference.targetId, section: reference.section || '', line: reference.startLine || 0, endLine: reference.endLine || reference.startLine || 0 }
  } else {
    const match = /^(chapter|character|setting|outline|note):([^#@]+)(?:#([^@]*))?(?:@sha256:[a-f0-9]+)?$/i.exec(String(reference || '').trim())
    if (!match) return ElMessage.warning('这个来源引用无法识别')
    let targetId = match[2]
    try { targetId = decodeURIComponent(targetId) } catch { /* 保留原始 ID */ }
    const location = match[3] || ''
    const lines = /^L(\d+)(?:-(\d+))?$/i.exec(location)
    target = { type: match[1].toLowerCase(), targetId, section: lines ? '' : location, line: lines ? Number(lines[1]) : 0, endLine: lines ? Number(lines[2] || lines[1]) : 0 }
  }
  const routeName = { character: 'CharacterProfile', setting: 'SettingManager', outline: 'OutlineManager', note: 'QuickNotes', chapter: 'Editor' }[target.type]
  if (target.type === 'chapter') {
    const parts = target.targetId.replaceAll('\\', '/').split('/')
    window.sessionStorage.setItem(`51mazi.reference-jump:${bookName.value}`, JSON.stringify(target))
    await router.push({ name: routeName, query: { name: bookName.value, volumeName: parts.at(-2) || '', chapterName: parts.at(-1)?.replace(/\.txt$/i, '') || '', line: target.line || undefined } })
    await nextTick()
    const handled = await functionAreaRef.value?.openAgentReference?.(target)
    if (handled) window.sessionStorage.removeItem(`51mazi.reference-jump:${bookName.value}`)
    return
  }
  if (target.type !== 'note') window.sessionStorage.setItem(`51mazi.reference-jump:${bookName.value}`, JSON.stringify(target))
  await router.push({ name: routeName, query: { name: bookName.value, id: target.targetId, section: target.section || undefined, line: target.line || undefined } })
  await nextTick()
  const handled = await functionAreaRef.value?.openAgentReference?.(target)
  if (handled !== undefined) window.sessionStorage.removeItem(`51mazi.reference-jump:${bookName.value}`)
}

watch(bookName, () => readLayout(), { immediate: true })
watch(
  () => route.fullPath,
  () => {
    document.title = bookName.value ? `${bookName.value} - 51码字` : '51码字'
  },
  { immediate: true }
)

onMounted(() => {
  if (bookName.value) document.title = `${bookName.value} - 51码字`
})

onBeforeUnmount(() => {
  document.body.classList.remove('is-resizing-workspace')
})
</script>

<style lang="scss" scoped>
.book-workspace {
  position: relative;
  display: grid;
  width: 100vw;
  height: 100vh;
  min-width: 0;
  overflow: hidden;
  background: var(--bg-primary);
}

.book-workspace__left {
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.book-workspace__nav {
  flex: 0 0 150px;
  width: 150px;
  min-width: 150px;
  height: 100%;
  overflow: hidden;
  border-right: 1px solid var(--border-color);
}

.book-workspace__function-area {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.book-workspace__agent-dock {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-left: 1px solid var(--border-color);
}

.book-workspace__resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(v-bind('layoutRatio') * 1% - 4px);
  z-index: 20;
  width: 8px;
  padding: 0;
  cursor: col-resize;
  border: 0;
  background: transparent;

  &:hover,
  &:focus-visible {
    background: color-mix(in srgb, var(--el-color-primary) 18%, transparent);
    outline: none;
  }

  span {
    position: absolute;
    top: 50%;
    left: 2px;
    width: 4px;
    height: 42px;
    transform: translateY(-50%);
    border-radius: 4px;
    background: var(--border-color);
  }
}

:deep(.harness-sidebar) {
  border-left: 0;
}

:deep(.harness-sidebar.collapsed) {
  border-left: 0;
}
</style>
