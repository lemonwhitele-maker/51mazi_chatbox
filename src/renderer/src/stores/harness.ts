import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import harnessClient from '../service/harnessClient'

export const useHarnessStore = defineStore('harness', () => {
  const conversations = ref<any[]>([])
  const activeConversationId = ref<string | null>(null)
  const status = ref<'idle' | 'preparing' | 'model_running' | 'tool_running' | 'completed' | 'failed' | 'cancelled'>('idle')
  const streamingText = ref('')
  const loading = ref(false)
  let unsubscribe: (() => void) | null = null

  async function load(bookName: string) { conversations.value = await harnessClient.listConversations(bookName); if (!activeConversationId.value) activeConversationId.value = conversations.value[0]?.conversationId || null }
  async function create(bookName: string, title?: string, runtimeId: 'fake' | 'codex-app-server' = 'codex-app-server') { const item = await harnessClient.createConversation(bookName, title, runtimeId); conversations.value = [item, ...conversations.value]; activeConversationId.value = item.conversationId; return item }
  function subscribe() { unsubscribe?.(); unsubscribe = harnessClient.onEvent((event: any) => { if (!event || event.conversationId !== activeConversationId.value) return; if (event.type === 'turn.state') status.value = event.state; if (event.type === 'message.delta') streamingText.value += event.delta || ''; if (event.type === 'message.completed') streamingText.value = event.message?.text || streamingText.value }) }
  async function send(bookName: string, text: string, workspace: any = {}) { if (!activeConversationId.value) await create(bookName); streamingText.value = ''; loading.value = true; try { return await harnessClient.startTurn({ bookName, conversationId: activeConversationId.value, text, workspace }) } finally { loading.value = false } }
  async function cancel(bookName: string) { if (activeConversationId.value) await harnessClient.cancelTurn(bookName, activeConversationId.value) }
  const activeConversation = computed(() => conversations.value.find((item) => item.conversationId === activeConversationId.value) || null)
  return { conversations, activeConversationId, activeConversation, status, streamingText, loading, load, create, subscribe, send, cancel }
})
