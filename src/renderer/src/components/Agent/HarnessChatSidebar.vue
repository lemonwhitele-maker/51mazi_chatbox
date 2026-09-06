<template>
  <aside class="harness-sidebar" :class="{ collapsed }">
    <template v-if="collapsed">
      <button class="harness-collapsed-button" type="button" title="展开 51码字写作助手" @click="collapsed = false">H</button>
    </template>
    <template v-else>
      <header class="harness-header">
        <strong>51码字写作助手</strong>
        <button type="button" title="收起" @click="collapsed = true">收起</button>
      </header>
      <div class="harness-toolbar">
        <select :value="selectedConversationValue" :disabled="loading" @change="handleConversationSelection">
          <option v-if="draftConversation" :value="DRAFT_CONVERSATION_VALUE">新对话（未保存）</option>
          <option v-for="conversation in conversations" :key="conversation.conversationId" :value="conversation.conversationId">
            {{ conversation.title }}
          </option>
        </select>
        <button type="button" :disabled="loading" @click="beginNewConversation">新对话</button>
      </div>
      <div class="harness-preferences">
        <label>
          <span>模型</span>
          <select v-model="modelPreference" :disabled="loading || modelsLoading" @change="handleModelChange">
            <option value="codex-default">跟随默认通道</option>
            <option v-for="model in modelCatalog" :key="model.id" :value="model.id">{{ model.name }}</option>
          </select>
        </label>
        <label v-if="effortOptions.length">
          <span>推理强度</span>
          <select v-model="effortPreference" :disabled="loading || modelsLoading" @change="savePreferences">
            <option value="codex-default">跟随模型默认</option>
            <option v-for="effort in effortOptions" :key="effort" :value="effort">{{ effort }}</option>
          </select>
        </label>
        <small v-if="modelsUnavailable">模型目录暂时不可用，将跟随设置中的默认通道。</small>
      </div>
      <div class="harness-status">{{ statusText }}</div>
      <div class="harness-messages">
        <template v-for="item in timeline" :key="item.key">
          <div
            v-if="item.kind === 'message'"
            class="harness-message"
            :class="[item.value.role, item.value.delivery]"
            @copy="handleMessageCopy($event, item.value)"
          >
            <div class="harness-message-meta">
              <span class="harness-role">{{ item.value.role === 'user' ? '你' : '助手' }}</span>
              <button
                type="button"
                class="harness-message-copy"
                title="复制纯文本并保留换行"
                @click="copyMessage(item.value)"
              >
                {{ copiedMessageId === item.value.id ? '已复制' : '复制' }}
              </button>
            </div>
            <div class="harness-message-text">{{ displayMessageText(item.value) }}</div>
            <div v-if="item.value.role === 'assistant' && effectiveReferences(item.value).length" class="harness-references">
              <button v-for="reference in effectiveReferences(item.value)" :key="reference" type="button" :title="referenceTooltip(reference)" @click="emit('navigate-reference', referencePresentations[reference] || reference)">
                <span class="reference-icon">↗</span><span>{{ referenceLabel(reference) }}</span>
              </button>
            </div>
            <small v-if="item.value.delivery === 'sending'">正在发送……</small>
            <small v-else-if="item.value.delivery === 'failed'">发送失败，内容已保留</small>
          </div>
          <BodyWriteProposalCard
            v-else
            :proposal="item.value"
            :busy="turnRunning || busyProposalIds.has(item.value.proposalId)"
            @confirm="confirmProposal"
            @reject="rejectProposal"
            @copy="copyProposal"
            @undo="undoProposal"
          />
        </template>
        <div v-if="streamingText" class="harness-message assistant"><span class="harness-role">助手</span><div>{{ streamingText }}</div></div>
        <div v-if="!timeline.length && !streamingText" class="harness-empty">可以读取当前书籍资料，并对正文、人物、设定、大纲和速记提出修改；只有点击提案卡片确认后才会写入。</div>
      </div>
      <form class="harness-composer" @submit.prevent="send">
        <textarea
          v-model="draft"
          rows="3"
          placeholder="询问当前书籍资料……"
          :disabled="loading"
          @keydown="handleComposerKeydown"
          @compositionstart="isComposing = true"
          @compositionend="isComposing = false"
        />
        <small class="harness-input-hint">Enter 发送，Shift+Enter 换行</small>
        <div class="harness-actions">
          <button v-if="loading" type="button" @click="cancel">停止</button>
          <button v-else type="submit" :disabled="!draft.trim()">发送</button>
        </div>
      </form>
      <div v-if="errorMessage" class="harness-error">{{ errorMessage }}</div>
    </template>
  </aside>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import harnessClient, { normalizeHarnessWorkspaceContext } from '@renderer/service/harnessClient'
import { shouldSendOnComposerKeydown } from './chatComposer.js'
import BodyWriteProposalCard from './BodyWriteProposalCard.vue'
import { mergeHarnessTimeline } from './bodyWriteProposalUi.js'
import { copyMessagePlainText, setPlainTextClipboardEvent } from './messageClipboard.js'

const props = defineProps({
  bookName: { type: String, default: '' },
  workspaceContext: { type: Object, default: () => ({}) },
  getEditorContext: { type: Function, default: null },
  validateProposal: { type: Function, default: null }
})

const emit = defineEmits(['preview-proposal', 'clear-proposal-preview', 'proposal-content-applied', 'navigate-reference'])

const DRAFT_CONVERSATION_VALUE = '__draft_conversation__'
const collapsed = defineModel('collapsed', { type: Boolean, default: false })
const conversations = ref([])
const activeConversationId = ref(null)
const draftConversation = ref(false)
const messages = ref([])
const proposals = ref([])
const busyProposalIds = ref(new Set())
const draft = ref('')
const isComposing = ref(false)
const streamingText = ref('')
const status = ref('idle')
const errorMessage = ref('')
const loading = ref(false)
const modelsLoading = ref(false)
const modelsUnavailable = ref(false)
const modelCatalog = ref([])
const modelPreference = ref('codex-default')
const effortPreference = ref('codex-default')
const copiedMessageId = ref(null)
const referencePresentations = ref({})
let unsubscribe = null
let copiedMessageTimer = 0

const selectedConversationValue = computed(() => draftConversation.value ? DRAFT_CONVERSATION_VALUE : activeConversationId.value || '')
const statusText = computed(() => ({ idle: '就绪', preparing: '正在整理上下文', model_running: '正在生成', tool_requested: '正在调用资料工具', tool_running: '正在读取书籍资料', completed: '已完成', failed: '执行失败', error: '执行失败', cancelled: '已停止' })[status.value] || status.value)
const selectedModel = computed(() => modelCatalog.value.find((model) => model.id === modelPreference.value) || modelCatalog.value.find((model) => model.isDefault) || modelCatalog.value[0] || null)
const effortOptions = computed(() => selectedModel.value?.supportedReasoningEfforts || [])
const timeline = computed(() => mergeHarnessTimeline(messages.value, proposals.value))
const turnRunning = computed(() =>
  ['preparing', 'model_running', 'tool_requested', 'tool_running'].includes(status.value)
)
function referenceLabel(reference) {
  const resolved = referencePresentations.value[reference]
  if (resolved) return `${typeLabel(resolved.sourceType)} · ${resolved.title}${resolved.sectionTitle || resolved.section ? ` · ${resolved.sectionTitle || resolved.section}` : ''}`
  const match = /^(chapter|character|setting|outline|note):([^#@]+)(?:#([^@]*))?/i.exec(String(reference || ''))
  if (!match) return String(reference || '')
  const type = { chapter: '正文', character: '人物', setting: '设定', outline: '大纲', note: '速记' }[match[1].toLowerCase()]
  let id = match[2]
  try { id = decodeURIComponent(id) } catch { /* 保留原引用 */ }
  return `${type} · ${id.split('/').pop().replace(/\.txt$/i, '')}${match[3] ? ` · ${match[3]}` : ''}`
}
function typeLabel(type) { return ({ chapter: '正文', character: '人物', setting: '设定', outline: '大纲', note: '速记' })[type] || type }
function referenceTooltip(reference) {
  const item = referencePresentations.value[reference]
  if (!item) return '点击打开来源'
  const lines = item.startLine ? `第 ${item.startLine}${item.endLine > item.startLine ? `–${item.endLine}` : ''} 行` : '文档'
  return `点击打开 ${item.title} · ${lines}`
}
function referencesInText(text) {
  return String(text || '').match(/(?:chapter|character|setting|outline|note):[^#@\s，。；、）》】`'"<>]+(?:#[^@\s，。；、）》】`'"<>]+)?(?:@sha256:[a-f0-9]+)?/gi) || []
}
function effectiveReferences(message) {
  return [...new Set([...(message?.references || []), ...referencesInText(message?.text)])]
}
function displayMessageText(message) {
  let text = String(message?.text || '')
  for (const reference of effectiveReferences(message)) {
    const label = referenceLabel(reference)
    text = text.split(reference).join(`〔${label}〕`)
  }
  return text
}
async function hydrateReferences(items = messages.value) {
  const references = [...new Set(items.flatMap((item) => effectiveReferences(item)))].filter((item) => !referencePresentations.value[item])
  if (!references.length || !props.bookName) return
  const resolved = await Promise.all(references.map(async (reference) => {
    try {
      const result = await window.electron.resolveKnowledgeReference(props.bookName, reference)
      return result?.success ? [reference, result.resolved] : null
    } catch { return null }
  }))
  referencePresentations.value = { ...referencePresentations.value, ...Object.fromEntries(resolved.filter(Boolean)) }
}

function normalizeEffort(value) {
  if (typeof value === 'string') return value.trim()
  return String(value?.reasoningEffort || value?.reasoning_effort || '').trim()
}

function normalizeModel(model) {
  const id = String(model?.id || model?.model || '').trim()
  if (!id) return null
  const rawEfforts = model.supportedReasoningEfforts || model.supported_reasoning_efforts || []
  return {
    id,
    name: String(model.displayName || model.display_name || model.name || id),
    isDefault: Boolean(model.isDefault ?? model.is_default),
    defaultReasoningEffort: normalizeEffort(model.defaultReasoningEffort || model.default_reasoning_effort),
    supportedReasoningEfforts: Array.isArray(rawEfforts) ? rawEfforts.map(normalizeEffort).filter(Boolean) : []
  }
}

function modelOverride() { return modelPreference.value === 'codex-default' ? null : modelPreference.value }
function effortOverride() { return effortPreference.value === 'codex-default' ? null : effortPreference.value }

function applyConversationPreferences(conversation) {
  modelPreference.value = conversation?.modelPreference || 'codex-default'
  effortPreference.value = conversation?.effortPreference || 'codex-default'
  if (modelPreference.value !== 'codex-default' && modelCatalog.value.length && !modelCatalog.value.some((model) => model.id === modelPreference.value)) modelPreference.value = 'codex-default'
  if (effortPreference.value !== 'codex-default' && !effortOptions.value.includes(effortPreference.value)) effortPreference.value = 'codex-default'
}

async function loadModels() {
  modelsLoading.value = true
  try {
    const result = await harnessClient.listModels()
    const source = Array.isArray(result) ? result : result?.models || result?.data?.models || result?.data || []
    modelCatalog.value = source.map(normalizeModel).filter(Boolean)
    modelsUnavailable.value = !modelCatalog.value.length
    if (modelPreference.value !== 'codex-default' && !modelCatalog.value.some((model) => model.id === modelPreference.value)) modelPreference.value = 'codex-default'
    if (effortPreference.value !== 'codex-default' && !effortOptions.value.includes(effortPreference.value)) effortPreference.value = 'codex-default'
  } catch {
    modelCatalog.value = []
    modelsUnavailable.value = true
    modelPreference.value = 'codex-default'
    effortPreference.value = 'codex-default'
  } finally {
    modelsLoading.value = false
  }
}

async function loadConversations() {
  if (!props.bookName) { conversations.value = []; activeConversationId.value = null; draftConversation.value = false; messages.value = []; proposals.value = []; return }
  conversations.value = await harnessClient.listConversations(props.bookName)
  const activeStillExists = conversations.value.some((item) => item.conversationId === activeConversationId.value)
  if (!draftConversation.value && !activeStillExists) {
    if (conversations.value[0]) {
      applyConversationPreferences(conversations.value[0])
      activeConversationId.value = conversations.value[0].conversationId
    }
    else {
      draftConversation.value = true
      activeConversationId.value = null
      messages.value = []
    }
  }
}

async function loadMessages() {
  if (!props.bookName || !activeConversationId.value) { messages.value = []; proposals.value = []; return }
  const [data, restoredProposals] = await Promise.all([
    harnessClient.readConversation(props.bookName, activeConversationId.value),
    harnessClient.listWriteProposals(props.bookName, activeConversationId.value)
  ])
  messages.value = data.transcript.filter((item) => item.type === 'message.user' || item.type === 'message.assistant').map((item) => ({ id: item.messageId || item.eventId, role: item.type === 'message.user' ? 'user' : 'assistant', text: item.payload?.text || '', references: item.payload?.references || [], delivery: 'sent', createdAt: item.createdAt || '' }))
  void hydrateReferences(messages.value)
  proposals.value = restoredProposals
  const preview = [...restoredProposals].reverse().find((item) => item.status === 'pending')
  if (preview?.proposalType !== 'knowledge') emit('preview-proposal', preview)
  else emit('clear-proposal-preview')
  streamingText.value = ''
  status.value = data.state.status === 'running' ? 'idle' : data.state.status
  modelPreference.value = data.state.modelPreference || 'codex-default'
  effortPreference.value = data.state.effortPreference || 'codex-default'
  if (modelPreference.value !== 'codex-default' && modelCatalog.value.length && !modelCatalog.value.some((model) => model.id === modelPreference.value)) modelPreference.value = 'codex-default'
  if (effortPreference.value !== 'codex-default' && !effortOptions.value.includes(effortPreference.value)) effortPreference.value = 'codex-default'
}

function beginNewConversation() {
  if (loading.value) return
  draftConversation.value = true
  activeConversationId.value = null
  messages.value = []
  proposals.value = []
  streamingText.value = ''
  status.value = 'idle'
  errorMessage.value = ''
}

function handleConversationSelection(event) {
  const value = event?.target?.value || ''
  if (!value || value === DRAFT_CONVERSATION_VALUE) return
  draftConversation.value = false
  applyConversationPreferences(conversations.value.find((item) => item.conversationId === value))
  activeConversationId.value = value
  streamingText.value = ''
  errorMessage.value = ''
  void loadMessages()
}

function localConversationTitle(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 18).replace(/[，。！？!?；;：:,.…\s]+$/g, '')
  return value || '新对话'
}

async function savePreferences() {
  if (!props.bookName || !activeConversationId.value) return
  try {
    const updated = await harnessClient.updateConversationSettings(props.bookName, activeConversationId.value, modelOverride(), effortOverride(), 'agent-router')
    const index = conversations.value.findIndex((item) => item.conversationId === activeConversationId.value)
    if (index >= 0) conversations.value[index] = { ...conversations.value[index], ...updated }
  } catch (error) {
    errorMessage.value = error?.message || '模型设置保存失败'
  }
}

function handleModelChange() {
  effortPreference.value = 'codex-default'
  void savePreferences()
}

async function send() {
  if (!draft.value.trim() || loading.value) return
  const text = draft.value.trim()
  const localMessageId = `local-user-${Date.now()}`
  draft.value = ''
  streamingText.value = ''
  errorMessage.value = ''
  loading.value = true
  messages.value = [...messages.value, { id: localMessageId, role: 'user', text, delivery: 'sending', createdAt: new Date().toISOString() }]
  try {
    if (!activeConversationId.value) {
      const item = await harnessClient.createConversation(
        props.bookName,
        localConversationTitle(text),
        'agent-router',
        { model: modelOverride(), effort: effortOverride(), autoTitle: true }
      )
      conversations.value = [item, ...conversations.value.filter((entry) => entry.conversationId !== item.conversationId)]
      activeConversationId.value = item.conversationId
      draftConversation.value = false
    }
    await harnessClient.startTurn({ bookName: props.bookName, conversationId: activeConversationId.value, text, workspace: normalizeHarnessWorkspaceContext({ ...props.workspaceContext, ...(props.getEditorContext?.('selection') || {}) }), model: modelOverride(), effort: effortOverride() })
    await loadMessages()
    await loadConversations()
  } catch (error) {
    errorMessage.value = error?.message || 'Harness 执行失败'
    status.value = 'failed'
    const index = messages.value.findIndex((item) => item.id === localMessageId)
    if (index >= 0) messages.value[index] = { ...messages.value[index], delivery: 'failed' }
    if (!activeConversationId.value) {
      messages.value = messages.value.filter((item) => item.id !== localMessageId)
      draft.value = text
      draftConversation.value = true
    }
  } finally { loading.value = false }
}

function handleComposerKeydown(event) {
  if (!shouldSendOnComposerKeydown(event, {
    draft: draft.value,
    loading: loading.value,
    composing: isComposing.value
  })) return
  event.preventDefault()
  void send()
}

async function cancel() { if (activeConversationId.value) await harnessClient.cancelTurn(props.bookName, activeConversationId.value) }

function setProposalBusy(proposalId, busy) {
  const next = new Set(busyProposalIds.value)
  if (busy) next.add(proposalId)
  else next.delete(proposalId)
  busyProposalIds.value = next
}

function upsertProposal(proposal) {
  if (!proposal?.proposalId) return
  const index = proposals.value.findIndex((item) => item.proposalId === proposal.proposalId)
  if (index >= 0) proposals.value[index] = proposal
  else proposals.value = [...proposals.value, proposal]
}

async function confirmProposal(proposal) {
  if (!proposal || turnRunning.value || busyProposalIds.value.has(proposal.proposalId)) return
  errorMessage.value = ''
  const check = proposal.proposalType === 'knowledge' ? null : await props.validateProposal?.(proposal)
  if (check && check.ok === false) {
    errorMessage.value = check.message || '当前正文与提案目标不一致，请重新生成提案'
    if (check.code !== 'WRITE_PROPOSAL_CONTENT_STALE') return
  }
  setProposalBusy(proposal.proposalId, true)
  try {
    const result = await harnessClient.applyWriteProposal(
      props.bookName,
      activeConversationId.value,
      proposal.proposalId
    )
    upsertProposal(result.proposal)
    emit('clear-proposal-preview', proposal.proposalId)
    if (result.proposal?.proposalType === 'knowledge') notifyKnowledgeProposalApplied(result.proposal)
    else emit('proposal-content-applied', { proposal: result.proposal, result })
  } catch (error) {
    errorMessage.value = error?.message || '写入未保存，正式资料保持原内容，请重试'
    await loadMessages().catch(() => {})
  } finally {
    setProposalBusy(proposal.proposalId, false)
  }
}

async function rejectProposal(proposal) {
  if (!proposal || busyProposalIds.value.has(proposal.proposalId)) return
  setProposalBusy(proposal.proposalId, true)
  try {
    const updated = await harnessClient.rejectWriteProposal(
      props.bookName,
      activeConversationId.value,
      proposal.proposalId
    )
    upsertProposal(updated)
    emit('clear-proposal-preview', proposal.proposalId)
  } catch (error) {
    errorMessage.value = error?.message || '取消提案失败'
  } finally {
    setProposalBusy(proposal.proposalId, false)
  }
}

async function copyProposal(proposal) {
  try {
    await navigator.clipboard.writeText(proposal.proposedText || proposal.preview?.after || '')
  } catch {
    errorMessage.value = '复制失败，请手动选择建议文本'
  }
}

function handleMessageCopy(event, message) {
  const selectedText = window.getSelection?.()?.toString() || ''
  setPlainTextClipboardEvent(event, selectedText || message?.text || '')
}

async function copyMessage(message) {
  try {
    await copyMessagePlainText(message?.text || '')
    copiedMessageId.value = message?.id || null
    window.clearTimeout(copiedMessageTimer)
    copiedMessageTimer = window.setTimeout(() => {
      copiedMessageId.value = null
    }, 1400)
  } catch {
    errorMessage.value = '复制失败，请手动选择消息文本'
  }
}

async function undoProposal(proposal) {
  if (!proposal || busyProposalIds.value.has(proposal.proposalId)) return
  setProposalBusy(proposal.proposalId, true)
  errorMessage.value = ''
  try {
    const result = await harnessClient.undoWriteProposal(
      props.bookName,
      activeConversationId.value,
      proposal.proposalId
    )
    upsertProposal(result.proposal)
    if (result.proposal?.proposalType === 'knowledge') notifyKnowledgeProposalApplied(result.proposal)
    else emit('proposal-content-applied', { proposal: result.proposal, result })
  } catch (error) {
    errorMessage.value = error?.message || '正式资料已变化，无法安全撤销'
    await loadMessages().catch(() => {})
  } finally {
    setProposalBusy(proposal.proposalId, false)
  }
}

function notifyKnowledgeProposalApplied(proposal) {
  if (proposal.target?.type === 'note') {
    window.dispatchEvent(new CustomEvent('quick-notes-changed', { detail: { bookName: props.bookName } }))
    return
  }
  window.dispatchEvent(new CustomEvent('knowledge-documents-changed', {
    detail: {
      bookName: props.bookName,
      scope: proposal.target?.scope,
      documentId: proposal.target?.documentId
    }
  }))
}

function handleEvent(event) {
  if (event?.type === 'conversation.updated') {
    const next = event.conversation
    const index = conversations.value.findIndex((item) => item.conversationId === next?.conversationId)
    if (index >= 0) conversations.value[index] = { ...conversations.value[index], ...next }
    return
  }
  if (event?.conversationId !== activeConversationId.value) return
  if (event.type === 'write.proposal.created' || event.type === 'write.proposal.updated') {
    upsertProposal(event.proposal)
    if (event.proposal?.status === 'pending' && event.proposal?.proposalType !== 'knowledge') emit('preview-proposal', event.proposal)
    else emit('clear-proposal-preview', event.proposalId)
    return
  }
  if (event.type === 'turn.state') status.value = event.state
  if (event.type === 'message.delta') streamingText.value += event.delta || ''
  if (event.type === 'message.completed') streamingText.value = event.message?.text || streamingText.value
  if (event.type === 'turn.error') errorMessage.value = event.message || 'Harness 执行失败'
}

function handleAgentConfigChanged() {
  void loadModels()
}

watch(() => props.bookName, () => {
  activeConversationId.value = null
  draftConversation.value = false
  messages.value = []
  proposals.value = []
  modelPreference.value = 'codex-default'
  effortPreference.value = 'codex-default'
  void loadConversations()
}, { immediate: true })
watch(activeConversationId, () => { if (!loading.value && !draftConversation.value) void loadMessages() })
onMounted(() => {
  unsubscribe = harnessClient.onEvent(handleEvent)
  window.addEventListener('agent-api-config-changed', handleAgentConfigChanged)
  void loadModels()
})
onBeforeUnmount(() => {
  unsubscribe?.()
  window.removeEventListener('agent-api-config-changed', handleAgentConfigChanged)
  window.clearTimeout(copiedMessageTimer)
})
</script>

<style scoped>
.harness-sidebar { display: flex; flex-direction: column; height: 100%; min-width: 0; background: var(--el-bg-color); color: var(--el-text-color-primary); }
.harness-sidebar.collapsed { align-items: center; justify-content: flex-start; padding-top: 18px; }
.harness-collapsed-button, .harness-header button, .harness-toolbar button, .harness-actions button { border: 1px solid var(--el-border-color); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; padding: 4px 8px; }
.harness-header, .harness-toolbar, .harness-actions { display: flex; align-items: center; gap: 8px; padding: 10px; }
.harness-header { justify-content: space-between; border-bottom: 1px solid var(--el-border-color-lighter); }
.harness-toolbar select { min-width: 0; flex: 1; }
.harness-preferences { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; padding: 0 10px 8px; }
.harness-preferences label { display: grid; gap: 4px; min-width: 0; color: var(--el-text-color-secondary); font-size: 12px; }
.harness-preferences select { min-width: 0; width: 100%; }
.harness-preferences small { grid-column: 1 / -1; color: var(--el-text-color-secondary); }
.harness-status { padding: 0 10px 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.harness-messages { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px; }
.harness-message { margin-bottom: 12px; line-height: 1.5; word-break: break-word; }
.harness-message.user { color: var(--el-color-primary); }
.harness-message.sending { opacity: 0.78; }
.harness-message.failed small { color: var(--el-color-danger); }
.harness-message small { display: block; margin-top: 3px; color: var(--el-text-color-secondary); font-size: 11px; }
.harness-message-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 2px; }
.harness-role { display: block; font-size: 11px; color: var(--el-text-color-secondary); }
.harness-message-copy { border: 0; padding: 1px 3px; background: transparent; color: var(--el-text-color-secondary); cursor: pointer; font-size: 11px; opacity: 0.65; }
.harness-message-copy:hover { color: var(--el-color-primary); opacity: 1; }
.harness-message-text { white-space: pre-wrap; }
.harness-references { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.harness-references button { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid color-mix(in srgb, var(--el-color-primary) 38%, var(--el-border-color)); border-radius: 999px; padding: 4px 9px; background: color-mix(in srgb, var(--el-color-primary) 8%, var(--el-bg-color)); color: var(--el-color-primary); cursor: pointer; font-size: 11px; transition: 0.16s ease; }
.harness-references button:hover { transform: translateY(-1px); border-color: var(--el-color-primary); background: color-mix(in srgb, var(--el-color-primary) 14%, var(--el-bg-color)); box-shadow: 0 3px 9px color-mix(in srgb, var(--el-color-primary) 18%, transparent); }
.reference-icon { font-size: 12px; font-weight: 700; }
.harness-empty { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }
.harness-composer { padding: 10px; border-top: 1px solid var(--el-border-color-lighter); }
.harness-composer textarea { box-sizing: border-box; width: 100%; resize: vertical; border: 1px solid var(--el-border-color); border-radius: 6px; padding: 8px; background: transparent; color: inherit; }
.harness-input-hint { display: block; margin-top: 4px; color: var(--el-text-color-secondary); font-size: 11px; }
.harness-actions { justify-content: flex-end; padding: 8px 0 0; }
.harness-error { padding: 0 10px 10px; color: var(--el-color-danger); font-size: 12px; }
</style>
