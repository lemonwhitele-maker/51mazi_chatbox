import { ref, watch, computed, onBeforeUnmount } from 'vue'
import {
  listConfiguredImageProviders,
  getImageAiLastProvider,
  setImageAiLastProvider
} from '@renderer/service/imageAi'

/**
 * 出图界面：已配置的图像服务商列表与当前选择（与 imageAi.lastProvider 同步）
 * @param {import('vue').Ref<boolean>} modelValueRef 抽屉/对话框是否打开
 */
export function useImageAiProviderSelect(modelValueRef) {
  const imageProviders = ref([])
  const selectedProvider = ref('')
  const providersLoaded = ref(false)
  let generation = 0
  let applyingSavedProvider = false

  async function refreshProviders() {
    const request = ++generation
    const res = await listConfiguredImageProviders()
    const lastRes = await getImageAiLastProvider()
    if (request !== generation) return
    imageProviders.value = res?.success && Array.isArray(res.providers) ? [...res.providers] : []
    const lastId = lastRes?.success ? lastRes.provider : null
    applyingSavedProvider = true
    if (lastId && imageProviders.value.includes(lastId)) {
      selectedProvider.value = lastId
    } else if (imageProviders.value.length > 0) {
      selectedProvider.value = imageProviders.value[0]
    } else {
      selectedProvider.value = ''
    }
    applyingSavedProvider = false
    providersLoaded.value = true
  }

  watch(
    modelValueRef,
    (open) => {
      if (open)
        void refreshProviders().catch(() => {
          providersLoaded.value = true
        })
    },
    { flush: 'post' }
  )

  watch(
    selectedProvider,
    (p) => {
      if (!applyingSavedProvider && p && String(p).trim()) {
        setImageAiLastProvider(String(p).trim()).catch(() => {})
      }
    },
    { flush: 'sync' }
  )

  const removeDirectoryListener = window.electron.onApiConfigDirectoryChanged?.(() => {
    generation += 1
    applyingSavedProvider = true
    selectedProvider.value = ''
    applyingSavedProvider = false
    imageProviders.value = []
    providersLoaded.value = false
    if (modelValueRef.value)
      void refreshProviders().catch(() => {
        providersLoaded.value = true
      })
  })
  onBeforeUnmount(() => {
    generation += 1
    removeDirectoryListener?.()
  })

  const noImageProviders = computed(
    () => providersLoaded.value && imageProviders.value.length === 0
  )

  return {
    imageProviders,
    selectedProvider,
    noImageProviders,
    providersLoaded,
    refreshProviders
  }
}
