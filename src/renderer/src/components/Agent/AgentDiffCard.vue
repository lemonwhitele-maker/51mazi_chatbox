<template>
  <section class="agent-diff-card" role="region" :aria-label="t('assistantDiff.diffTitle')">
    <header class="diff-header">
      <div>
        <strong>{{ t('assistantDiff.diffTitle') }}</strong>
        <span class="diff-subtitle">{{ t('assistantDiff.diffPending') }}</span>
      </div>
      <el-button text circle size="small" :aria-label="t('common.close')" @click="emit('reject')">
        <el-icon><Close /></el-icon>
      </el-button>
    </header>
    <div class="diff-columns">
      <div class="diff-pane diff-original">
        <div class="diff-label">− {{ t('assistantDiff.originalText') }}</div>
        <div class="diff-text">{{ diff.originalText }}</div>
      </div>
      <div class="diff-pane diff-replacement">
        <div class="diff-label">+ {{ t('assistantDiff.replacementText') }}</div>
        <div class="diff-text">{{ diff.replacementText }}</div>
      </div>
    </div>
    <footer class="diff-actions">
      <el-button size="small" @click="emit('reject')">{{ t('assistantDiff.reject') }}</el-button>
      <el-button type="success" size="small" @click="emit('accept')">
        {{ t('assistantDiff.accept') }}
      </el-button>
    </footer>
  </section>
</template>

<script setup>
import { Close } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'

defineProps({
  diff: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['accept', 'reject'])
const { t } = useI18n()
</script>

<style scoped>
.agent-diff-card {
  position: absolute;
  right: 154px;
  top: 12px;
  z-index: 12;
  width: min(620px, calc(100% - 190px));
  max-height: min(480px, calc(100% - 24px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  background: var(--bg-primary);
  box-shadow: var(--el-box-shadow-light);
}
.diff-header,
.diff-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-soft);
}
.diff-header {
  border-bottom: 1px solid var(--el-border-color);
}
.diff-subtitle {
  margin-left: 8px;
  color: var(--text-secondary);
  font-size: 12px;
}
.diff-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-height: 0;
  overflow: auto;
}
.diff-pane {
  min-width: 0;
  padding: 12px;
}
.diff-original {
  background: rgba(245, 108, 108, 0.1);
  border-right: 1px solid var(--el-border-color);
}
.diff-replacement {
  background: rgba(103, 194, 58, 0.1);
}
.diff-label {
  margin-bottom: 7px;
  font-size: 12px;
  font-weight: 700;
}
.diff-original .diff-label {
  color: var(--el-color-danger);
}
.diff-replacement .diff-label {
  color: var(--el-color-success);
}
.diff-text {
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.55;
}
.diff-original .diff-text {
  text-decoration: line-through;
  text-decoration-color: rgba(245, 108, 108, 0.55);
}
.diff-actions {
  justify-content: flex-end;
  border-top: 1px solid var(--el-border-color);
}
@media (max-width: 1200px) {
  .agent-diff-card {
    right: 12px;
    width: calc(100% - 24px);
  }
}
</style>
