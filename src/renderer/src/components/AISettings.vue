<template>
  <el-drawer
    v-model="drawerVisible"
    :title="t('aiSettings.title')"
    direction="rtl"
    size="700px"
    class="ai-settings-drawer"
    :close-on-click-modal="false"
    @close="handleClose"
  >
    <div class="ai-settings-drawer-inner">
      <div class="ai-settings-drawer-body">
        <el-alert
          v-if="!booksDirReady && !loadingConfig"
          title="请先在首页选择有效书库目录，再保存 API 设置。"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-form
          label-width="120px"
          :disabled="!booksDirReady || loadingConfig"
          @submit.prevent="handleSave"
        >
          <!-- Agent API：可直连兼容模型，也可继续使用 Codex 反代 -->
          <div class="section-heading">{{ t('aiSettings.sectionAgentApi') }}</div>
          <div class="config-block agent-api-block">
            <div class="block-title">{{ t('aiSettings.agentApiTitle') }}</div>
            <el-alert
              :title="t('aiSettings.agentApiHint')"
              type="info"
              :closable="false"
              show-icon
            />
            <el-form-item :label="t('aiSettings.agentApiDefaultRuntime')">
              <el-radio-group v-model="agentDefaultRuntime">
                <el-radio value="agent-api">{{ t('aiSettings.agentApiDirect') }}</el-radio>
                <el-radio value="codex-app-server">{{
                  t('aiSettings.agentApiCodexProxy')
                }}</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item :label="t('aiSettings.agentApiProvider')">
              <el-select v-model="agentProviderId" filterable @change="handleAgentProviderChange">
                <el-option
                  v-for="provider in agentProviderCatalog"
                  :key="provider.id"
                  :label="provider.name"
                  :value="provider.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item :label="t('aiSettings.agentApiBaseUrl')">
              <el-input v-model="agentBaseUrl" placeholder="https://api.example.com/v1" clearable />
            </el-form-item>
            <el-form-item :label="t('aiSettings.agentApiModel')">
              <el-input
                v-model="agentModel"
                :placeholder="t('aiSettings.agentApiModelPlaceholder')"
                clearable
              />
            </el-form-item>
            <el-form-item :label="t('aiSettings.apiKey')">
              <el-input
                v-model="agentApiKey"
                type="password"
                show-password
                :placeholder="agentApiKeyOptional ? t('aiSettings.agentApiKeyOptional') : 'sk-...'"
                clearable
              />
            </el-form-item>
            <el-form-item>
              <el-button
                type="default"
                :loading="validatingAgentApi"
                :disabled="
                  anyLoading ||
                  !agentBaseUrl.trim() ||
                  !agentModel.trim() ||
                  (!agentApiKeyOptional && !agentApiKey.trim())
                "
                @click="handleValidateAgentApi"
              >
                {{ t('aiSettings.validate') }}
              </el-button>
            </el-form-item>
            <el-form-item v-if="agentApiStatus !== null">
              <el-alert
                :type="agentApiStatus ? 'success' : 'error'"
                :title="
                  agentApiStatus
                    ? t('aiSettings.agentApiValidateSuccess')
                    : t('aiSettings.agentApiValidateFailed')
                "
                :description="agentApiValidationMessage"
                :closable="false"
                show-icon
              />
            </el-form-item>
          </div>

          <!-- 功能 API：只承接轻量白名单任务，当前首个用途为 Thread 自动标题 -->
          <div class="section-heading section-heading-spaced">
            {{ t('aiSettings.sectionFunctionApi') }}
          </div>
          <div class="config-block function-api-block">
            <div class="block-title">{{ t('aiSettings.functionApiTitle') }}</div>
            <el-alert
              :title="t('aiSettings.functionApiHint')"
              :description="t('aiSettings.functionApiFallback')"
              type="info"
              :closable="false"
              show-icon
            />
            <el-form-item :label="t('aiSettings.functionApiEnabled')">
              <el-switch v-model="functionApiEnabled" />
            </el-form-item>
            <el-form-item :label="t('aiSettings.functionApiProvider')">
              <el-select v-model="functionApiProvider" @change="handleFunctionProviderChange">
                <el-option :label="t('aiSettings.functionApiProviderDeepseek')" value="deepseek" />
                <el-option :label="t('aiSettings.functionApiProviderCustom')" value="custom" />
              </el-select>
            </el-form-item>
            <el-form-item :label="t('aiSettings.apiKey')">
              <el-input
                v-model="functionApiKey"
                type="password"
                show-password
                :placeholder="t('aiSettings.functionApiKeyPlaceholder')"
                clearable
              />
            </el-form-item>
            <el-form-item
              v-if="functionApiProvider === 'custom'"
              :label="t('aiSettings.functionApiBaseUrl')"
            >
              <el-input
                v-model="functionApiBaseUrl"
                :placeholder="t('aiSettings.functionApiBaseUrlPlaceholder')"
                clearable
              />
            </el-form-item>
            <el-form-item :label="t('aiSettings.functionApiModel')">
              <el-input
                v-model="functionApiModel"
                :placeholder="t('aiSettings.functionApiModelPlaceholder')"
                clearable
              />
            </el-form-item>
            <el-form-item :label="t('aiSettings.functionApiTasks')">
              <el-checkbox :model-value="true" disabled>{{
                t('aiSettings.functionApiTaskConversationTitle')
              }}</el-checkbox>
            </el-form-item>
            <el-form-item>
              <el-button
                type="default"
                :loading="validatingFunctionApi"
                :disabled="anyLoading || !functionApiKey.trim() || !functionApiModel.trim()"
                @click="handleValidateFunctionApi"
              >
                {{ t('aiSettings.validate') }}
              </el-button>
            </el-form-item>
            <el-form-item v-if="functionApiStatus !== null">
              <el-alert
                :type="functionApiStatus ? 'success' : 'error'"
                :title="
                  functionApiStatus
                    ? t('aiSettings.functionApiValidateSuccess')
                    : t('aiSettings.functionApiValidateFailed')
                "
                :description="functionApiValidationMessage"
                :closable="false"
                show-icon
              />
              <div v-if="functionApiValidatedAt" class="form-tip">
                {{
                  t('aiSettings.functionApiLastValidatedAt', {
                    time: formatValidationTime(functionApiValidatedAt)
                  })
                }}
              </div>
            </el-form-item>
          </div>

          <!-- 图像 AI -->
          <div class="section-heading section-heading-spaced">
            {{ t('aiSettings.sectionImageAi') }}
          </div>

          <!-- 通义万相 -->
          <div class="config-block">
            <div class="block-title">{{ t('aiSettings.tongyi') }}</div>
            <el-form-item :label="t('aiSettings.apiKey')">
              <div class="input-with-btn">
                <el-input
                  v-model="apiKeyTongyi"
                  type="password"
                  show-password
                  :placeholder="t('aiSettings.tongyiPlaceholder')"
                  clearable
                />
                <el-button
                  type="default"
                  :loading="validatingTongyi"
                  :disabled="anyLoading || !apiKeyTongyi.trim()"
                  @click="handleValidateTongyi"
                >
                  {{ t('aiSettings.validate') }}
                </el-button>
              </div>
              <div class="form-tip">
                <el-link
                  href="https://help.aliyun.com/zh/model-studio/get-api-key"
                  target="_blank"
                  type="primary"
                  :underline="false"
                >
                  {{ t('aiSettings.getApiKey') }}
                </el-link>
              </div>
            </el-form-item>
            <el-form-item v-if="apiKeyStatusTongyi !== null">
              <el-alert
                :type="apiKeyStatusTongyi ? 'success' : 'error'"
                :title="
                  apiKeyStatusTongyi
                    ? t('aiSettings.validateSuccess')
                    : t('aiSettings.validateFailed')
                "
                :closable="false"
                show-icon
              />
            </el-form-item>
          </div>

          <!-- Gemini Imagen -->
          <div class="config-block">
            <div class="block-title">{{ t('aiSettings.gemini') }}</div>
            <div class="form-tip gemini-tip">{{ t('aiSettings.geminiTip') }}</div>
            <el-form-item :label="t('aiSettings.apiKey')">
              <div class="input-with-btn">
                <el-input
                  v-model="apiKeyGemini"
                  type="password"
                  show-password
                  :placeholder="t('aiSettings.geminiPlaceholder')"
                  clearable
                />
                <el-button
                  type="default"
                  :loading="validatingGemini"
                  :disabled="anyLoading || !apiKeyGemini.trim()"
                  @click="handleValidateGemini"
                >
                  {{ t('aiSettings.validate') }}
                </el-button>
              </div>
              <div class="form-tip">
                <el-link
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  type="primary"
                  :underline="false"
                >
                  {{ t('aiSettings.getApiKey') }}
                </el-link>
              </div>
            </el-form-item>
            <el-form-item v-if="apiKeyStatusGemini !== null">
              <el-alert
                :type="apiKeyStatusGemini ? 'success' : 'error'"
                :title="
                  apiKeyStatusGemini
                    ? t('aiSettings.geminiValidateSuccess')
                    : t('aiSettings.geminiValidateFailed')
                "
                :closable="false"
                show-icon
              />
            </el-form-item>
          </div>

          <!-- 豆包（火山方舟） -->
          <div class="config-block">
            <div class="block-title">{{ t('aiSettings.doubao') }}</div>
            <el-form-item :label="t('aiSettings.apiKey')">
              <el-input
                v-model="doubaoApiKey"
                type="password"
                show-password
                :placeholder="t('aiSettings.doubaoPlaceholder')"
                clearable
              />
            </el-form-item>
            <el-form-item :label="t('aiSettings.doubaoModel')">
              <el-input
                v-model="doubaoModel"
                :placeholder="t('aiSettings.doubaoModelPlaceholder')"
                clearable
              />
            </el-form-item>
            <el-form-item :label="t('aiSettings.doubaoBaseUrl')">
              <el-input
                v-model="doubaoBaseUrl"
                :placeholder="t('aiSettings.doubaoBaseUrlPlaceholder')"
                clearable
              />
            </el-form-item>
            <el-form-item>
              <div class="input-with-btn">
                <el-button
                  type="default"
                  :loading="validatingDoubao"
                  :disabled="anyLoading || !doubaoApiKey.trim() || !doubaoModel.trim()"
                  @click="handleValidateDoubao"
                >
                  {{ t('aiSettings.validate') }}
                </el-button>
                <el-link
                  class="form-tip-inline"
                  href="https://console.volcengine.com/ark"
                  target="_blank"
                  type="primary"
                  :underline="false"
                >
                  {{ t('aiSettings.getApiKey') }}
                </el-link>
              </div>
            </el-form-item>
            <el-form-item v-if="apiKeyStatusDoubao !== null">
              <el-alert
                :type="apiKeyStatusDoubao ? 'success' : 'error'"
                :title="
                  apiKeyStatusDoubao
                    ? t('aiSettings.doubaoValidateSuccess')
                    : t('aiSettings.doubaoValidateFailed')
                "
                :closable="false"
                show-icon
              />
            </el-form-item>
          </div>
        </el-form>
      </div>
      <div class="ai-settings-drawer-footer">
        <el-button :disabled="anyLoading" @click="handleClose">{{ t('common.cancel') }}</el-button>
        <el-button
          type="primary"
          :loading="saving"
          :disabled="anyLoading || !booksDirReady"
          @click="handleSave"
        >
          {{ t('common.save') }}
        </el-button>
      </div>
    </div>
  </el-drawer>
</template>

<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import {
  getTongyiwanxiangApiKey,
  setTongyiwanxiangApiKey,
  validateTongyiwanxiangApiKey
} from '@renderer/service/tongyiwanxiang'
import {
  getGeminiApiKey,
  setGeminiApiKey,
  validateGeminiApiKey,
  getDoubaoConfig,
  setDoubaoConfig,
  validateDoubaoConfig
} from '@renderer/service/imageAi'
import {
  getFunctionApiConfig,
  setFunctionApiConfig,
  validateFunctionApiConfig
} from '@renderer/service/functionApi'
import {
  getAgentApiConfig,
  setAgentApiConfig,
  validateAgentApiConfig
} from '@renderer/service/agentApi'

const drawerVisible = ref(false)
const booksDirReady = ref(false)
const loadingConfig = ref(false)
let configGeneration = 0
let loadGeneration = 0
const { t } = useI18n()
const apiKeyTongyi = ref('')
const apiKeyGemini = ref('')
const doubaoApiKey = ref('')
const doubaoModel = ref('')
const doubaoBaseUrl = ref('')
const functionApiEnabled = ref(false)
const functionApiProvider = ref('deepseek')
const functionApiKey = ref('')
const functionApiBaseUrl = ref('https://api.deepseek.com')
const functionApiModel = ref('deepseek-chat')
const functionApiStatus = ref(null)
const functionApiValidationMessage = ref('')
const functionApiValidatedAt = ref(null)
const agentDefaultRuntime = ref('codex-app-server')
const agentProviderId = ref('deepseek')
const agentProviderCatalog = ref([])
const agentProviderConfigs = ref({})
const agentBaseUrl = ref('https://api.deepseek.com')
const agentModel = ref('deepseek-chat')
const agentApiKey = ref('')
const agentThinkingEnabled = ref(true)
const agentApiStatus = ref(null)
const agentApiValidationMessage = ref('')
const agentApiKeyOptional = computed(
  () =>
    agentProviderCatalog.value.find((item) => item.id === agentProviderId.value)?.apiKeyOptional ===
    true
)

const saving = ref(false)
const validatingAgentApi = ref(false)
const validatingTongyi = ref(false)
const validatingGemini = ref(false)
const validatingDoubao = ref(false)
const validatingFunctionApi = ref(false)

const apiKeyStatusTongyi = ref(null)
const apiKeyStatusGemini = ref(null)
const apiKeyStatusDoubao = ref(null)

const anyLoading = computed(
  () =>
    loadingConfig.value ||
    saving.value ||
    validatingAgentApi.value ||
    validatingFunctionApi.value ||
    validatingTongyi.value ||
    validatingGemini.value ||
    validatingDoubao.value
)

function open() {
  drawerVisible.value = true
  loadAllKeys()
}

function handleClose() {
  if (saveTimer) clearTimeout(saveTimer)
  drawerVisible.value = false
  agentApiStatus.value = null
  apiKeyStatusTongyi.value = null
  apiKeyStatusGemini.value = null
  apiKeyStatusDoubao.value = null
  functionApiStatus.value = null
}

async function loadAllKeys() {
  const generation = configGeneration
  const request = ++loadGeneration
  loadingConfig.value = true
  try {
    const booksDir = await window.electronStore.get('booksDir')
    const directory = await window.electron.validateBooksDir(booksDir)
    if (generation !== configGeneration || request !== loadGeneration) return
    booksDirReady.value = directory?.valid === true
    const [agentRes, tongyiRes, geminiRes, doubaoRes, functionRes] = await Promise.all([
      getAgentApiConfig(),
      getTongyiwanxiangApiKey(),
      getGeminiApiKey(),
      getDoubaoConfig(),
      getFunctionApiConfig()
    ])
    if (generation !== configGeneration || request !== loadGeneration) return
    if (agentRes) {
      agentDefaultRuntime.value = agentRes.defaultRuntime || 'codex-app-server'
      agentProviderId.value = agentRes.selectedProvider || 'deepseek'
      agentProviderCatalog.value = Array.isArray(agentRes.catalog) ? agentRes.catalog : []
      agentProviderConfigs.value = agentRes.providers || {}
      applyAgentProvider(agentProviderId.value)
    }
    if (tongyiRes?.success) apiKeyTongyi.value = tongyiRes.apiKey || ''
    if (geminiRes?.success) apiKeyGemini.value = geminiRes.apiKey || ''
    if (doubaoRes?.success) {
      doubaoApiKey.value = doubaoRes.apiKey || ''
      doubaoModel.value = doubaoRes.model || ''
      doubaoBaseUrl.value = doubaoRes.baseUrl || ''
    }
    if (functionRes) {
      functionApiEnabled.value = functionRes.enabled === true
      functionApiProvider.value = functionRes.provider || 'deepseek'
      functionApiKey.value = functionRes.apiKey || ''
      functionApiBaseUrl.value =
        functionRes.baseUrl ||
        (functionApiProvider.value === 'deepseek' ? 'https://api.deepseek.com' : '')
      functionApiModel.value =
        functionRes.model || (functionApiProvider.value === 'deepseek' ? 'deepseek-chat' : '')
      functionApiStatus.value =
        functionRes.lastValidationStatus === 'success'
          ? true
          : functionRes.lastValidationStatus === 'failed'
            ? false
            : null
      functionApiValidationMessage.value = functionRes.lastValidationMessage || ''
      functionApiValidatedAt.value = functionRes.lastValidatedAt || null
    }
  } catch (error) {
    if (generation === configGeneration && request === loadGeneration)
      ElMessage.error(error?.message || '加载 API 设置失败')
  } finally {
    if (generation === configGeneration && request === loadGeneration) loadingConfig.value = false
  }
}

let saveTimer = null

async function handleSave() {
  if (saving.value || !booksDirReady.value || loadingConfig.value) return
  const generation = configGeneration
  const payloads = {
    agent: agentApiPayload(),
    tongyi: apiKeyTongyi.value.trim(),
    gemini: apiKeyGemini.value.trim(),
    doubao: {
      apiKey: doubaoApiKey.value.trim(),
      model: doubaoModel.value.trim(),
      baseUrl: doubaoBaseUrl.value.trim()
    },
    functionApi: functionApiPayload()
  }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    if (generation !== configGeneration) return
    saving.value = true
    try {
      const errs = []
      await setAgentApiConfig(payloads.agent)
      if (generation !== configGeneration) return
      window.dispatchEvent(new CustomEvent('agent-api-config-changed'))
      const r2 = await setTongyiwanxiangApiKey(payloads.tongyi)
      if (generation !== configGeneration) return
      if (!r2?.success) errs.push(r2?.message || t('aiSettings.tongyiSaveFailed'))
      const r3 = await setGeminiApiKey(payloads.gemini)
      if (generation !== configGeneration) return
      if (!r3?.success) errs.push(r3?.message || t('aiSettings.geminiSaveFailed'))
      const r4 = await setDoubaoConfig(payloads.doubao)
      if (generation !== configGeneration) return
      if (!r4?.success) errs.push(r4?.message || t('aiSettings.doubaoSaveFailed'))
      const r5 = await setFunctionApiConfig(payloads.functionApi)
      if (generation !== configGeneration) return
      if (r5?.success === false) errs.push(r5?.message || t('aiSettings.functionApiSaveFailed'))
      if (errs.length) {
        ElMessage.error(errs.join('；'))
      } else {
        ElMessage.success(t('aiSettings.saveSuccess'))
        drawerVisible.value = false
      }
    } catch (error) {
      if (generation === configGeneration)
        ElMessage.error(error?.message || t('aiSettings.saveFailed'))
    } finally {
      if (generation === configGeneration) {
        saving.value = false
        saveTimer = null
      }
    }
  }, 300)
}

function agentApiPayload() {
  return {
    providerId: agentProviderId.value,
    selectedProvider: agentProviderId.value,
    defaultRuntime: agentDefaultRuntime.value,
    baseUrl: agentBaseUrl.value.trim(),
    model: agentModel.value.trim(),
    apiKey: agentApiKey.value.trim(),
    thinkingEnabled: agentThinkingEnabled.value
  }
}

function applyAgentProvider(providerId) {
  const saved = agentProviderConfigs.value?.[providerId] || {}
  const defaults = agentProviderCatalog.value.find((item) => item.id === providerId) || {}
  agentBaseUrl.value = saved.baseUrl || defaults.baseUrl || ''
  agentModel.value = saved.model || defaults.model || ''
  agentApiKey.value = saved.apiKey || ''
  agentThinkingEnabled.value = saved.thinkingEnabled !== false
}

function handleAgentProviderChange(providerId) {
  agentApiStatus.value = null
  agentApiValidationMessage.value = ''
  applyAgentProvider(providerId)
}

async function handleValidateAgentApi() {
  if (validatingAgentApi.value || !booksDirReady.value || loadingConfig.value) return
  const generation = configGeneration
  if (
    !agentBaseUrl.value.trim() ||
    !agentModel.value.trim() ||
    (!agentApiKeyOptional.value && !agentApiKey.value.trim())
  ) {
    ElMessage.warning(t('aiSettings.agentApiPleaseComplete'))
    return
  }
  validatingAgentApi.value = true
  agentApiStatus.value = null
  try {
    const result = await validateAgentApiConfig(agentApiPayload())
    if (generation !== configGeneration) return
    agentApiStatus.value = Boolean(result?.isValid)
    agentApiValidationMessage.value = result?.message || ''
    if (result?.config) {
      agentProviderConfigs.value = result.config.providers || agentProviderConfigs.value
      window.dispatchEvent(new CustomEvent('agent-api-config-changed'))
    }
    if (result?.isValid) ElMessage.success(t('aiSettings.agentApiValidateSuccess'))
    else ElMessage.error(result?.message || t('aiSettings.agentApiValidateFailed'))
  } catch (error) {
    if (generation !== configGeneration) return
    agentApiStatus.value = false
    agentApiValidationMessage.value = error?.message || t('aiSettings.agentApiValidateFailed')
    ElMessage.error(agentApiValidationMessage.value)
  } finally {
    if (generation === configGeneration) validatingAgentApi.value = false
  }
}

function functionApiPayload() {
  return {
    enabled: functionApiEnabled.value,
    provider: functionApiProvider.value,
    apiKey: functionApiKey.value.trim(),
    baseUrl: functionApiBaseUrl.value.trim(),
    model: functionApiModel.value.trim(),
    tasks: ['conversation_title']
  }
}

function handleFunctionProviderChange(provider) {
  functionApiStatus.value = null
  functionApiValidationMessage.value = ''
  functionApiValidatedAt.value = null
  if (provider === 'deepseek') {
    functionApiBaseUrl.value = 'https://api.deepseek.com'
    functionApiModel.value = 'deepseek-chat'
  } else {
    if (functionApiBaseUrl.value === 'https://api.deepseek.com') functionApiBaseUrl.value = ''
    if (functionApiModel.value === 'deepseek-chat') functionApiModel.value = ''
  }
}

function formatValidationTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString()
}

async function handleValidateFunctionApi() {
  if (validatingFunctionApi.value || !booksDirReady.value || loadingConfig.value) return
  const generation = configGeneration
  if (!functionApiKey.value.trim() || !functionApiModel.value.trim()) {
    ElMessage.warning(t('aiSettings.functionApiPleaseComplete'))
    return
  }
  if (functionApiProvider.value === 'custom' && !functionApiBaseUrl.value.trim()) {
    ElMessage.warning(t('aiSettings.functionApiPleaseComplete'))
    return
  }
  validatingFunctionApi.value = true
  functionApiStatus.value = null
  try {
    const result = await validateFunctionApiConfig(functionApiPayload())
    if (generation !== configGeneration) return
    functionApiStatus.value = Boolean(result?.isValid)
    functionApiValidationMessage.value = result?.message || ''
    functionApiValidatedAt.value = result?.config?.lastValidatedAt || new Date().toISOString()
    if (result?.isValid) ElMessage.success(t('aiSettings.functionApiValidateSuccess'))
    else ElMessage.error(result?.message || t('aiSettings.functionApiValidateFailed'))
  } catch (error) {
    if (generation !== configGeneration) return
    functionApiStatus.value = false
    functionApiValidationMessage.value = error?.message || t('aiSettings.functionApiValidateFailed')
    ElMessage.error(functionApiValidationMessage.value)
  } finally {
    if (generation === configGeneration) validatingFunctionApi.value = false
  }
}

let validateTongyiTimer = null

async function handleValidateTongyi() {
  if (validatingTongyi.value || !booksDirReady.value || loadingConfig.value) return
  const generation = configGeneration
  const apiKey = apiKeyTongyi.value.trim()
  if (!apiKeyTongyi.value.trim()) {
    ElMessage.warning(t('aiSettings.pleaseInputTongyi'))
    return
  }
  if (validateTongyiTimer) clearTimeout(validateTongyiTimer)
  validateTongyiTimer = setTimeout(async () => {
    if (generation !== configGeneration) return
    validatingTongyi.value = true
    apiKeyStatusTongyi.value = null
    try {
      await setTongyiwanxiangApiKey(apiKey)
      if (generation !== configGeneration) return
      const result = await validateTongyiwanxiangApiKey()
      if (generation !== configGeneration) return
      if (result?.success && result.isValid) {
        apiKeyStatusTongyi.value = true
        ElMessage.success(t('aiSettings.tongyiValidateSuccess'))
      } else {
        apiKeyStatusTongyi.value = false
        ElMessage.error(result?.message || t('aiSettings.tongyiValidateFailed'))
      }
    } catch {
      if (generation !== configGeneration) return
      apiKeyStatusTongyi.value = false
      ElMessage.error(t('aiSettings.validateNetworkFailed'))
    } finally {
      if (generation === configGeneration) {
        validatingTongyi.value = false
        validateTongyiTimer = null
      }
    }
  }, 500)
}

let validateGeminiTimer = null

async function handleValidateGemini() {
  if (validatingGemini.value || !booksDirReady.value || loadingConfig.value) return
  const generation = configGeneration
  const apiKey = apiKeyGemini.value.trim()
  if (!apiKeyGemini.value.trim()) {
    ElMessage.warning(t('aiSettings.pleaseInputGemini'))
    return
  }
  if (validateGeminiTimer) clearTimeout(validateGeminiTimer)
  validateGeminiTimer = setTimeout(async () => {
    if (generation !== configGeneration) return
    validatingGemini.value = true
    apiKeyStatusGemini.value = null
    try {
      await setGeminiApiKey(apiKey)
      if (generation !== configGeneration) return
      const result = await validateGeminiApiKey()
      if (generation !== configGeneration) return
      if (result?.success && result.isValid) {
        apiKeyStatusGemini.value = true
        ElMessage.success(t('aiSettings.geminiValidateSuccess'))
      } else {
        apiKeyStatusGemini.value = false
        ElMessage.error(result?.message || t('aiSettings.geminiValidateFailed'))
      }
    } catch {
      if (generation !== configGeneration) return
      apiKeyStatusGemini.value = false
      ElMessage.error(t('aiSettings.validateNetworkFailed'))
    } finally {
      if (generation === configGeneration) {
        validatingGemini.value = false
        validateGeminiTimer = null
      }
    }
  }, 500)
}

let validateDoubaoTimer = null

async function handleValidateDoubao() {
  if (validatingDoubao.value || !booksDirReady.value || loadingConfig.value) return
  const generation = configGeneration
  const payload = {
    apiKey: doubaoApiKey.value.trim(),
    model: doubaoModel.value.trim(),
    baseUrl: doubaoBaseUrl.value.trim()
  }
  if (!doubaoApiKey.value.trim() || !doubaoModel.value.trim()) {
    ElMessage.warning(t('aiSettings.pleaseInputDoubao'))
    return
  }
  if (validateDoubaoTimer) clearTimeout(validateDoubaoTimer)
  validateDoubaoTimer = setTimeout(async () => {
    if (generation !== configGeneration) return
    validatingDoubao.value = true
    apiKeyStatusDoubao.value = null
    try {
      await setDoubaoConfig(payload)
      if (generation !== configGeneration) return
      const result = await validateDoubaoConfig()
      if (generation !== configGeneration) return
      if (result?.success && result.isValid) {
        apiKeyStatusDoubao.value = true
        ElMessage.success(t('aiSettings.doubaoValidateSuccess'))
      } else {
        apiKeyStatusDoubao.value = false
        ElMessage.error(result?.message || t('aiSettings.doubaoValidateFailed'))
      }
    } catch {
      if (generation !== configGeneration) return
      apiKeyStatusDoubao.value = false
      ElMessage.error(t('aiSettings.validateNetworkFailed'))
    } finally {
      if (generation === configGeneration) {
        validatingDoubao.value = false
        validateDoubaoTimer = null
      }
    }
  }, 500)
}

function invalidateDirectoryOperations() {
  configGeneration += 1
  for (const timer of [saveTimer, validateTongyiTimer, validateGeminiTimer, validateDoubaoTimer])
    clearTimeout(timer)
  saveTimer = validateTongyiTimer = validateGeminiTimer = validateDoubaoTimer = null
  saving.value =
    validatingAgentApi.value =
    validatingFunctionApi.value =
    validatingTongyi.value =
    validatingGemini.value =
    validatingDoubao.value =
      false
  booksDirReady.value = false
  apiKeyTongyi.value =
    apiKeyGemini.value =
    doubaoApiKey.value =
    agentApiKey.value =
    functionApiKey.value =
      ''
  agentProviderConfigs.value = {}
  agentApiStatus.value =
    functionApiStatus.value =
    apiKeyStatusTongyi.value =
    apiKeyStatusGemini.value =
    apiKeyStatusDoubao.value =
      null
}

const removeDirectoryListener = window.electron.onApiConfigDirectoryChanged?.(() => {
  invalidateDirectoryOperations()
  void loadAllKeys()
  window.dispatchEvent(new CustomEvent('agent-api-config-changed'))
})
onBeforeUnmount(() => {
  invalidateDirectoryOperations()
  removeDirectoryListener?.()
})

defineExpose({ open })
</script>

<style scoped>
.ai-settings-drawer-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.ai-settings-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 20px 8px;
}
.ai-settings-drawer-footer {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}
.section-heading {
  font-size: 13px;
  font-weight: 600;
  color: #606266;
  margin-bottom: 8px;
}
.section-heading-spaced {
  margin-top: 8px;
}
.config-block {
  margin-bottom: 20px;
}
.config-block:last-child {
  margin-bottom: 0;
}
.function-api-block :deep(.el-alert) {
  margin-bottom: 16px;
}
.block-title {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #ebeef5;
}
.input-with-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}
.input-with-btn :deep(.el-input) {
  flex: 1;
}
.form-tip {
  margin-top: 8px;
  font-size: 12px;
  color: #999;
}
.form-tip-inline {
  font-size: 12px;
}
.gemini-tip {
  margin-bottom: 12px;
  margin-top: -4px;
  line-height: 1.5;
}
.el-form-item {
  margin-bottom: 20px;
}
</style>
