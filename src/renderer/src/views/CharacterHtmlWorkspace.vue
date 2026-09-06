<template>
  <KnowledgeDocumentWorkspace ref="workspaceRef" :book-name="bookName" scope="characters" />
</template>

<script setup>
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import KnowledgeDocumentWorkspace from '@renderer/components/Knowledge/KnowledgeDocumentWorkspace.vue'

defineOptions({ name: 'CharacterHtmlWorkspace' })

const route = useRoute()
const workspaceRef = ref(null)
const bookName = computed(() => String(route.query.name || '').trim())

defineExpose({
  getAgentContext: (mode) => workspaceRef.value?.getAgentContext?.(mode),
  openAgentReference: (target) => workspaceRef.value?.openDocument?.(target.targetId, target)
})
</script>
