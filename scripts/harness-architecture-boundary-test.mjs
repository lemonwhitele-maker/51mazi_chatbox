import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join, relative } from 'node:path'
import HarnessStore from '../src/main/harness/store/harnessStore.js'
import DomainToolRegistry from '../src/main/harness/tools/domainToolRegistry.js'
import { createBookReadTools } from '../src/main/harness/tools/bookReadTools.js'

const root = process.cwd()
const sourceRoot = join(root, 'src')
const adapterAllowed = new Set([
  'main/services/codexAppServerBridge.js',
  'main/harness/runtime/codexAppServerRuntime.js'
])
const forbiddenProviderStrings = [/thread\/start/, /thread\/resume/, /turn\/start/, /item\/tool\/call/]
const forbiddenLegacyStrings = [/codexAgent\./, /codex:(?:get|send|create|list|login)/, /AgentChatSidebar/, /codexClient/, /CodexQuickNotes/, /\.codex[\\/]quick-notes\.md/]
const forbiddenDirectWriteToolName = /^(?:save|write|edit|apply|replace|overwrite|update)_?chapter(?:_|$)/i
const forbiddenProposalWritePrimitive = /chapterWriteService|writeChapterWithExpectedHash|saveChapter\s*\(/i
const removedDirectEditorAiStrings = [
  /deepseek:polish-text/,
  /deepseek:continue-write/,
  /polishTextWithAI/,
  /continueWriteWithAI/
]

async function filesUnder(path) {
  const entries = await fs.readdir(path, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    const full = join(path, entry.name)
    if (entry.isDirectory()) result.push(...await filesUnder(full))
    else if (/\.(?:js|mjs|ts|vue)$/.test(entry.name)) result.push(full)
  }
  return result
}

function assertCoreBoundary(text, label) {
  for (const pattern of forbiddenProviderStrings) assert.doesNotMatch(text, pattern, `${label} 不应直接包含 Provider 协议字段 ${pattern}`)
}

function assertRuntimeToolBoundary(definitions, label = 'Runtime 工具目录') {
  for (const definition of definitions) {
    assert.doesNotMatch(
      String(definition?.name || ''),
      forbiddenDirectWriteToolName,
      `${label} 不得暴露直接章节写入工具`
    )
    if (definition?.risk === 'proposal') {
      assert.doesNotMatch(
        String(definition.execute || ''),
        forbiddenProposalWritePrimitive,
        `${label} 的 proposal 工具不得调用正式章节写入服务`
      )
    }
  }
}

const allFiles = await filesUnder(sourceRoot)
for (const file of allFiles) {
  const rel = relative(sourceRoot, file).replaceAll('\\', '/')
  const text = await fs.readFile(file, 'utf8')
  if (!adapterAllowed.has(rel) && !rel.startsWith('main/harness/runtime/codex-schema/') && !rel.startsWith('main/harness/migration/')) assertCoreBoundary(text, rel)
  if (!adapterAllowed.has(rel) && !rel.startsWith('main/harness/runtime/codex-schema/') && !rel.startsWith('main/harness/migration/')) {
    for (const pattern of forbiddenLegacyStrings) assert.doesNotMatch(text, pattern, `${rel} 仍包含已退役旧 Harness 引用 ${pattern}`)
  }
  if (rel.startsWith('main/harness/tools/')) {
    assert.doesNotMatch(
      text,
      forbiddenProposalWritePrimitive,
      `${rel} 不得依赖正式章节写入原语`
    )
  }
  for (const pattern of removedDirectEditorAiStrings) {
    assert.doesNotMatch(text, pattern, `${rel} 不得恢复已删除的编辑器 AI 润色/续写直连链路`)
  }
}

assert.throws(() => assertCoreBoundary('accidental thread/start'), /Provider 协议字段/)

const registry = new DomainToolRegistry()
createBookReadTools({
  retrievalService: {},
  conversationRetrievalService: {}
}).forEach((tool) => registry.register(tool))
assertRuntimeToolBoundary(registry.listDefinitions())
assert.throws(
  () => assertRuntimeToolBoundary([{ name: 'save_chapter', risk: 'read' }], '故意违规工具'),
  /不得暴露直接章节写入工具/
)
assert.throws(
  () =>
    assertRuntimeToolBoundary([
      {
        name: 'propose_chapter_edit',
        risk: 'proposal',
        execute() {
          return globalThis.chapterWriteService.writeChapterWithExpectedHash()
        }
      }
    ], '故意违规提案工具'),
  /不得调用正式章节写入服务/
)

const tempRoot = await fs.mkdtemp(join(os.tmpdir(), '51mazi-boundary-'))
const snapshotService = { resolveBookPath: () => tempRoot }
const store = new HarnessStore({ snapshotService })
try {
  const conversation = await store.createConversation({ bookKey: '边界书', runtimeId: 'fake' })
  const runtimeText = JSON.stringify((await store.loadConversation('边界书', conversation.conversationId)).runtime)
  for (const name of ['threadId', 'turnId', 'previous_response_id', 'conversation_id']) assert.equal(runtimeText.includes(name), false, `runtime.json 不应保存 ${name}`)
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true })
}
console.log('harness architecture boundary test passed')
