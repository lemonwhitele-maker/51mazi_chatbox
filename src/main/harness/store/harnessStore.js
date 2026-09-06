import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { createId, nowIso } from '../ids.js'
import { emptyMemory } from '../context/memoryCompactor.js'
import { HarnessError } from '../harnessErrors.js'
import { isLibraryMetadataName } from '../../services/libraryApiConfigStore.js'

const EMPTY_MEMORY = (conversationId) => emptyMemory(conversationId)

function storedPreference(value) {
  const preference = typeof value === 'string' ? value.trim() : ''
  return preference && preference !== 'codex-default' && preference !== '[object Object]' ? preference : null
}

async function atomicWriteJson(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, path)
}

function safeName(value) {
  const name = String(value || '').trim()
  if (!name || name.includes('..') || /[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) throw new Error('书籍名称无效')
  return name
}

export class HarnessStore {
  constructor({ snapshotService }) { this.snapshotService = snapshotService; this.locks = new Map() }

  async withLock(key, action) {
    const previous = this.locks.get(key) || Promise.resolve()
    const current = previous.then(action, action)
    this.locks.set(key, current.catch(() => {}))
    return current
  }

  getBase(bookKey) { return join(this.snapshotService.resolveBookPath(safeName(bookKey)), '.51mazi', 'harness', 'v1') }
  getConversationDir(bookKey, id) { return join(this.getBase(bookKey), 'conversations', safeName(id)) }
  getProposalsPath(bookKey, id) { return join(this.getConversationDir(bookKey, id), 'write-proposals.json') }
  getKnowledgeProposalsPath(bookKey, id) { return join(this.getConversationDir(bookKey, id), 'knowledge-proposals.json') }
  getUndoSnapshotPath(bookKey, id, proposalId) {
    return join(this.getConversationDir(bookKey, id), 'write-undo', `${safeName(proposalId)}.json`)
  }

  async ensureBase(bookKey) { const base = this.getBase(bookKey); await fsp.mkdir(join(base, 'conversations'), { recursive: true }); return base }
  async readJson(path, fallback) { try { return JSON.parse(await fsp.readFile(path, 'utf8')) } catch (error) { if (fallback !== undefined && (error.code === 'ENOENT' || error.name === 'SyntaxError')) return fallback; throw error } }
  async writeJson(path, value) { await fsp.mkdir(join(path, '..'), { recursive: true }); await atomicWriteJson(path, value); return value }

  async readTranscript(path) {
    try { const text = await fsp.readFile(path, 'utf8'); const lines = text.split('\n'); const result = []
      for (let i = 0; i < lines.length; i += 1) { const line = lines[i]; if (!line.trim()) continue; try { result.push(JSON.parse(line)) } catch (error) { if (i === lines.length - 1) break; throw error } }
      return result
    } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }

  async listConversations(bookKey) { const base = await this.ensureBase(bookKey); const indexPath = join(base, 'conversations.json'); const index = await this.readJson(indexPath, { schemaVersion: 1, conversations: [] }); return index.conversations || [] }

  async syncIndex(state) {
    const base = await this.ensureBase(state.bookKey)
    const indexPath = join(base, 'conversations.json')
    const index = await this.readJson(indexPath, { schemaVersion: 1, conversations: [] })
    index.schemaVersion = 1
    index.conversations = [state, ...(index.conversations || []).filter((item) => item.conversationId !== state.conversationId)]
    await atomicWriteJson(indexPath, index)
  }

  async createConversation({
    bookKey,
    title = '新对话',
    runtimeId = 'codex-app-server',
    modelPreference = null,
    effortPreference = null,
    autoTitle = false
  }) {
    await this.ensureBase(bookKey); const id = createId('conv'); const now = nowIso()
    const state = {
      schemaVersion: 1,
      revision: 0,
      conversationId: id,
      bookKey: safeName(bookKey),
      title: String(title || '新对话').slice(0, 120),
      titleSource: autoTitle ? 'local' : 'manual',
      autoTitleStatus: autoTitle ? 'pending' : 'disabled',
      autoTitleAttemptedAt: null,
      status: 'idle',
      runtimeId: runtimeId === 'fake'
        ? 'fake'
        : runtimeId === 'agent-router' || runtimeId === 'agent-api'
          ? runtimeId
          : 'codex-app-server',
      modelPreference: storedPreference(modelPreference),
      effortPreference: storedPreference(effortPreference),
      activeTurnId: null,
      lastCompletedMessageId: null,
      nextEventSeq: 1,
      createdAt: now,
      updatedAt: now
    }
    const dir = this.getConversationDir(bookKey, id); await fsp.mkdir(dir, { recursive: true })
    await atomicWriteJson(join(dir, 'state.json'), state); await atomicWriteJson(join(dir, 'memory.json'), EMPTY_MEMORY(id)); await atomicWriteJson(join(dir, 'runtime.json'), { schemaVersion: 2, runtimeId: state.runtimeId, providerModel: null, isolatedTurn: true, contractVersion: '2', toolsetHash: null, promptHash: null, protocolVersion: '2', lastHealthyAt: null, metadata: {} })
    await fsp.writeFile(join(dir, 'transcript.jsonl'), JSON.stringify({ schemaVersion: 1, eventId: createId('evt'), seq: 0, type: 'conversation.created', conversationId: id, turnId: null, messageId: null, createdAt: now, payload: { title: state.title } }) + '\n', 'utf8')
    await fsp.writeFile(join(dir, 'tool-ledger.jsonl'), '', 'utf8')
    await atomicWriteJson(join(dir, 'write-proposals.json'), { schemaVersion: 1, proposals: [] })
    await atomicWriteJson(join(dir, 'knowledge-proposals.json'), { schemaVersion: 1, proposals: [] })
    await this.syncIndex(state)
    return state
  }

  async loadConversation(bookKey, conversationId) {
    const dir = this.getConversationDir(bookKey, conversationId); const statePath = join(dir, 'state.json'); const state = await this.readJson(statePath); if (!state || state.bookKey !== safeName(bookKey)) throw new Error('Harness Conversation 不属于当前书籍')
    const transcript = await this.readTranscript(join(dir, 'transcript.jsonl')); const memory = await this.readJson(join(dir, 'memory.json'), EMPTY_MEMORY(state.conversationId)); const runtime = await this.readJson(join(dir, 'runtime.json'), {}); const ledger = await this.readTranscript(join(dir, 'tool-ledger.jsonl'))
    return { state, transcript, memory, runtime, ledger }
  }

  async recoverInterruptedTurns(bookKey, activeTurnIds = new Set()) {
    const entries = await this.listConversations(bookKey)
    const recovered = []
    for (const entry of entries) {
      const data = await this.loadConversation(bookKey, entry.conversationId)
      const turnId = data.state.activeTurnId
      if (!(data.state.status === 'running' || turnId) || (turnId && activeTurnIds.has(turnId))) continue
      const already = data.transcript.some((item) => item.type === 'turn.interrupted' && item.turnId === turnId)
      if (!already) await this.appendTranscript(data.state, 'turn.interrupted', turnId, null, { reason: 'application-restart' })
      data.state.status = 'idle'
      data.state.activeTurnId = null
      await this.updateState(data.state)
      recovered.push({ conversationId: data.state.conversationId, turnId })
    }
    return recovered
  }

  async recoverAllKnownBooks() {
    let root
    try { root = this.snapshotService.getBooksDir?.() } catch { return [] }
    if (!root) return []
    let books
    try { books = await fsp.readdir(root, { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const results = []
    for (const book of books) if (book.isDirectory() && !isLibraryMetadataName(book.name)) results.push(...await this.recoverInterruptedTurns(book.name))
    return results
  }

  async appendTranscript(state, type, turnId, messageId, payload = {}) {
    const bookKey = safeName(state.bookKey)
    const conversationId = safeName(state.conversationId)
    return this.withLock(`conversation-state:${bookKey}:${conversationId}`, async () => {
      const dir = this.getConversationDir(bookKey, conversationId)
      const statePath = join(dir, 'state.json')
      const current = await this.readJson(statePath, state)
      const seq = Math.max(1, Number(current.nextEventSeq) || 1)
      const event = {
        schemaVersion: 1,
        eventId: createId('evt'),
        seq,
        type,
        conversationId,
        turnId: turnId || null,
        messageId: messageId || null,
        createdAt: nowIso(),
        payload
      }
      await fsp.appendFile(join(dir, 'transcript.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
      current.nextEventSeq = seq + 1
      current.updatedAt = event.createdAt
      current.revision = Math.max(0, Number(current.revision) || 0) + 1
      await atomicWriteJson(statePath, current)
      await this.syncIndex(current)
      state.nextEventSeq = current.nextEventSeq
      state.updatedAt = current.updatedAt
      state.revision = current.revision
      return event
    })
  }
  async appendLedger(state, event) {
    const bookKey = safeName(state.bookKey)
    const conversationId = safeName(state.conversationId)
    return this.withLock(`tool-ledger:${bookKey}:${conversationId}`, async () => {
      const dir = this.getConversationDir(bookKey, conversationId)
      await fsp.appendFile(join(dir, 'tool-ledger.jsonl'), `${JSON.stringify({ schemaVersion: 2, eventId: createId('evt'), conversationId, createdAt: nowIso(), ...event })}\n`, 'utf8')
    })
  }
  async readWriteProposals(bookKey, conversationId) {
    const value = await this.readJson(this.getProposalsPath(bookKey, conversationId), {
      schemaVersion: 1,
      proposals: []
    })
    return Array.isArray(value?.proposals) ? value.proposals : []
  }
  async writeWriteProposals(bookKey, conversationId, proposals) {
    return this.writeJson(this.getProposalsPath(bookKey, conversationId), {
      schemaVersion: 1,
      proposals: Array.isArray(proposals) ? proposals : []
    })
  }
  async readKnowledgeProposals(bookKey, conversationId) {
    const value = await this.readJson(this.getKnowledgeProposalsPath(bookKey, conversationId), {
      schemaVersion: 1,
      proposals: []
    })
    return Array.isArray(value?.proposals) ? value.proposals : []
  }
  async writeKnowledgeProposals(bookKey, conversationId, proposals) {
    return this.writeJson(this.getKnowledgeProposalsPath(bookKey, conversationId), {
      schemaVersion: 1,
      proposals: Array.isArray(proposals) ? proposals : []
    })
  }
  async writeUndoSnapshot(bookKey, conversationId, proposalId, snapshot) {
    const path = this.getUndoSnapshotPath(bookKey, conversationId, proposalId)
    await this.writeJson(path, { schemaVersion: 1, ...snapshot })
    return path
  }
  async readUndoSnapshot(bookKey, conversationId, proposalId) {
    return this.readJson(this.getUndoSnapshotPath(bookKey, conversationId, proposalId))
  }
  async deleteUndoSnapshot(bookKey, conversationId, proposalId) {
    try {
      await fsp.unlink(this.getUndoSnapshotPath(bookKey, conversationId, proposalId))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  async updateState(state) {
    const bookKey = safeName(state.bookKey)
    const conversationId = safeName(state.conversationId)
    return this.withLock(`conversation-state:${bookKey}:${conversationId}`, async () => {
      const statePath = join(this.getConversationDir(bookKey, conversationId), 'state.json')
      const current = await this.readJson(statePath, {})
      const expectedRevision = Number(state.revision)
      const currentRevision = Math.max(0, Number(current.revision) || 0)
      if (Number.isFinite(expectedRevision) && expectedRevision !== currentRevision) {
        throw new HarnessError(
          'CONVERSATION_STATE_VERSION_CONFLICT',
          '对话状态已发生变化，请重新读取后再操作',
          { retryable: true }
        )
      }
      const next = {
        ...current,
        ...state,
        bookKey,
        conversationId,
        nextEventSeq: Math.max(Number(current.nextEventSeq) || 1, Number(state.nextEventSeq) || 1),
        revision: currentRevision + 1,
        updatedAt: nowIso()
      }
      await atomicWriteJson(statePath, next)
      await this.syncIndex(next)
      Object.assign(state, next)
      return state
    })
  }
  async updateRuntime(state, runtime) {
    await atomicWriteJson(join(this.getConversationDir(state.bookKey, state.conversationId), 'runtime.json'), {
      ...runtime,
      schemaVersion: 2,
      isolatedTurn: true,
      contractVersion: '2',
      metadata: runtime?.metadata && typeof runtime.metadata === 'object' ? runtime.metadata : {}
    })
  }
  async updateMemory(state, memory) { await atomicWriteJson(join(this.getConversationDir(state.bookKey, state.conversationId), 'memory.json'), memory); await this.appendTranscript(state, 'memory.updated', null, null, { summaryVersion: memory.summaryVersion, coveredThroughMessageId: memory.coveredThroughMessageId }) }
  async archiveConversation(state) { state.status = 'archived'; state.activeTurnId = null; await this.updateState(state); return state }

  async completeAutoTitle({ bookKey, conversationId, title, generated }) {
    return this.withLock(String(conversationId), async () => {
      const data = await this.loadConversation(bookKey, conversationId)
      const state = data.state
      if (state.titleSource === 'manual' || state.autoTitleStatus !== 'pending') return state
      const nextTitle = String(title || '').trim().slice(0, 120)
      if (generated && nextTitle) {
        state.title = nextTitle
        state.titleSource = 'automatic'
        state.autoTitleStatus = 'completed'
      } else {
        state.autoTitleStatus = 'fallback'
      }
      state.autoTitleAttemptedAt = nowIso()
      await this.updateState(state)
      await this.appendTranscript(state, 'conversation.title.updated', null, null, {
        title: state.title,
        source: state.titleSource,
        generated: Boolean(generated && nextTitle)
      })
      return state
    })
  }

  async importLegacyConversation({ bookKey, conversationId, title, archived, threadDigest, modelPreference, effortPreference, messages = [] }) {
    const existing = await this.readJson(join(this.getConversationDir(bookKey, conversationId), 'state.json'), null)
    if (existing) return { conversationId, imported: false, messageCount: messages.length }
    const now = nowIso()
    const state = { schemaVersion: 1, revision: 0, conversationId: safeName(conversationId), bookKey: safeName(bookKey), title: String(title || '导入对话').slice(0, 120), status: archived ? 'archived' : 'idle', modelPreference: storedPreference(modelPreference), effortPreference: storedPreference(effortPreference), activeTurnId: null, lastCompletedMessageId: null, nextEventSeq: 1, createdAt: now, updatedAt: now, runtimeId: 'codex-app-server', importedFrom: 'legacy-codex-harness-v1', legacyThreadDigest: threadDigest }
    const dir = this.getConversationDir(bookKey, state.conversationId)
    await fsp.mkdir(dir, { recursive: true })
    await atomicWriteJson(join(dir, 'state.json'), state)
    await atomicWriteJson(join(dir, 'memory.json'), EMPTY_MEMORY(state.conversationId))
    await atomicWriteJson(join(dir, 'runtime.json'), { schemaVersion: 2, runtimeId: state.runtimeId, providerModel: null, isolatedTurn: true, contractVersion: '2', toolsetHash: null, promptHash: null, protocolVersion: '2', lastHealthyAt: null, metadata: { importedFrom: 'legacy-codex-harness-v1' } })
    await fsp.writeFile(join(dir, 'transcript.jsonl'), '', 'utf8')
    await fsp.writeFile(join(dir, 'tool-ledger.jsonl'), '', 'utf8')
    for (const message of messages) {
      const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : null
      const text = String(message?.content || '').trim()
      if (!role || !text) continue
      const turnId = createId('turn-imported')
      const messageId = createId('msg-imported')
      await this.appendTranscript(state, `message.${role}`, turnId, messageId, { text, importedAt: nowIso(), originalCreatedAt: message?.createdAt ? String(message.createdAt) : null, importedFrom: 'legacy-codex-harness-v1' })
      if (role === 'assistant') { state.lastCompletedMessageId = messageId; await this.appendTranscript(state, 'turn.completed', turnId, messageId, { imported: true }) }
    }
    await this.syncIndex(state)
    return { conversationId: state.conversationId, imported: true, messageCount: messages.length }
  }
}

export default HarnessStore
