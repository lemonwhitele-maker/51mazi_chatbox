import { createId } from '../ids.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A deterministic runtime used by tests and local Harness smoke checks. */
export class FakeRuntime {
  constructor({ script = null } = {}) {
    this.id = 'fake'
    this.script = script
    this.active = new Map()
    this.calls = []
  }

  async getCapabilities() {
    return {
      streaming: true,
      nativeToolCalling: true,
      isolatedTurn: true,
      cancellableTurn: true,
      instructionChannels: true,
      dynamicTools: true,
      usageReporting: true,
      contextWindowTokens: 32000,
      maxOutputTokens: 4096,
      experimental: []
    }
  }

  async *streamTurn(input) {
    const execution = {
      providerExecutionHandle: createId('fake-exec'),
      input,
      toolResults: new Map(),
      waiters: new Map(),
      emittedCalls: new Set(),
      cancelled: false
    }
    this.active.set(input.turnId, execution)
    this.calls.push({ turnId: input.turnId, conversationId: input.conversationId, instructions: input.instructions, contextText: input.contextText, userText: input.userText })
    try {
      const scripted = typeof this.script === 'function' ? await this.script(input) : this.script
      const events = Array.isArray(scripted) ? scripted : null
      if (events) {
        for (const event of events) {
          if (input.signal.aborted || execution.cancelled) {
            yield { type: 'turn.cancelled', reason: 'cancelled' }
            return
          }
          if (event.type === 'tool.call') execution.emittedCalls.add(event.providerCallId)
          yield event
          if (event.type === 'tool.call') await this.waitForToolResult(execution, event.providerCallId)
        }
        return
      }

      yield { type: 'message.delta', text: 'Fake Runtime 已接收本轮请求。' }
      yield {
        type: 'message.completed',
        text: 'Fake Runtime 已接收本轮请求。',
        providerItemId: createId('fake-message')
      }
      yield { type: 'turn.completed', stopReason: 'completed' }
    } finally {
      this.active.delete(input.turnId)
    }
  }

  waitForToolResult(execution, providerCallId) {
    const existing = execution.toolResults.get(providerCallId)
    if (existing) return Promise.resolve(existing)
    const wait = deferred()
    execution.waiters.set(providerCallId, wait)
    return wait.promise
  }

  async submitToolResult(input) {
    const execution = this.active.get(input.turnId)
    if (!execution) return { status: 'turn_missing' }
    if (!execution.emittedCalls.has(input.providerCallId)) return { status: 'call_missing' }
    execution.toolResults.set(input.providerCallId, input.result)
    execution.waiters.get(input.providerCallId)?.resolve(input.result)
    execution.waiters.delete(input.providerCallId)
    return { status: 'accepted' }
  }

  async cancelTurn({ turnId }) {
    const execution = this.active.get(turnId)
    if (!execution) return
    execution.cancelled = true
    for (const wait of execution.waiters.values()) wait.resolve({ ok: false, cancelled: true })
    execution.waiters.clear()
  }

  async disposeTurn({ turnId }) {
    this.active.delete(turnId)
  }
}

export default FakeRuntime
