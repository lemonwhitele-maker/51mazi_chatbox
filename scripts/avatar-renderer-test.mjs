import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { getAvatarSrc, syncCharacterAvatars } from '../src/renderer/src/utils/characterAvatar.js'
import { pathToLocalFileUrl } from '../src/renderer/src/utils/localFileUrl.js'

const library = 'D:/资料 书库/BookList'
const book = '测试书'
const relative = 'character_images/人物 甲.png'
assert.equal(
  getAvatarSrc(relative, library, book),
  pathToLocalFileUrl(`${library}/${book}/${relative}`)
)
assert.equal(
  getAvatarSrc(relative, 'E:/搬家', book),
  pathToLocalFileUrl(`E:/搬家/${book}/${relative}`)
)
assert.equal(getAvatarSrc('../outside.png', library, book), '')
assert.equal(getAvatarSrc('https://example.test/avatar.png'), 'https://example.test/avatar.png')
assert.equal(getAvatarSrc('data:image/png;base64,YQ=='), 'data:image/png;base64,YQ==')
const nodes = [
  { data: { characterId: 'one', avatar: 'old.png', avatarSource: 'character' } },
  { data: { characterId: 'one', avatar: 'custom.png', avatarSource: 'custom' } },
  { data: { characterId: 'one', avatar: 'old.png' } },
  { data: { characterId: 'one', avatar: '' } },
  { data: { characterId: 'one', avatar: '', avatarSource: 'custom' } },
  { data: { characterId: 'one', avatar: 'unrelated.png' } },
  { data: { characterId: 'missing', avatar: 'old.png' } }
]
syncCharacterAvatars(
  nodes,
  [{ id: 'one', avatar: relative }],
  [{ id: 'one', avatar: 'old.png' }],
  library,
  book
)
assert.deepEqual(
  nodes.map((node) => node.data.avatar),
  [relative, 'custom.png', relative, relative, '', 'unrelated.png', 'old.png']
)
assert.equal(nodes[2].data.avatarSource, 'character')
assert.equal(nodes[3].data.avatarSource, 'character')

const ref = (value) => ({ value })
const computed = (getter) => ({
  get value() {
    return getter()
  }
})
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function component(file, context, exposed) {
  const source = await fs.readFile(new URL(`../src/renderer/src/${file}`, import.meta.url), 'utf8')
  const script = source
    .match(/<script setup>([\s\S]*?)<\/script>/)[1]
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?\n/gm, '')
  const errors = []
  const sandbox = {
    ref,
    computed,
    nextTick: async () => {},
    watch: () => {},
    onMounted: () => {},
    onBeforeUnmount: () => {},
    defineExpose: () => {},
    crypto: { randomUUID },
    useI18n: () => ({ t: (key) => key }),
    ElMessage: {
      error: (message) => errors.push(message),
      warning: () => {},
      success: () => {},
      info: () => {}
    },
    setTimeout,
    clearTimeout,
    console,
    ...context
  }
  return { api: vm.runInNewContext(`${script}\n;({${exposed.join(',')}})`, sandbox), errors }
}

const watchers = []
const discards = []
const emitted = []
const requests = []
let pendingGeneration = deferred()
let confirmCount = 0
let rejectSave = true
const drawerProps = {
  modelValue: false,
  bookName: book,
  characterName: '测试人物',
  appearance: '测试人物形象',
  confirmImage: async () => {
    if (rejectSave) throw new Error('版本冲突')
  }
}
const drawer = await component(
  'components/AICharacterDrawer.vue',
  {
    defineProps: () => drawerProps,
    defineEmits:
      () =>
      (...args) =>
        emitted.push(args),
    toRef: (object, key) => ({
      get value() {
        return object[key]
      }
    }),
    watch: (getter, callback) => watchers.push(callback),
    useImageAiProviderSelect: () => ({
      imageProviders: ref(['tongyi']),
      selectedProvider: ref('tongyi'),
      noImageProviders: ref(false),
      providersLoaded: ref(true)
    }),
    pathToLocalFileUrl,
    generateAICharacterImage: (request) => {
      requests.push(request)
      return pendingGeneration.promise
    },
    confirmAICharacterImage: async ({ sessionId }) => {
      confirmCount += 1
      return {
        success: true,
        sessionId,
        localPath: `${library}/${book}/${relative}`,
        relativePath: relative
      }
    },
    discardAICharacterImages: async (request) => discards.push(request),
    window: { electron: {} }
  },
  [
    'formRef',
    'handleGenerate',
    'handleCancel',
    'handleConfirmUse',
    'generatedList',
    'selectedPath',
    'confirming'
  ]
)
drawer.api.formRef.value = { validate: async () => true }
watchers[0](true)
const late = drawer.api.handleGenerate()
await new Promise(setImmediate)
const firstSession = requests[0].sessionId
drawer.api.handleCancel()
watchers[0](true)
pendingGeneration.resolve({ success: true, localPath: 'D:/temporary-old.png' })
await late
assert.equal(
  drawer.api.generatedList.value.length,
  0,
  'cancelled generation must not enter reopened drawer'
)
assert.ok(
  discards.every((request) => request.bookName === book && request.sessionId === firstSession)
)
pendingGeneration = deferred()
const current = drawer.api.handleGenerate()
await new Promise(setImmediate)
assert.notEqual(requests[1].sessionId, firstSession)
assert.equal(requests[1].size, '720*1280')
pendingGeneration.resolve({ success: true, localPath: 'D:/temporary-new.png' })
await current
const closeCount = emitted.filter(([name]) => name === 'update:modelValue').length
await drawer.api.handleConfirmUse()
assert.equal(emitted.filter(([name]) => name === 'update:modelValue').length, closeCount)
assert.equal(drawer.api.generatedList.value.length, 1, 'conflict must retain candidate')
assert.equal(drawer.errors.at(-1), '版本冲突')
rejectSave = false
await drawer.api.handleConfirmUse()
assert.equal(confirmCount, 1, 'retry formal save reuses the already confirmed image')
assert.equal(emitted.filter(([name]) => name === 'update:modelValue').length, closeCount + 1)

let written
let saveConflict = true
const localDrafts = new Map()
const workspace = await component(
  'components/Knowledge/KnowledgeDocumentWorkspace.vue',
  {
    defineProps: () => ({ bookName: book, scope: 'characters' }),
    getAvatarSrc,
    window: {
      electron: {
        validateKnowledgeDocument: async () => ({
          success: true,
          validation: { valid: true },
          metadata: { title: '测试人物' },
          sections: []
        }),
        writeCharacterAvatar: async (...args) => {
          written = args
          return saveConflict
            ? { success: false, code: 'KNOWLEDGE_DOCUMENT_VERSION_CONFLICT' }
            : {
                success: true,
                document: { id: 'one', source: 'saved with avatar', fileHash: 'new-hash' },
                saved: { undoToken: 'undo-one' }
              }
        },
        listKnowledgeDocuments: async () => ({
          success: true,
          documents: [{ targetId: 'one', avatar: relative }]
        })
      },
      localStorage: {
        setItem: (key, value) => localDrafts.set(key, value),
        removeItem: (key) => localDrafts.delete(key)
      },
      dispatchEvent: () => {}
    },
    CustomEvent: class {
      constructor(name, payload) {
        this.name = name
        this.detail = payload.detail
      }
    }
  },
  ['currentDocument', 'source', 'savedSource', 'saveCharacterAvatar', 'lastUndoToken', 'documents']
)
workspace.api.currentDocument.value = { id: 'one', fileHash: 'original-hash' }
workspace.api.source.value = 'current unsaved character text'
workspace.api.savedSource.value = 'old saved text'
await assert.rejects(
  workspace.api.saveCharacterAvatar({ relativePath: relative }),
  /文件已被外部修改/
)
assert.equal(workspace.api.source.value, 'current unsaved character text')
assert.equal(localDrafts.size, 1)
assert.deepEqual(Array.from(written), [
  book,
  'one',
  'current unsaved character text',
  'original-hash',
  relative
])
saveConflict = false
await workspace.api.saveCharacterAvatar({ relativePath: relative })
assert.equal(workspace.api.source.value, 'saved with avatar')
assert.equal(workspace.api.lastUndoToken.value, 'undo-one')
assert.equal(localDrafts.size, 0)
assert.equal(workspace.api.documents.value[0].avatar, relative)

const timers = new Map()
let timerId = 0
let directoryChanged
let setAgentPending = deferred()
const writes = []
const settings = await component(
  'components/AISettings.vue',
  {
    setTimeout: (callback) => {
      timers.set(++timerId, callback)
      return timerId
    },
    clearTimeout: (id) => timers.delete(id),
    getAgentApiConfig: async () => ({ selectedProvider: 'deepseek', providers: {}, catalog: [] }),
    getTongyiwanxiangApiKey: async () => ({ success: true, apiKey: 'new-library-test-key' }),
    getGeminiApiKey: async () => ({ success: true, apiKey: '' }),
    getDoubaoConfig: async () => ({ success: true }),
    getFunctionApiConfig: async () => ({}),
    setAgentApiConfig: async () => {
      writes.push('agent')
      await setAgentPending.promise
    },
    setTongyiwanxiangApiKey: async () => {
      writes.push('tongyi')
      return { success: true }
    },
    setGeminiApiKey: async () => {
      writes.push('gemini')
      return { success: true }
    },
    setDoubaoConfig: async () => {
      writes.push('doubao')
      return { success: true }
    },
    setFunctionApiConfig: async () => {
      writes.push('function')
      return { success: true }
    },
    window: {
      electronStore: { get: async () => library },
      electron: {
        validateBooksDir: async () => ({ valid: true }),
        onApiConfigDirectoryChanged: (callback) => {
          directoryChanged = callback
        }
      },
      dispatchEvent: () => {}
    },
    CustomEvent: class {}
  },
  ['loadAllKeys', 'handleSave', 'apiKeyTongyi', 'booksDirReady']
)
await settings.api.loadAllKeys()
settings.api.apiKeyTongyi.value = 'old-form-test-key'
await settings.api.handleSave()
const scheduled = [...timers.values()].at(-1)
const saving = scheduled()
await new Promise(setImmediate)
directoryChanged()
setAgentPending.resolve()
await saving
await settings.api.loadAllKeys()
assert.deepEqual(writes, ['agent'], 'directory change stops later writes from stale form')
assert.equal(settings.api.apiKeyTongyi.value, 'new-library-test-key')
await settings.api.handleSave()
directoryChanged()
assert.equal(timers.size, 0, 'directory change cancels queued saves')

console.log(
  'Avatar renderer tests passed: portable paths, linked/custom avatars, cancelled generations, save conflicts/retry, and API directory isolation.'
)
