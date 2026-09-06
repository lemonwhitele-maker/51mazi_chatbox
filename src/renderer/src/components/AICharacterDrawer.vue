<template>
  <el-drawer
    :model-value="modelValue"
    :title="resolvedDrawerTitle"
    size="700px"
    direction="rtl"
    class="ai-character-drawer"
    header-class="ai-character-drawer__header"
    body-class="ai-character-drawer__body"
    :close-on-click-modal="false"
    :close-on-press-escape="!confirming"
    :show-close="!confirming"
    @update:model-value="handleCancel"
  >
    <div class="ai-character-drawer-content">
      <el-form
        ref="formRef"
        :model="form"
        :rules="formRules"
        label-width="100px"
        class="ai-character-drawer-form"
        @submit.prevent="handleGenerate"
      >
        <el-form-item v-if="characterName" :label="resolvedSubjectLabel">
          <span class="character-name-tip">{{ characterName }}</span>
        </el-form-item>

        <template v-if="providersLoaded">
          <el-alert
            v-if="noImageProviders"
            type="warning"
            :closable="false"
            show-icon
            class="ai-drawer-provider-alert"
          >
            {{ t('imageAi.noProviderHint') }}
          </el-alert>
          <el-form-item v-else :label="t('imageAi.serviceLabel')">
            <el-select v-model="selectedProvider" style="width: 100%">
              <el-option
                v-for="p in imageProviders"
                :key="p"
                :label="labelForImageProvider(p)"
                :value="p"
              />
            </el-select>
          </el-form-item>
        </template>

        <el-form-item prop="style" :label="t('aiCharacter.style')">
          <el-select
            v-model="form.style"
            :placeholder="t('aiCharacter.selectStyle')"
            style="width: 100%"
            clearable
          >
            <el-option
              v-for="opt in styleOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            >
              <div class="style-option">
                <span>{{ opt.label }}</span>
                <span class="style-desc">{{ opt.desc }}</span>
              </div>
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item prop="prompt" :label="t('aiCharacter.prompt')">
          <el-input
            v-model="form.prompt"
            type="textarea"
            :rows="4"
            :placeholder="resolvedPromptPlaceholder"
            maxlength="500"
            show-word-limit
          />
        </el-form-item>

        <el-form-item :label="t('aiCharacter.pose')">
          <el-select
            v-model="form.pose"
            :placeholder="resolvedPosePlaceholder"
            style="width: 100%"
            clearable
          >
            <el-option
              v-for="opt in poseOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item :label="t('aiCharacter.negativePrompt')">
          <el-input
            v-model="form.negativePrompt"
            type="textarea"
            :rows="2"
            :placeholder="t('aiCharacter.negativePromptPlaceholder')"
            maxlength="200"
            show-word-limit
          />
        </el-form-item>

        <div class="form-tip">{{ resolvedOutputTip }}</div>
      </el-form>

      <!-- 已生成的图片列表 -->
      <div v-if="generatedList.length > 0" class="generated-section">
        <div class="section-title">
          {{
            t('aiCharacter.generatedTitle', {
              typeName: resolvedGeneratedImageTypeName,
              count: generatedList.length
            })
          }}
        </div>
        <div class="generated-grid">
          <div
            v-for="(item, index) in generatedList"
            :key="item.localPath"
            class="generated-item"
            :class="{ selected: selectedPath === item.localPath }"
            @click="!confirming && (selectedPath = item.localPath)"
          >
            <img
              :src="item.previewUrl"
              :alt="
                t('aiCharacter.generatedAlt', {
                  typeName: resolvedGeneratedImageTypeName,
                  index: index + 1
                })
              "
            />
          </div>
        </div>
      </div>

      <el-alert v-if="generating" type="info" :closable="false" show-icon class="generating-hint">
        {{ resolvedGeneratingHint }}
      </el-alert>
      <div class="ai-character-drawer-footer">
        <el-button :disabled="confirming" @click="handleCancel">{{ t('common.cancel') }}</el-button>
        <el-button
          type="primary"
          :loading="generating"
          :disabled="noImageProviders || !selectedProvider || confirming"
          @click="handleGenerate"
        >
          {{ generatedList.length > 0 ? resolvedRegenerateButtonText : resolvedGenerateButtonText }}
        </el-button>
        <el-button
          v-if="generatedList.length > 0"
          type="success"
          :disabled="!selectedPath || generating"
          :loading="confirming"
          @click="handleConfirmUse"
        >
          {{ confirmButtonText || t('aiCharacter.confirmUse') }}
        </el-button>
      </div>
    </div>
  </el-drawer>
</template>

<script setup>
import { ref, watch, computed, toRef, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import {
  generateAICharacterImage,
  confirmAICharacterImage,
  discardAICharacterImages
} from '@renderer/service/tongyiwanxiang'
import { useImageAiProviderSelect } from '@renderer/composables/useImageAiProviderSelect'
import { pathToLocalFileUrl } from '@renderer/utils/localFileUrl'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 书籍名称，用于保存路径 */
  bookName: { type: String, default: '' },
  /** 当前档案名称（人物/坐骑等），仅用于展示 */
  characterName: { type: String, default: '' },
  /** 形象介绍，打开抽屉时预填到提示词 */
  appearance: { type: String, default: '' },
  /** 抽屉标题 */
  drawerTitle: { type: String, default: '' },
  /** 「当前xxx」表单项标签 */
  subjectLabel: { type: String, default: '' },
  /** 拼入模型提示词的开头主体描述（区分人物/坐骑/宝器等） */
  promptIntro: {
    type: String,
    default: ''
  },
  /** 接在画风后的细节引导语，如「人物形象：」「外形与细节：」 */
  promptDetailPrefix: { type: String, default: '' },
  promptPlaceholder: {
    type: String,
    default: ''
  },
  posePlaceholder: { type: String, default: '' },
  outputTip: { type: String, default: '' },
  /** 用于列表标题、按钮、alt，如「人物图」「形象图」 */
  generatedImageTypeName: { type: String, default: '' },
  generateButtonText: { type: String, default: '' },
  regenerateButtonText: { type: String, default: '' },
  generatingHint: { type: String, default: '' },
  /** 点击生成时的全局提示 */
  infoGeneratingMessage: { type: String, default: '' },
  validatePromptMessage: { type: String, default: '' },
  confirmSuccessMessage: { type: String, default: '' },
  confirmButtonText: { type: String, default: '' },
  /** Await the formal document save before closing or reporting success. */
  confirmImage: { type: Function, default: null },
  /** 生成失败等场景下的简短类型名，用于错误提示 */
  generateFailTypeName: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'character-image-generated'])
const { t } = useI18n()

const modelOpen = toRef(props, 'modelValue')
const { imageProviders, selectedProvider, noImageProviders, providersLoaded } =
  useImageAiProviderSelect(modelOpen)

function labelForImageProvider(id) {
  const keys = {
    tongyi: 'imageAi.providerTongyi',
    gemini: 'imageAi.providerGemini',
    doubao: 'imageAi.providerDoubao'
  }
  return t(keys[id] || id)
}

const formRef = ref(null)
const generating = ref(false)
const confirming = ref(false)
const generatedList = ref([]) // { localPath, previewUrl }
const selectedPath = ref('')
let currentSession = null

function discardSession(session) {
  if (!session) return
  void discardAICharacterImages({ bookName: session.bookName, sessionId: session.id }).catch(
    () => {}
  )
}

function endSession() {
  const session = currentSession
  currentSession = null
  generating.value = false
  confirming.value = false
  discardSession(session)
}

const form = ref({
  style: '',
  prompt: '',
  pose: '',
  negativePrompt: ''
})

// 固定尺寸：竖版全身
const FIXED_SIZE = '720*1280'
const resolvedDrawerTitle = computed(() => props.drawerTitle || t('aiCharacter.drawerTitle'))
const resolvedSubjectLabel = computed(() => props.subjectLabel || t('aiCharacter.subjectLabel'))
const resolvedPromptIntro = computed(() => props.promptIntro || t('aiCharacter.promptIntro'))
const resolvedPromptDetailPrefix = computed(
  () => props.promptDetailPrefix || t('aiCharacter.promptDetailPrefix')
)
const resolvedPromptPlaceholder = computed(
  () => props.promptPlaceholder || t('aiCharacter.promptPlaceholder')
)
const resolvedPosePlaceholder = computed(
  () => props.posePlaceholder || t('aiCharacter.posePlaceholder')
)
const resolvedOutputTip = computed(() => props.outputTip || t('aiCharacter.outputTip'))
const resolvedGeneratedImageTypeName = computed(
  () => props.generatedImageTypeName || t('aiCharacter.generatedImageTypeName')
)
const resolvedGenerateButtonText = computed(
  () => props.generateButtonText || t('aiCharacter.generateButtonText')
)
const resolvedRegenerateButtonText = computed(
  () => props.regenerateButtonText || t('aiCharacter.regenerateButtonText')
)
const resolvedGeneratingHint = computed(
  () => props.generatingHint || t('aiCharacter.generatingHint')
)
const resolvedInfoGeneratingMessage = computed(
  () => props.infoGeneratingMessage || t('aiCharacter.infoGeneratingMessage')
)
const resolvedValidatePromptMessage = computed(
  () => props.validatePromptMessage || t('aiCharacter.validatePromptMessage')
)
const resolvedConfirmSuccessMessage = computed(
  () => props.confirmSuccessMessage || t('aiCharacter.confirmSuccessMessage')
)
const resolvedGenerateFailTypeName = computed(
  () => props.generateFailTypeName || t('aiCharacter.generateFailTypeName')
)

/**
 * 图片风格选项
 * 设计原则：用户选项名清晰好选；prompt 使用通义万相文档推荐的「风格」维度用词（如漫画、摄影、水彩、皮克斯等），
 * 简短、单一概念，便于模型准确匹配画风。参考：提示词 = 主体 + 场景 + 风格。
 */
const styleOptions = [
  {
    value: 'anime',
    label: t('aiCharacter.styles.anime.label'),
    desc: t('aiCharacter.styles.anime.desc'),
    prompt: t('aiCharacter.stylePrompts.anime')
  },
  {
    value: 'ghibli',
    label: t('aiCharacter.styles.ghibli.label'),
    desc: t('aiCharacter.styles.ghibli.desc'),
    prompt: t('aiCharacter.stylePrompts.ghibli')
  },
  {
    value: 'retro_anime',
    label: t('aiCharacter.styles.retroAnime.label'),
    desc: t('aiCharacter.styles.retroAnime.desc'),
    prompt: t('aiCharacter.stylePrompts.retroAnime')
  },
  {
    value: 'photorealistic',
    label: t('aiCharacter.styles.photorealistic.label'),
    desc: t('aiCharacter.styles.photorealistic.desc'),
    prompt: t('aiCharacter.stylePrompts.photorealistic')
  },
  {
    value: '3d_render',
    label: t('aiCharacter.styles.render3d.label'),
    desc: t('aiCharacter.styles.render3d.desc'),
    prompt: t('aiCharacter.stylePrompts.render3d')
  },
  {
    value: 'pixar',
    label: t('aiCharacter.styles.pixar.label'),
    desc: t('aiCharacter.styles.pixar.desc'),
    prompt: t('aiCharacter.stylePrompts.pixar')
  },
  {
    value: 'guofeng',
    label: t('aiCharacter.styles.guofeng.label'),
    desc: t('aiCharacter.styles.guofeng.desc'),
    prompt: t('aiCharacter.stylePrompts.guofeng')
  },
  {
    value: 'watercolor',
    label: t('aiCharacter.styles.watercolor.label'),
    desc: t('aiCharacter.styles.watercolor.desc'),
    prompt: t('aiCharacter.stylePrompts.watercolor')
  },
  {
    value: 'ink_wash',
    label: t('aiCharacter.styles.inkWash.label'),
    desc: t('aiCharacter.styles.inkWash.desc'),
    prompt: t('aiCharacter.stylePrompts.inkWash')
  },
  {
    value: 'oil_painting',
    label: t('aiCharacter.styles.oilPainting.label'),
    desc: t('aiCharacter.styles.oilPainting.desc'),
    prompt: t('aiCharacter.stylePrompts.oilPainting')
  },
  {
    value: 'cyberpunk',
    label: t('aiCharacter.styles.cyberpunk.label'),
    desc: t('aiCharacter.styles.cyberpunk.desc'),
    prompt: t('aiCharacter.stylePrompts.cyberpunk')
  },
  {
    value: 'pixel_art',
    label: t('aiCharacter.styles.pixelArt.label'),
    desc: t('aiCharacter.styles.pixelArt.desc'),
    prompt: t('aiCharacter.stylePrompts.pixelArt')
  }
]

/** 构图与姿态：可选，增强画面描述 */
const poseOptions = [
  { value: '', label: t('aiCharacter.unspecified') },
  { value: 'standing', label: t('aiCharacter.poses.standing') },
  { value: 'half_body', label: t('aiCharacter.poses.halfBody') },
  { value: 'dynamic', label: t('aiCharacter.poses.dynamic') },
  { value: 'portrait', label: t('aiCharacter.poses.portrait') },
  { value: 'side', label: t('aiCharacter.poses.side') }
]

const formRules = computed(() => ({
  prompt: [
    { required: true, message: resolvedValidatePromptMessage.value, trigger: 'blur' },
    { min: 5, message: t('aiCharacter.rulePromptMin'), trigger: 'blur' }
  ]
}))

// 打开抽屉时预填
watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      endSession()
      currentSession = { id: crypto.randomUUID(), bookName: props.bookName }
      form.value.prompt = (props.appearance || '').trim()
      form.value.style = ''
      form.value.pose = ''
      form.value.negativePrompt = ''
      generatedList.value = []
      selectedPath.value = ''
    } else {
      endSession()
    }
  }
)

/** 根据表单拼接完整提示词：主体类型 + 风格 + 形象描述 + 姿态 */
function buildFullPrompt() {
  const parts = [resolvedPromptIntro.value]
  const styleKey = form.value.style
  if (styleKey) {
    const styleOpt = styleOptions.find((o) => o.value === styleKey)
    if (styleOpt?.prompt) parts.push(styleOpt.prompt)
  }
  parts.push(t('aiCharacter.promptDetailLead', { prefix: resolvedPromptDetailPrefix.value }))
  parts.push(form.value.prompt.trim())
  const poseKey = form.value.pose
  if (poseKey) {
    const poseOpt = poseOptions.find((o) => o.value === poseKey)
    if (poseOpt?.label && poseOpt.label !== t('aiCharacter.unspecified')) {
      parts.push(t('aiCharacter.promptPoseLead', { pose: poseOpt.label }))
    }
  }
  return parts.join('')
}

async function handleGenerate() {
  const session = currentSession
  if (!session || generating.value || confirming.value) return
  try {
    await formRef.value.validate()
    if (currentSession !== session) return
    const bookName = (session.bookName || '').trim()
    if (!bookName) {
      ElMessage.error(t('aiCharacter.bookNameEmpty'))
      return
    }
    if (!selectedProvider.value) {
      ElMessage.warning(t('imageAi.noProviderHint'))
      return
    }
    generating.value = true
    ElMessage.info(resolvedInfoGeneratingMessage.value)
    const fullPrompt = buildFullPrompt()
    const res = await generateAICharacterImage({
      prompt: fullPrompt,
      size: FIXED_SIZE,
      bookName,
      sessionId: session.id,
      negativePrompt: (form.value.negativePrompt || '').trim() || undefined,
      imageProvider: selectedProvider.value
    })
    if (currentSession !== session) {
      discardSession(session)
      return
    }
    if (res?.success && res.localPath) {
      const previewUrl = pathToLocalFileUrl(res.localPath)
      generatedList.value.push({ localPath: res.localPath, previewUrl })
      selectedPath.value = res.localPath
      ElMessage.success(t('aiCharacter.generatedSelectOrContinue'))
    } else {
      ElMessage.error(
        res?.message ||
          t('aiCharacter.generateByTypeFailed', { type: resolvedGenerateFailTypeName.value })
      )
    }
  } catch (error) {
    if (currentSession === session && error !== false)
      ElMessage.error(error?.message || t('aiCharacter.checkFormInput'))
  } finally {
    if (currentSession === session) generating.value = false
  }
}

function handleCancel() {
  if (confirming.value) return
  endSession()
  emit('update:modelValue', false)
}

async function handleConfirmUse() {
  const session = currentSession
  const candidate = generatedList.value.find((item) => item.localPath === selectedPath.value)
  if (!session || !candidate || generating.value || confirming.value) return
  confirming.value = true
  try {
    const res =
      candidate.confirmed ||
      (await confirmAICharacterImage({
        bookName: session.bookName,
        sessionId: session.id,
        chosenPath: candidate.localPath
      }))
    if (currentSession !== session) return
    if (res?.success && res.localPath) {
      candidate.confirmed = res
      if (props.confirmImage) await props.confirmImage(res)
      if (currentSession !== session) return
      emit('character-image-generated', res)
      emit('update:modelValue', false)
      ElMessage.success(resolvedConfirmSuccessMessage.value)
    } else {
      ElMessage.error(res?.message || t('aiCharacter.confirmFailed'))
    }
  } catch (error) {
    if (currentSession === session)
      ElMessage.error(error?.message || t('aiCharacter.confirmFailed'))
  } finally {
    if (currentSession === session) confirming.value = false
  }
}

const removeDirectoryListener = window.electron.onApiConfigDirectoryChanged?.(() => {
  endSession()
  emit('update:modelValue', false)
})
onBeforeUnmount(() => {
  endSession()
  removeDirectoryListener?.()
})
</script>

<!-- 抽屉 Teleport 到 body，header/body 用官方 class 挂接；无 scoped 避免匹配不到 -->
<style lang="scss">
.ai-character-drawer__header.el-drawer__header {
  margin-bottom: 0;
  padding-bottom: 20px;
}
.ai-character-drawer__body.el-drawer__body {
  padding: 0;
}
</style>

<style lang="scss" scoped>
.ai-drawer-provider-alert {
  margin-bottom: 12px;
}
.ai-character-drawer-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.ai-character-drawer-form {
  flex: 1;
  overflow-y: auto;
  padding: 0 20px;
}
.character-name-tip {
  color: var(--el-text-color-regular);
  font-weight: 500;
}
.style-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  .style-desc {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}
.form-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: -8px;
  margin-bottom: 12px;
  padding: 0 4px;
}
.generated-section {
  flex: 0 0 auto;
  overflow-y: auto;
  max-height: 320px;
  padding: 12px 20px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-lighter);
}
.section-title {
  font-size: 14px;
  color: var(--el-text-color-regular);
  margin-bottom: 12px;
}
.generated-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}
.generated-item {
  aspect-ratio: 9 / 16;
  border-radius: 8px;
  overflow: hidden;
  border: 3px solid transparent;
  cursor: pointer;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
  background: var(--el-fill-color);
  &:hover {
    border-color: var(--el-border-color);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
  }
  &.selected {
    border-color: var(--el-color-success);
    box-shadow: 0 0 0 2px rgba(103, 194, 58, 0.3);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
}
.generating-hint {
  margin-bottom: 12px;
}
.ai-character-drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
  flex-shrink: 0;
}
</style>
