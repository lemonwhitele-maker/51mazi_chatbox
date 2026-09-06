<template>
  <LayoutTool :title="t('quickNotes.title')" :show-refresh="false">
    <template #headrAction>
      <span class="save-status" :class="saveStatus">{{ saveStatusText }}</span>
      <el-button type="primary" :loading="saving" :disabled="loading" @click="saveNow">
        {{ t('quickNotes.save') }}
      </el-button>
    </template>

    <div class="quick-notes-page">
      <el-alert
        :title="t('quickNotes.privacyTitle')"
        :description="t('quickNotes.privacyDescription')"
        type="info"
        :closable="false"
        show-icon
      />
      <el-input
        v-model="content"
        class="quick-notes-editor"
        type="textarea"
        resize="none"
        :disabled="loading"
        :placeholder="t('quickNotes.placeholder')"
        @input="scheduleSave"
      />
      <div class="notes-footer">
        <span>{{ t('quickNotes.storageHint') }}</span>
        <span>{{ content.length.toLocaleString() }} {{ t('quickNotes.characters') }}</span>
      </div>
    </div>
  </LayoutTool>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import LayoutTool from '@renderer/components/LayoutTool.vue'

const { t } = useI18n()
const route = useRoute()
const bookName = computed(() => String(route.query.name || '').trim())
const content = ref('')
const loading = ref(true)
const saving = ref(false)
const saveStatus = ref('saved')
const savedHash = ref(null)
let saveTimer = null

const saveStatusText = computed(() => {
  if (saveStatus.value === 'saving') return t('quickNotes.saving')
  if (saveStatus.value === 'dirty') return t('quickNotes.unsaved')
  if (saveStatus.value === 'error') return t('quickNotes.saveFailed')
  return t('quickNotes.saved')
})

async function loadNotes() {
  loading.value = true
  try {
    const result = await window.electron.readHarnessQuickNotes(bookName.value)
    if (!result?.success) throw new Error(result?.message || t('quickNotes.loadFailed'))
    content.value = String(result.content || '')
    savedHash.value = result.contentHash || null
    saveStatus.value = 'saved'
  } catch (error) {
    saveStatus.value = 'error'
    ElMessage.error(error?.message || t('quickNotes.loadFailed'))
  } finally {
    loading.value = false
  }
}

function scheduleSave() {
  saveStatus.value = 'dirty'
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveNow(), 800)
}

async function saveNow() {
  if (!bookName.value || loading.value || saving.value) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  saving.value = true
  saveStatus.value = 'saving'
  try {
    const result = await window.electron.writeHarnessQuickNotes(bookName.value, content.value)
    if (!result?.success) throw new Error(result?.message || t('quickNotes.saveFailed'))
    savedHash.value = result.contentHash || null
    saveStatus.value = 'saved'
  } catch (error) {
    saveStatus.value = 'error'
    ElMessage.error(error?.message || t('quickNotes.saveFailed'))
  } finally {
    saving.value = false
  }
}

function handleQuickNotesChanged(event) {
  if (event?.detail?.bookName !== bookName.value) return
  if (saveStatus.value === 'dirty' || saving.value) {
    ElMessage.warning('Agent 已更新正式速记；当前未保存内容仍保留，请先核对后刷新')
    return
  }
  void loadNotes()
}

function getAgentContext() {
  return {
    currentModule: 'quick-notes',
    currentDocumentId: 'quick-notes',
    currentEntityId: 'quick-notes',
    currentDocumentSavedHash: savedHash.value,
    hasUnsavedChanges: saveStatus.value === 'dirty',
    metadata: { file_type: 'note', source_file: '.51mazi/notes/quick-notes.md' }
  }
}

function handleShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== 's') return
  event.preventDefault()
  void saveNow()
}

onMounted(() => {
  window.addEventListener('keydown', handleShortcut)
  window.addEventListener('quick-notes-changed', handleQuickNotesChanged)
  void loadNotes()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleShortcut)
  window.removeEventListener('quick-notes-changed', handleQuickNotesChanged)
  if (saveTimer) clearTimeout(saveTimer)
  if (saveStatus.value === 'dirty') void saveNow()
})

defineExpose({ getAgentContext })
</script>

<style lang="scss" scoped>
.quick-notes-page {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.quick-notes-editor {
  flex: 1;
  min-height: 260px;
}

.quick-notes-editor :deep(.el-textarea__inner) {
  height: 100%;
  min-height: 260px !important;
  padding: 18px;
  font-family: inherit;
  font-size: 15px;
  line-height: 1.75;
  color: var(--text-base);
  background: var(--bg-primary);
}

.save-status {
  margin-right: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.save-status.error,
.save-status.dirty {
  color: var(--el-color-warning);
}

.notes-footer {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
