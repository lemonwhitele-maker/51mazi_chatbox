<template>
  <div class="knowledge-workspace">
    <section v-if="!editing" class="document-index">
      <header class="index-header">
        <div>
          <span class="eyebrow">{{ config.eyebrow }}</span>
          <h2>{{ config.title }}</h2>
          <p>{{ config.description }}</p>
        </div>
        <div class="header-actions">
          <el-button :loading="loadingHealth" @click="openIndexHealth">
            <el-icon><Warning /></el-icon>索引诊断
          </el-button>
          <el-button :loading="loadingDocuments" @click="loadDocuments">
            <el-icon><Refresh /></el-icon>刷新
          </el-button>
          <el-button type="primary" @click="createDocument">
            <el-icon><Plus /></el-icon>新建{{ config.singular }}
          </el-button>
        </div>
      </header>

      <div class="filter-bar">
        <el-input
          v-model="query"
          clearable
          class="query-input"
          :placeholder="`搜索标题、别名、标签或 ID`"
          :prefix-icon="Search"
        />
        <el-select
          v-if="scope === 'settings'"
          v-model="kindFilter"
          clearable
          placeholder="全部 kind"
        >
          <el-option v-for="kind in kinds" :key="kind" :label="kind" :value="kind" />
        </el-select>
        <el-select v-model="tagFilter" clearable filterable placeholder="全部标签">
          <el-option v-for="tag in availableTags" :key="tag" :label="tag" :value="tag" />
        </el-select>
        <span class="document-count">{{ filteredDocuments.length }} / {{ documents.length }}</span>
      </div>

      <div v-if="scope === 'outlines'" class="derived-view-tabs">
        <button
          v-for="item in outlineViews"
          :key="item.value"
          type="button"
          :class="{ active: outlineView === item.value }"
          @click="outlineView = item.value"
        >
          {{ item.label }}
        </button>
        <span>派生视图只读取 frontmatter，不会改写大纲。</span>
      </div>

      <el-empty
        v-if="!filteredDocuments.length && !loadingDocuments"
        :description="documents.length ? '没有符合筛选条件的文档' : `还没有${config.singular}文档`"
      />
      <div v-else-if="scope !== 'outlines' || outlineView === 'order'" class="document-grid">
        <button
          v-for="document in filteredDocuments"
          :key="document.targetId"
          type="button"
          class="document-card"
          @click="openDocument(document.targetId)"
        >
          <div class="card-topline">
            <el-tag size="small" effect="plain">{{ document.kind || document.sourceType }}</el-tag>
            <span v-if="scope === 'outlines'">order {{ document.order ?? '—' }}</span>
            <span v-else>{{ document.status || 'draft' }}</span>
          </div>
          <div class="card-identity">
            <el-avatar
              v-if="scope === 'characters'"
              :size="48"
              :src="avatarSrc(document.avatar)"
              shape="square"
            >
              {{ (document.title || '人').slice(0, 1) }}
            </el-avatar>
            <h3>{{ document.title || document.targetId }}</h3>
          </div>
          <p class="document-id">{{ document.targetId }}</p>
          <div v-if="document.aliases?.length" class="aliases">
            别名：{{ document.aliases.join('、') }}
          </div>
          <div class="tag-list">
            <span v-for="tag in document.tags?.slice(0, 5)" :key="tag">#{{ tag }}</span>
          </div>
          <footer>
            <span>{{ document.sections?.length || 0 }} sections</span>
            <span>{{ formatDate(document.savedAt) }}</span>
          </footer>
        </button>
      </div>
      <div v-else-if="outlineView === 'tags'" class="derived-groups">
        <section v-for="group in outlinesByTag" :key="group.key" class="derived-group">
          <header>
            <strong>#{{ group.label }}</strong
            ><span>{{ group.items.length }} 项</span>
          </header>
          <button
            v-for="document in group.items"
            :key="document.targetId"
            type="button"
            @click="openDocument(document.targetId)"
          >
            <span class="order-badge">{{ document.order ?? '—' }}</span
            ><strong>{{ document.title }}</strong
            ><small>{{ document.targetId }}</small>
          </button>
        </section>
      </div>
      <div v-else class="chapter-map">
        <section v-for="group in outlinesByChapter" :key="group.key" class="chapter-map-row">
          <header>
            <strong>{{ group.label }}</strong
            ><span>{{ group.items.length }} 个大纲</span>
          </header>
          <button
            v-for="document in group.items"
            :key="document.targetId"
            type="button"
            @click="openDocument(document.targetId)"
          >
            <span class="order-badge">{{ document.order ?? '—' }}</span
            ><strong>{{ document.title }}</strong
            ><small>{{ document.tags?.map((tag) => `#${tag}`).join(' ') || '无标签' }}</small>
          </button>
        </section>
      </div>
    </section>

    <section v-else class="document-editor">
      <header class="editor-header">
        <div class="editor-title">
          <el-button circle text :icon="ArrowLeft" @click="closeEditor" />
          <div>
            <span class="eyebrow">{{ config.singular }} Markdown</span>
            <h2>{{ currentMetadata.title || currentDocument?.id }}</h2>
          </div>
        </div>
        <div class="header-actions">
          <span class="save-state" :class="{ invalid: !validation.valid }">
            <el-icon v-if="validation.valid"><CircleCheck /></el-icon>
            <el-icon v-else><Warning /></el-icon>
            {{ validation.valid ? (dirty ? '有未保存修改' : '已保存') : '需要修复校验问题' }}
          </span>
          <el-button @click="reloadFromDisk">从磁盘重载</el-button>
          <el-button :disabled="!lastUndoToken" @click="undoLastSave">撤销上次保存</el-button>
          <el-button
            :loading="saving"
            :disabled="!dirty || !validation.valid"
            type="primary"
            @click="saveDocument"
          >
            保存正式版本
          </el-button>
        </div>
      </header>

      <div class="editor-layout">
        <aside class="section-nav">
          <div v-if="scope === 'characters'" class="character-avatar-control">
            <el-image
              v-if="currentMetadata.avatar"
              :src="avatarSrc(currentMetadata.avatar)"
              fit="contain"
              class="character-avatar-preview"
              :preview-src-list="[avatarSrc(currentMetadata.avatar)]"
            />
            <div v-else class="character-avatar-empty">尚未设置人物头像</div>
            <el-button :disabled="saving || !validation.valid" @click="openCharacterImage"
              >生成头像</el-button
            >
            <small>使用图片时会一并保存当前人物文字。</small>
          </div>
          <div class="aside-title">稳定 sections</div>
          <button
            v-for="section in validationSections"
            :key="`${section.key}-${section.startLine}`"
            type="button"
            @click="jumpToLine(section.startLine)"
          >
            <strong>{{ section.title || section.key }}</strong>
            <span>{{ section.key }} · L{{ section.startLine }}–{{ section.endLine }}</span>
          </button>
          <div class="aside-tip">
            普通 Markdown 标题和未知 frontmatter 字段会原样保留。程序只依赖
            <code>51:section</code> 标记定位强制区块。
          </div>
        </aside>

        <main class="source-pane">
          <div class="source-meta">
            <span>{{ currentDocument?.path }}</span>
            <span>{{ shortHash(currentDocument?.fileHash) }}</span>
          </div>
          <textarea
            ref="sourceEditor"
            v-model="source"
            :class="{ 'reference-target-flash': referenceTargetFlash }"
            spellcheck="false"
            aria-label="知识文档 Markdown 源码"
            @input="handleSourceInput"
            @select="captureSelection"
            @keyup="captureSelection"
            @click="captureSelection"
          ></textarea>
          <div class="source-footer">
            <span>{{ source.length }} 字符 · 选区 {{ selectionStart }}–{{ selectionEnd }}</span>
            <span>外部编辑后点击刷新或重新打开即可识别</span>
          </div>
        </main>

        <aside class="validation-pane">
          <div class="aside-title">元数据与诊断</div>
          <dl class="metadata-list">
            <template v-for="(value, key) in currentMetadata" :key="key">
              <dt>{{ key }}</dt>
              <dd>{{ formatMetadata(value) }}</dd>
            </template>
          </dl>
          <div v-if="validation.diagnostics?.length" class="diagnostics">
            <div
              v-for="(item, index) in validation.diagnostics"
              :key="`${item.code}-${index}`"
              :class="item.severity"
            >
              <strong>{{ item.code }}</strong>
              <span>{{ item.message }}</span>
            </div>
          </div>
          <div v-else class="valid-note">文档结构有效，可以正式保存。</div>
        </aside>
      </div>
    </section>

    <AICharacterDrawer
      v-if="scope === 'characters'"
      v-model="characterImageVisible"
      :book-name="bookName"
      :character-name="currentMetadata.title || currentDocument?.id || ''"
      :appearance="characterAppearance"
      :confirm-image="saveCharacterAvatar"
      drawer-title="生成人物头像"
      confirm-button-text="使用图片并保存人物"
      confirm-success-message="人物头像与文字已保存"
    />

    <el-drawer v-model="healthVisible" title="索引健康与诊断" size="min(680px, 92vw)">
      <div v-if="indexHealth" class="index-health">
        <div class="health-summary">
          <div>
            <strong>{{ indexHealth.stats.files }}</strong
            ><span>已索引文件</span>
          </div>
          <div>
            <strong>{{ indexHealth.pendingFiles }}</strong
            ><span>待更新</span>
          </div>
          <div class="danger">
            <strong>{{ indexHealth.stats.errors }}</strong
            ><span>错误</span>
          </div>
          <div class="warning">
            <strong>{{ indexHealth.stats.dangling }}</strong
            ><span>悬空引用</span>
          </div>
        </div>
        <div class="health-actions">
          <span>最近索引：{{ formatDate(indexHealth.generatedAt) }}</span>
          <el-button type="primary" :loading="rebuildingIndex" @click="rebuildIndex"
            >重建索引</el-button
          >
        </div>
        <el-alert
          v-if="!indexHealth.diagnostics.length"
          type="success"
          :closable="false"
          title="索引健康，未发现结构或引用问题"
        />
        <div v-else class="health-diagnostics">
          <button
            v-for="(item, index) in indexHealth.diagnostics"
            :key="`${item.code}-${index}`"
            type="button"
            :class="item.severity"
            @click="openDiagnostic(item)"
          >
            <strong>{{ diagnosticTitle(item) }}</strong>
            <span>{{ item.message || diagnosticAdvice(item) }}</span>
            <small
              >{{ item.path || item.source?.path || item.scope }} ·
              {{ diagnosticAdvice(item) }}</small
            >
          </button>
        </div>
      </div>
      <el-empty v-else-if="!loadingHealth" description="暂时无法读取索引状态" />
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, CircleCheck, Plus, Refresh, Search, Warning } from '@element-plus/icons-vue'
import AICharacterDrawer from '@renderer/components/AICharacterDrawer.vue'
import { getAvatarSrc } from '@renderer/utils/characterAvatar'

const props = defineProps({
  bookName: { type: String, required: true },
  scope: {
    type: String,
    required: true,
    validator: (value) => ['characters', 'settings', 'outlines'].includes(value)
  }
})

const CONFIG = {
  characters: {
    eyebrow: 'Characters',
    title: '人物知识文档',
    singular: '人物',
    description: '一个人物一份 Markdown；核心定位、当前状态和已确认事实使用稳定 section。'
  },
  settings: {
    eyebrow: 'Settings',
    title: '设定知识文档',
    singular: '设定',
    description: '列表、kind 与标签只是视图；每个设定项都是可自由扩展的 Markdown 文档。'
  },
  outlines: {
    eyebrow: 'Outlines',
    title: '统一大纲文档',
    singular: '大纲',
    description: '所有大纲都使用同一个 outline schema，层级由关联、章节引用、标签和排序派生。'
  }
}

const config = computed(() => CONFIG[props.scope])
const KNOWLEDGE_DOCUMENTS_CHANGED_EVENT = 'knowledge-documents-changed'
const workspaceEventSource = crypto.randomUUID()
const loadingDocuments = ref(false)
const documents = ref([])
const query = ref('')
const kindFilter = ref('')
const tagFilter = ref('')
const outlineView = ref('order')
const outlineViews = [
  { value: 'order', label: '按顺序' },
  { value: 'tags', label: '按标签' },
  { value: 'chapters', label: '正文映射' }
]
const healthVisible = ref(false)
const loadingHealth = ref(false)
const rebuildingIndex = ref(false)
const indexHealth = ref(null)
const editing = ref(false)
const currentDocument = ref(null)
const source = ref('')
const savedSource = ref('')
const validation = ref({ valid: false, diagnostics: [] })
const validationSections = ref([])
const saving = ref(false)
const lastUndoToken = ref('')
const lastSavedHash = ref('')
const sourceEditor = ref(null)
const selectionStart = ref(0)
const selectionEnd = ref(0)
const referenceTargetFlash = ref(false)
const booksDir = ref('')
const characterImageVisible = ref(false)
const characterAppearance = ref('')
let validationTimer = 0
let draftTimer = 0
let referenceFlashTimer = 0

const dirty = computed(() => source.value !== savedSource.value)
const currentMetadata = computed(
  () => validation.value.metadata || currentDocument.value?.metadata || {}
)
function avatarSrc(path) {
  return getAvatarSrc(path, booksDir.value, props.bookName)
}

async function loadBooksDir() {
  booksDir.value = (await window.electronStore.get('booksDir')) || ''
}

async function openCharacterImage() {
  await validateSource()
  if (!validation.value.valid) return ElMessage.warning('请先修复文档校验问题')
  const metadata = currentMetadata.value
  const summary = validationSections.value.find((item) => item.key === 'summary')
  const summaryText = summary
    ? source.value
        .split(/\r\n|\n|\r/)
        .slice(summary.startLine, summary.endLine)
        .join('\n')
    : ''
  characterAppearance.value = String(metadata.appearance || summaryText || metadata.title || '')
    .trim()
    .slice(0, 1000)
  characterImageVisible.value = true
}

async function saveCharacterAvatar(image) {
  if (!currentDocument.value || saving.value) throw new Error('当前人物暂时无法保存，请稍后重试')
  await validateSource()
  if (!validation.value.valid) throw new Error('请先修复人物文档校验问题，候选图片已保留')
  saving.value = true
  try {
    const result = await window.electron.writeCharacterAvatar(
      props.bookName,
      currentDocument.value.id,
      source.value,
      currentDocument.value.fileHash,
      image.relativePath
    )
    if (!result?.success) {
      persistLocalDraft()
      if (result?.code === 'KNOWLEDGE_DOCUMENT_VERSION_CONFLICT') {
        throw new Error('文件已被外部修改。当前文字和候选图片已保留，请核对磁盘内容后再保存。')
      }
      throw new Error(result?.message || '人物保存失败，文字和候选图片已保留')
    }
    await applySavedDocument(result)
  } finally {
    saving.value = false
  }
}
const kinds = computed(() =>
  [...new Set(documents.value.map((item) => item.kind).filter(Boolean))].sort()
)
const availableTags = computed(() =>
  [...new Set(documents.value.flatMap((item) => item.tags || []))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN')
  )
)
const filteredDocuments = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase('zh-CN')
  return documents.value
    .filter((item) => !kindFilter.value || item.kind === kindFilter.value)
    .filter((item) => !tagFilter.value || item.tags?.includes(tagFilter.value))
    .filter((item) => {
      if (!needle) return true
      return [item.targetId, item.title, item.kind, ...(item.aliases || []), ...(item.tags || [])]
        .join('\n')
        .toLocaleLowerCase('zh-CN')
        .includes(needle)
    })
    .sort((a, b) => {
      if (props.scope === 'outlines') {
        const orderA = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER
        const orderB = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER
        if (orderA !== orderB) return orderA - orderB
      }
      return String(a.title).localeCompare(String(b.title), 'zh-CN')
    })
})
const outlinesByTag = computed(() => {
  const groups = new Map()
  for (const document of filteredDocuments.value) {
    const tags = document.tags?.length ? document.tags : ['未分组']
    for (const tag of tags) {
      if (!groups.has(tag)) groups.set(tag, [])
      groups.get(tag).push(document)
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
    .map(([label, items]) => ({ key: label, label, items }))
})
const outlinesByChapter = computed(() => {
  const groups = new Map()
  for (const document of filteredDocuments.value) {
    const refs = document.chapterRefs?.length ? document.chapterRefs : ['未映射正文']
    for (const raw of refs) {
      const label = String(raw)
        .replace(/^chapter:/, '')
        .replace(/\.txt$/i, '')
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label).push(document)
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) =>
      a === '未映射正文'
        ? 1
        : b === '未映射正文'
          ? -1
          : a.localeCompare(b, 'zh-CN', { numeric: true })
    )
    .map(([label, items]) => ({ key: label, label, items }))
})

async function openIndexHealth() {
  healthVisible.value = true
  loadingHealth.value = true
  try {
    const result = await window.electron.getKnowledgeIndexHealth(props.bookName)
    if (!result?.success) throw new Error(result?.message || '读取索引状态失败')
    indexHealth.value = result.health
  } catch (error) {
    ElMessage.error(error?.message || '读取索引状态失败')
  } finally {
    loadingHealth.value = false
  }
}

async function rebuildIndex() {
  rebuildingIndex.value = true
  try {
    const result = await window.electron.rebuildKnowledgeIndex(props.bookName)
    if (!result?.success) throw new Error(result?.message || '重建索引失败')
    indexHealth.value = result.health
    await loadDocuments()
    ElMessage.success('索引已从原始文档完整重建')
  } catch (error) {
    ElMessage.error(error?.message || '重建索引失败')
  } finally {
    rebuildingIndex.value = false
  }
}

function diagnosticTitle(item) {
  return (
    {
      CATALOG_DUPLICATE_ID: '重复 ID',
      CATALOG_AMBIGUOUS_NAME: '名称歧义',
      REFERENCE_DANGLING: '悬空引用',
      CATALOG_BUILD_FAILED: '文档无法解析',
      CATALOG_TYPE_MISMATCH: '文档类型不匹配'
    }[item.code] || item.code
  )
}
function diagnosticAdvice(item) {
  if (item.code === 'CATALOG_DUPLICATE_ID')
    return '修改其中一份文档的 frontmatter id，确保全书唯一。'
  if (item.code === 'REFERENCE_DANGLING') return '修正引用目标 ID，或创建对应资料。'
  if (item.code === 'CATALOG_BUILD_FAILED')
    return '打开原始文档，检查 UTF-8 编码和 frontmatter 格式。'
  if (item.code === 'KNOWLEDGE_REQUIRED_SECTION_MISSING')
    return '补回该文档类型要求的稳定 section 标记。'
  return '打开来源文档核对并修复；原始文档仍可直接编辑。'
}
async function openDiagnostic(item) {
  const typeScope = { character: 'characters', setting: 'settings', outline: 'outlines' }
  const targetScope = typeScope[item.source?.type] || item.scope
  const targetId = item.targetId || item.source?.id
  if (targetScope === props.scope && targetId) {
    healthVisible.value = false
    await openDocument(targetId, { line: item.source?.line, section: item.source?.section })
  }
}
function shortHash(value) {
  const text = String(value || '')
  return text ? `${text.slice(0, 16)}…` : '—'
}

function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleString()
}

function formatMetadata(value) {
  if (Array.isArray(value)) return value.length ? value.join('、') : '[]'
  if (value && typeof value === 'object') return JSON.stringify(value)
  return value == null || value === '' ? '—' : String(value)
}

function draftStorageKey(documentId = currentDocument.value?.id) {
  return `51mazi.knowledge-draft.v2:${encodeURIComponent(props.bookName)}:${props.scope}:${encodeURIComponent(documentId || '')}`
}

function readLocalDraft(documentId) {
  try {
    return JSON.parse(window.localStorage.getItem(draftStorageKey(documentId)) || 'null')
  } catch {
    return null
  }
}

function persistLocalDraft() {
  if (!currentDocument.value || !dirty.value) return
  try {
    window.localStorage.setItem(
      draftStorageKey(),
      JSON.stringify({
        source: source.value,
        baseFileHash: currentDocument.value.fileHash,
        savedAt: new Date().toISOString()
      })
    )
  } catch {
    // 本地存储不可用时，正式保存仍受文件哈希保护。
  }
}

function clearLocalDraft(documentId = currentDocument.value?.id) {
  try {
    window.localStorage.removeItem(draftStorageKey(documentId))
  } catch {
    // 忽略不可用的本地存储。
  }
}

function notifyKnowledgeDocumentsChanged(documentId) {
  window.dispatchEvent(
    new CustomEvent(KNOWLEDGE_DOCUMENTS_CHANGED_EVENT, {
      detail: {
        bookName: props.bookName,
        scope: props.scope,
        origin: workspaceEventSource,
        documentId: String(documentId || '')
      }
    })
  )
}

async function loadDocuments() {
  loadingDocuments.value = true
  try {
    const result = await window.electron.listKnowledgeDocuments(props.bookName, props.scope)
    if (!result?.success) throw new Error(result?.message || '读取文档列表失败')
    documents.value = result.documents || []
  } catch (error) {
    ElMessage.error(error?.message || '读取文档列表失败')
  } finally {
    loadingDocuments.value = false
  }
}

async function createDocument() {
  try {
    const prompt = await ElMessageBox.prompt(
      `输入新${config.value.singular}标题`,
      `新建${config.value.singular}`,
      {
        confirmButtonText: '创建 Markdown',
        cancelButtonText: '取消',
        inputPattern: /\S/,
        inputErrorMessage: '标题不能为空'
      }
    )
    const result = await window.electron.createKnowledgeDocument(props.bookName, props.scope, {
      title: prompt.value.trim(),
      ...(props.scope === 'settings' ? { kind: 'custom' } : {})
    })
    if (!result?.success) throw new Error(result?.message || '创建文档失败')
    notifyKnowledgeDocumentsChanged(result.document.id)
    await loadDocuments()
    await openDocument(result.document.id)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '创建文档失败')
  }
}

async function confirmDiscardIfDirty() {
  if (!dirty.value) return true
  persistLocalDraft()
  ElMessage.info('未保存内容已保留为本地草稿')
  return true
}

async function openDocument(documentId, location = {}) {
  if (!(await confirmDiscardIfDirty())) return
  try {
    const result = await window.electron.readKnowledgeDocument(
      props.bookName,
      props.scope,
      documentId
    )
    if (!result?.success) throw new Error(result?.message || '读取文档失败')
    currentDocument.value = result.document
    const draft = readLocalDraft(result.document.id)
    source.value =
      draft?.source && draft.source !== result.document.source
        ? draft.source
        : result.document.source
    savedSource.value = result.document.source
    lastUndoToken.value = ''
    lastSavedHash.value = result.document.fileHash
    editing.value = true
    if (draft?.source && draft.source !== result.document.source) {
      if (draft.baseFileHash && draft.baseFileHash !== result.document.fileHash) {
        // 保持草稿的旧基础哈希，让正式保存明确冲突，避免覆盖外部编辑。
        currentDocument.value.fileHash = draft.baseFileHash
        ElMessage.warning('已恢复基于旧版本的本地草稿；请先核对外部修改，当前草稿不会直接覆盖磁盘')
      } else ElMessage.info('已恢复本地草稿')
    }
    await validateSource()
    await nextTick()
    sourceEditor.value?.focus()
    const section =
      location.section && validationSections.value.find((item) => item.key === location.section)
    const line = Number(location.line) || section?.startLine || 0
    if (line > 0) jumpToLine(line, Number(location.endLine) || line, true)
    return true
  } catch (error) {
    ElMessage.error(error?.message || '读取文档失败')
    return false
  }
}

async function closeEditor() {
  if (saving.value) return
  characterImageVisible.value = false
  if (!(await confirmDiscardIfDirty())) return
  editing.value = false
  currentDocument.value = null
  source.value = ''
  savedSource.value = ''
  await loadDocuments()
}

async function reloadFromDisk() {
  if (!currentDocument.value) return
  try {
    if (dirty.value) {
      await ElMessageBox.confirm(
        '将丢弃当前本地草稿并重新读取磁盘版本。此操作不会修改正式文件。',
        '从磁盘重载？',
        { type: 'warning', confirmButtonText: '丢弃草稿并重载', cancelButtonText: '取消' }
      )
    }
    const id = currentDocument.value.id
    clearLocalDraft(id)
    source.value = savedSource.value
    await openDocument(id)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '重载失败')
  }
}

function handleSourceInput() {
  window.clearTimeout(validationTimer)
  window.clearTimeout(draftTimer)
  validationTimer = window.setTimeout(validateSource, 220)
  draftTimer = window.setTimeout(persistLocalDraft, 350)
}

async function validateSource() {
  const result = await window.electron.validateKnowledgeDocument(
    props.scope,
    source.value,
    'formal'
  )
  if (!result?.success) {
    validation.value = {
      valid: false,
      diagnostics: [{ code: result.code, message: result.message, severity: 'error' }]
    }
    validationSections.value = []
    return
  }
  validation.value = { ...result.validation, metadata: result.metadata }
  validationSections.value = result.sections || []
}

async function saveDocument() {
  if (!currentDocument.value || saving.value) return
  await validateSource()
  if (!validation.value.valid) return ElMessage.warning('请先修复文档校验问题')
  saving.value = true
  try {
    const result = await window.electron.writeKnowledgeDocument(
      props.bookName,
      props.scope,
      currentDocument.value.id,
      source.value,
      currentDocument.value.fileHash
    )
    if (!result?.success) {
      if (result?.code === 'KNOWLEDGE_DOCUMENT_VERSION_CONFLICT') {
        throw new Error('文件已被外部修改。当前内容未覆盖磁盘，请重新打开后合并。')
      }
      throw new Error(result?.message || '保存失败')
    }
    await applySavedDocument(result)
    if (!result.saved?.indexStale) ElMessage.success('知识文档与索引已更新')
  } catch (error) {
    ElMessage.error(error?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function applySavedDocument(result) {
  currentDocument.value = result.document
  source.value = result.document.source
  savedSource.value = result.document.source
  lastUndoToken.value = result.saved?.undoToken || ''
  lastSavedHash.value = result.document.fileHash
  clearLocalDraft(result.document.id)
  await validateSource()
  await loadDocuments()
  notifyKnowledgeDocumentsChanged(result.document.id)
  if (result.saved?.indexStale)
    ElMessage.warning(result.saved.indexError || '文档已保存，但索引需要重建')
}

async function undoLastSave() {
  if (!lastUndoToken.value || dirty.value) {
    if (dirty.value) ElMessage.warning('请先处理当前未保存修改')
    return
  }
  try {
    const result = await window.electron.undoKnowledgeDocumentWrite(
      props.bookName,
      lastUndoToken.value,
      lastSavedHash.value
    )
    if (!result?.success) throw new Error(result?.message || '撤销失败')
    lastUndoToken.value = ''
    await openDocument(currentDocument.value.id)
    notifyKnowledgeDocumentsChanged(currentDocument.value.id)
    ElMessage.success('已恢复到保存前版本')
  } catch (error) {
    ElMessage.error(error?.message || '撤销失败')
  }
}

function jumpToLine(lineNumber, endLine = lineNumber, flash = false) {
  const lines = source.value.split('\n')
  let offset = 0
  for (let index = 1; index < lineNumber; index += 1) offset += lines[index - 1].length + 1
  let endOffset = offset
  for (let index = Math.max(1, lineNumber); index <= Math.max(lineNumber, endLine); index += 1)
    endOffset += (lines[index - 1]?.length || 0) + (index < lines.length ? 1 : 0)
  nextTick(() => {
    const editor = sourceEditor.value
    editor?.focus()
    editor?.setSelectionRange(offset, Math.max(offset, endOffset))
    if (editor) {
      const lineHeight = Number.parseFloat(window.getComputedStyle(editor).lineHeight) || 22
      editor.scrollTop = Math.max(0, (lineNumber - 3) * lineHeight)
    }
    selectionStart.value = offset
    selectionEnd.value = Math.max(offset, endOffset)
    if (flash) {
      referenceTargetFlash.value = false
      window.clearTimeout(referenceFlashTimer)
      requestAnimationFrame(() => {
        referenceTargetFlash.value = true
      })
      referenceFlashTimer = window.setTimeout(() => {
        referenceTargetFlash.value = false
      }, 1800)
    }
  })
}

function captureSelection() {
  selectionStart.value = sourceEditor.value?.selectionStart || 0
  selectionEnd.value = sourceEditor.value?.selectionEnd || selectionStart.value
}

async function refreshOnFocus() {
  if (characterImageVisible.value || saving.value) return
  if (editing.value) {
    if (!dirty.value && currentDocument.value) await openDocument(currentDocument.value.id)
  } else await loadDocuments()
}

function getAgentContext(mode = 'selection') {
  const selected = source.value.slice(selectionStart.value, selectionEnd.value)
  const section = validationSections.value.find((item) => {
    const before = source.value
      .split(/\r\n|\n|\r/)
      .slice(0, item.startLine - 1)
      .join('\n').length
    const end = source.value
      .split(/\r\n|\n|\r/)
      .slice(0, item.endLine)
      .join('\n').length
    return selectionStart.value >= before && selectionStart.value <= end
  })
  return {
    currentModule: `${props.scope}-knowledge-v2`,
    currentDocumentId: currentDocument.value?.id || null,
    currentEntityId: currentDocument.value?.id || null,
    currentSectionId: section?.key || null,
    selectionText: selected,
    selectionRange: { start: selectionStart.value, end: selectionEnd.value },
    currentDocumentSavedHash: currentDocument.value?.fileHash || null,
    currentSectionSavedHash: section?.contentHash || null,
    hasUnsavedChanges: dirty.value,
    fullText: mode === 'full' ? source.value : '',
    metadata: {
      knowledge_scope: props.scope,
      knowledge_document_id: currentDocument.value?.id || '',
      knowledge_section: section?.key || '',
      knowledge_title: currentMetadata.value.title || '',
      source_file: currentDocument.value?.path || ''
    }
  }
}

function handleExternalKnowledgeChange(event) {
  const detail = event?.detail || {}
  if (detail.origin === workspaceEventSource) return
  if (detail.bookName !== props.bookName || detail.scope !== props.scope) return
  void loadDocuments()
  if (!editing.value || currentDocument.value?.id !== detail.documentId) return
  if (dirty.value || characterImageVisible.value || saving.value) {
    ElMessage.warning('Agent 已更新正式文档；当前本地草稿仍保留，请从磁盘重载后合并')
    return
  }
  void openDocument(detail.documentId)
}

watch(
  () => props.bookName,
  () => loadDocuments()
)

onMounted(() => {
  void loadBooksDir()
  loadDocuments()
  window.addEventListener('focus', refreshOnFocus)
  window.addEventListener(KNOWLEDGE_DOCUMENTS_CHANGED_EVENT, handleExternalKnowledgeChange)
  try {
    const key = `51mazi.reference-jump:${props.bookName}`
    const target = JSON.parse(window.sessionStorage.getItem(key) || 'null')
    const typeScope = { character: 'characters', setting: 'settings', outline: 'outlines' }
    if (target && typeScope[target.type] === props.scope) {
      window.sessionStorage.removeItem(key)
      void openDocument(target.targetId, target)
    }
  } catch {
    /* 无效待跳转信息不影响工作区 */
  }
})
onBeforeUnmount(() => {
  persistLocalDraft()
  window.clearTimeout(validationTimer)
  window.clearTimeout(draftTimer)
  window.clearTimeout(referenceFlashTimer)
  window.removeEventListener('focus', refreshOnFocus)
  window.removeEventListener(KNOWLEDGE_DOCUMENTS_CHANGED_EVENT, handleExternalKnowledgeChange)
})

defineExpose({ getAgentContext, openDocument })
</script>

<style lang="scss" scoped>
.card-identity {
  display: flex;
  align-items: center;
  gap: 12px;
}
.character-avatar-control {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 20px;
}
.character-avatar-preview {
  width: 100%;
  max-height: 240px;
  border-radius: 8px;
}
.character-avatar-empty {
  padding: 28px 8px;
  text-align: center;
  background: var(--el-fill-color-light);
  border-radius: 8px;
}
.character-avatar-control small {
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}
.knowledge-workspace {
  width: 100%;
  height: 100%;
  min-height: 0;
  color: var(--text-base);
}

.eyebrow {
  color: var(--el-color-primary);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.index-header,
.editor-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.index-header h2,
.editor-header h2 {
  margin: 5px 0 7px;
  font-size: 22px;
}

.index-header p {
  max-width: 720px;
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.7;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.document-index,
.document-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.index-header,
.editor-header {
  padding: 22px 26px 16px;
  border-bottom: 1px solid var(--border-color);
}

.filter-bar {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 180px 180px auto;
  gap: 10px;
  align-items: center;
  padding: 13px 26px;
  border-bottom: 1px solid var(--border-color);
}

.document-count {
  color: var(--text-secondary);
  font-size: 12px;
}

.derived-view-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 14px;
}
.derived-view-tabs button {
  border: 1px solid var(--el-border-color);
  border-radius: 999px;
  padding: 6px 12px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.derived-view-tabs button.active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.derived-view-tabs span {
  margin-left: auto;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.derived-groups,
.chapter-map {
  display: grid;
  gap: 14px;
}
.derived-group,
.chapter-map-row {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  overflow: hidden;
  background: var(--el-bg-color);
}
.derived-group > header,
.chapter-map-row > header {
  display: flex;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--el-fill-color-light);
}
.derived-group > button,
.chapter-map-row > button {
  display: grid;
  grid-template-columns: 42px minmax(120px, 1fr) minmax(100px, 1fr);
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: 0;
  border-top: 1px solid var(--el-border-color-lighter);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.derived-group > button:hover,
.chapter-map-row > button:hover {
  background: var(--el-fill-color-light);
}
.order-badge {
  color: var(--el-color-primary);
  font-variant-numeric: tabular-nums;
}
.derived-group small,
.chapter-map-row small {
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
}
.health-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.health-summary > div {
  display: grid;
  gap: 3px;
  padding: 14px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
}
.health-summary strong {
  font-size: 24px;
}
.health-summary span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.health-summary .danger strong {
  color: var(--el-color-danger);
}
.health-summary .warning strong {
  color: var(--el-color-warning);
}
.health-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 18px 0;
  color: var(--el-text-color-secondary);
}
.health-diagnostics {
  display: grid;
  gap: 8px;
}
.health-diagnostics button {
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-left: 4px solid var(--el-color-warning);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.health-diagnostics button.error {
  border-left-color: var(--el-color-danger);
}
.health-diagnostics button:hover {
  background: var(--el-fill-color-light);
}
.health-diagnostics small {
  color: var(--el-text-color-secondary);
}
.document-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(255px, 1fr));
  gap: 13px;
  align-content: start;
  padding: 20px 26px;
  overflow: auto;
}

.document-card {
  min-height: 190px;
  padding: 15px;
  border: 1px solid var(--border-color);
  border-radius: 9px;
  background: var(--bg-soft);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s,
    transform 0.15s;
}

.document-card:hover {
  border-color: var(--el-color-primary);
  transform: translateY(-1px);
}
.card-topline,
.document-card footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-secondary);
  font-size: 11px;
}
.document-card h3 {
  margin: 15px 0 3px;
  font-size: 17px;
}
.document-id {
  margin: 0 0 10px;
  color: var(--text-secondary);
  font-family: monospace;
  font-size: 11px;
}
.aliases {
  min-height: 19px;
  color: var(--text-secondary);
  font-size: 12px;
}
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 32px;
  margin: 10px 0;
  color: var(--el-color-primary);
  font-size: 11px;
}

.editor-title {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.editor-title h2 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.save-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--el-color-success);
  font-size: 12px;
}
.save-state.invalid {
  color: var(--el-color-danger);
}

.editor-layout {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr) 260px;
  flex: 1;
  min-height: 0;
}

.section-nav,
.validation-pane {
  min-width: 0;
  padding: 16px 13px;
  overflow: auto;
  background: var(--bg-soft);
}

.section-nav {
  border-right: 1px solid var(--border-color);
}
.validation-pane {
  border-left: 1px solid var(--border-color);
}
.aside-title {
  margin-bottom: 12px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.section-nav button {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  margin-bottom: 5px;
  padding: 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-base);
  text-align: left;
  cursor: pointer;
}
.section-nav button:hover {
  background: color-mix(in srgb, var(--el-color-primary) 12%, transparent);
}
.section-nav button span {
  color: var(--text-secondary);
  font-size: 10px;
}
.aside-tip {
  margin-top: 18px;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.6;
}

.source-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 11px 14px;
}
.source-meta,
.source-footer {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-secondary);
  font-size: 10px;
}
.source-meta {
  padding: 0 2px 8px;
}
.source-footer {
  padding: 8px 2px 0;
}
.source-pane textarea {
  width: 100%;
  resize: none;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  outline: none;
  background: var(--bg-primary);
  color: var(--text-base);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 13px;
  line-height: 1.65;
}
.source-pane textarea.reference-target-flash {
  animation: reference-target-pulse 1.8s ease;
}
.source-pane textarea::selection {
  background: color-mix(in srgb, var(--el-color-primary) 38%, transparent);
  color: inherit;
}
@keyframes reference-target-pulse {
  0%,
  100% {
    box-shadow: none;
  }
  18%,
  62% {
    box-shadow:
      inset 0 0 0 3px color-mix(in srgb, var(--el-color-primary) 58%, transparent),
      0 0 18px color-mix(in srgb, var(--el-color-primary) 22%, transparent);
  }
}
.source-pane textarea {
  flex: 1;
  min-height: 0;
  padding: 17px;
}
.source-pane textarea:focus {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--el-color-primary) 24%, transparent);
}
.metadata-list {
  margin: 0;
}
.metadata-list dt {
  margin-top: 9px;
  color: var(--text-secondary);
  font-size: 10px;
}
.metadata-list dd {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
  font-size: 11px;
  line-height: 1.45;
}
.diagnostics {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 18px;
}
.diagnostics > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--el-color-danger) 8%, transparent);
  color: var(--el-color-danger);
  font-size: 10px;
}
.diagnostics > div.warning {
  background: color-mix(in srgb, var(--el-color-warning) 8%, transparent);
  color: var(--el-color-warning);
}
.valid-note {
  margin-top: 18px;
  color: var(--el-color-success);
  font-size: 11px;
  line-height: 1.6;
}

@media (max-width: 1050px) {
  .editor-layout {
    grid-template-columns: 160px minmax(0, 1fr);
  }
  .validation-pane {
    display: none;
  }
  .filter-bar {
    grid-template-columns: minmax(220px, 1fr) 150px 150px auto;
  }
}
</style>
