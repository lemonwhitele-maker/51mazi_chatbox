import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolve, join } from 'node:path'
import CodexAppServerRuntime from '../src/main/harness/runtime/codexAppServerRuntime.js'
import { assertBookSandboxRuntime } from '../src/main/harness/runtime/modelRuntime.js'
import documentToolContracts from '../src/main/harness/tools/contracts/documentToolContracts.js'

// Explicit opt-in test: uses the locally configured Codex provider and incurs a model request.
const runtime = new CodexAppServerRuntime()
const root = resolve('.codex-compatibility-smoke')
const turnId = `smoke_${Date.now()}`
const tools = documentToolContracts
let calledRead = false
let completed = false
let answer = ''
const timer = setTimeout(() => { void runtime.cancelTurn({ turnId }) }, 90000)
try {
  const admission = await assertBookSandboxRuntime(runtime, { tools })
  assert.equal(admission.mode, 'codex-readonly-compatibility')
  for await (const event of runtime.streamTurn({
    turnId,
    signal: new AbortController().signal,
    model: process.argv[2] || null,
    bookRootRealPath: root,
    runtimeDirectory: join(root, '.51mazi', 'harness', 'runtime', turnId),
    tools,
    instructions: {
      baseInstructions: 'This is a connection test. Use only the provided read tool. Do not use native tools, shell, filesystem, web, MCP, or modification tools.',
      developerInstructions: 'Call read with path help/index.md exactly once, then return the marker in its result.'
    },
    userText: 'Call read({"path":"help/index.md"}) and return its marker.',
    contextText: '',
    trace: async (type, payload) => {
      if (type === 'model.error') console.log(type, JSON.stringify(payload))
    }
  })) {
    if (event.type === 'tool.call') {
      assert.equal(event.name, 'read')
      const args = event.arguments || JSON.parse(event.argumentsJson)
      assert.equal(args.path, 'help/index.md')
      calledRead = true
      await runtime.submitToolResult({ turnId, providerCallId: event.providerCallId,
        result: { ok: true, marker: 'MAZI_COMPAT_OK', text: 'Return MAZI_COMPAT_OK.' } })
    }
    if (event.type === 'message.completed') answer = event.text || answer
    if (event.type === 'turn.failed') throw new Error(`${event.code}: ${event.message}`)
    if (event.type === 'turn.completed') completed = true
  }
  assert.ok(calledRead, 'The model must call the project read tool')
  assert.ok(completed, 'The model turn must complete')
  assert.match(answer, /MAZI_COMPAT_OK/)
  console.log('Codex compatibility live test passed: admission, provider, tool callback, final answer.')
} finally {
  clearTimeout(timer)
  await runtime.dispose()
  // Remove only empty directories created by this test; never delete user files.
  for (const path of [join(root, '.51mazi', 'harness', 'runtime'), join(root, '.51mazi', 'harness'), join(root, '.51mazi'), root]) {
    await fs.rmdir(path).catch(() => {})
  }
}
