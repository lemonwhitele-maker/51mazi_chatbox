import crypto from 'node:crypto'
import {
  decodeReferencePart,
  makeSourceReference
} from '../../services/bookSavedSnapshotService.js'

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 50
const MAX_SNIPPET = 360
const DEFAULT_MAX_CHARS = 20_000
const MAX_MAX_CHARS = 100_000

function hashText(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex')}`
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, '')
}

function cjkNgrams(value) {
  const chars = [...String(value || '')].filter((char) => /\p{Script=Han}/u.test(char))
  const result = []
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index <= chars.length - size; index += 1)
      result.push(chars.slice(index, index + size).join(''))
  }
  return result
}

function queryTerms(query) {
  const normalized = String(query || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
  const terms = new Set()
  for (const word of normalized.match(/[a-z0-9][a-z0-9._-]*/gi) || []) terms.add(word)
  for (const term of cjkNgrams(normalized)) terms.add(term)
  const compact = normalizeSearchText(normalized)
  if (compact) terms.add(compact)
  return [...terms].sort((a, b) => b.length - a.length)
}

function clampChars(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_MAX_CHARS
  return Math.min(MAX_MAX_CHARS, Math.floor(numeric))
}

function truncate(value, maxChars) {
  const text = String(value || '')
  return text.length <= maxChars
    ? { text, truncated: false }
    : { text: `${text.slice(0, maxChars)}\n\n……内容已按预算截断……`, truncated: true }
}

function messageText(event) {
  return String(event?.payload?.text || '').trim()
}

function formatTurn(userText, assistantText) {
  return [userText ? `用户：${userText}` : '', assistantText ? `助手：${assistantText}` : '']
    .filter(Boolean)
    .join('\n\n')
}

function makeConversationReference(conversationId, kind, id, contentHash) {
  return makeSourceReference({
    sourceType: 'conversation',
    targetId: conversationId,
    location: `${kind}:${encodeURIComponent(id)}`,
    contentHash
  })
}

function parseConversationReference(reference) {
  const raw = String(reference || '').trim()
  const match = /^conversation:([^#@]+)#(turn|message):([^@]+)(?:@(sha256:[a-f0-9]+))?$/i.exec(raw)
  if (!match) throw new Error('历史对话来源引用格式无效')
  return {
    conversationId: decodeReferencePart(match[1]),
    kind: match[2].toLowerCase(),
    id: decodeReferencePart(match[3]),
    contentHash: match[4] || ''
  }
}

function snippetFor(text, query, terms) {
  const source = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  const normalizedSource = normalizeSearchText(source)
  const normalizedQuery = normalizeSearchText(query)
  let matched = normalizedQuery
  let normalizedIndex = matched ? normalizedSource.indexOf(matched) : -1
  if (normalizedIndex < 0) {
    matched = terms.find((term) => term.length > 1 && normalizedSource.includes(term)) || ''
    normalizedIndex = matched ? normalizedSource.indexOf(matched) : -1
  }
  if (normalizedIndex < 0) return source.slice(0, MAX_SNIPPET)
  const displayQuery = String(query || '').trim()
  const displayIndex = displayQuery
    ? source.toLocaleLowerCase('en-US').indexOf(displayQuery.toLocaleLowerCase('en-US'))
    : -1
  const center = displayIndex >= 0 ? displayIndex : Math.min(source.length, normalizedIndex)
  const start = Math.max(0, center - 100)
  const end = Math.min(source.length, center + Math.max(displayQuery.length, 20) + 180)
  return `${start ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`.slice(
    0,
    MAX_SNIPPET
  )
}

function scoreChunk(chunk, query, terms) {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return null
  const title = normalizeSearchText(chunk.title)
  const matchedTerms = terms.filter(
    (term) => chunk.normalizedText.includes(term) || title.includes(term)
  )
  const exact = chunk.normalizedText.includes(normalizedQuery)
  if (!exact && !matchedTerms.length) return null
  let score = exact ? 0.65 : 0.15
  score += Math.min(0.25, (matchedTerms.length / Math.max(terms.length, 1)) * 0.25)
  if (title.includes(normalizedQuery)) score += 0.3
  return { score: Math.min(1, score), matchedTerms }
}

function normalConversationChunks(data) {
  const messages = data.transcript.filter(
    (event) => event.type === 'message.user' || event.type === 'message.assistant'
  )
  const completed = new Map(
    data.transcript
      .filter((event) => event.type === 'turn.completed' && event.turnId)
      .map((event) => [event.turnId, event])
  )
  const turnIds = [
    ...new Set(messages.map((event) => event.turnId).filter((turnId) => completed.has(turnId)))
  ]
  return turnIds
    .map((turnId) => {
      const turnMessages = messages.filter((event) => event.turnId === turnId)
      const userText = turnMessages
        .filter((event) => event.type === 'message.user')
        .map(messageText)
        .filter(Boolean)
        .join('\n')
      const assistantText = turnMessages
        .filter((event) => event.type === 'message.assistant')
        .map(messageText)
        .filter(Boolean)
        .join('\n')
      return makeChunk(data.state, {
        kind: 'turn',
        id: turnId,
        turnId,
        userMessageId:
          turnMessages.find((event) => event.type === 'message.user')?.messageId || null,
        assistantMessageId:
          turnMessages.findLast((event) => event.type === 'message.assistant')?.messageId || null,
        userText,
        assistantText,
        completedAt: completed.get(turnId)?.createdAt || turnMessages.at(-1)?.createdAt || null
      })
    })
    .filter(Boolean)
}

function legacyConversationChunks(data) {
  const messages = data.transcript.filter(
    (event) => event.type === 'message.user' || event.type === 'message.assistant'
  )
  const chunks = []
  let pendingUser = null
  for (const event of messages) {
    if (event.type === 'message.user') {
      pendingUser = event
      continue
    }
    chunks.push(makeLegacyChunk(data.state, pendingUser, event))
    pendingUser = null
  }
  return chunks.filter(Boolean)
}

function makeLegacyChunk(state, userEvent, assistantEvent) {
  const anchor = assistantEvent || userEvent
  if (!anchor?.messageId) return null
  return makeChunk(state, {
    kind: 'message',
    id: anchor.messageId,
    turnId: assistantEvent?.turnId || userEvent?.turnId || null,
    userMessageId: userEvent?.messageId || null,
    assistantMessageId: assistantEvent?.messageId || null,
    userText: messageText(userEvent),
    assistantText: messageText(assistantEvent),
    completedAt: assistantEvent?.createdAt || userEvent?.createdAt || null
  })
}

function makeChunk(state, value) {
  const text = formatTurn(value.userText, value.assistantText)
  if (!text.trim()) return null
  const contentHash = hashText(text)
  return {
    chunkId: `conversation:${state.conversationId}:${value.kind}:${value.id}:${contentHash}`,
    sourceType: 'conversation',
    targetId: state.conversationId,
    title: `${state.title || '未命名对话'} · ${(value.userText || value.assistantText || '历史消息').slice(0, 60)}`,
    text,
    normalizedText: normalizeSearchText(text),
    reference: makeConversationReference(state.conversationId, value.kind, value.id, contentHash),
    contentHash,
    authorityStatus: 'unconfirmed_conversation',
    savedAt: value.completedAt || state.updatedAt || null,
    metadata: {
      conversationId: state.conversationId,
      conversationTitle: state.title || '未命名对话',
      turnId: value.turnId,
      userMessageId: value.userMessageId,
      assistantMessageId: value.assistantMessageId,
      archived: state.status === 'archived',
      importedFrom: state.importedFrom || null,
      referenceKind: value.kind,
      referenceId: value.id
    }
  }
}

export class ConversationRetrievalService {
  constructor({ store } = {}) {
    this.store = store
    this.indexes = new Map()
  }

  async listConversationStructure(bookKey) {
    const entries = await this.store.listConversations(bookKey)
    return entries.map((state) => ({
      sourceType: 'conversation',
      targetId: state.conversationId,
      title: state.title || '未命名对话',
      status: state.status,
      archived: state.status === 'archived',
      createdAt: state.createdAt || null,
      updatedAt: state.updatedAt || null,
      lastCompletedMessageId: state.lastCompletedMessageId || null
    }))
  }

  async ensureIndex(bookKey) {
    const entries = await this.store.listConversations(bookKey)
    const fingerprint = entries
      .map(
        (state) =>
          `${state.conversationId}:${state.updatedAt || ''}:${state.status || ''}:${state.lastCompletedMessageId || ''}`
      )
      .sort()
      .join('|')
    const previous = this.indexes.get(String(bookKey))
    if (previous?.fingerprint === fingerprint) return previous
    const chunks = []
    for (const state of entries) {
      const data = await this.store.loadConversation(bookKey, state.conversationId)
      const conversationChunks = data.state.importedFrom
        ? legacyConversationChunks(data)
        : normalConversationChunks(data)
      chunks.push(...conversationChunks)
    }
    const index = {
      bookKey: String(bookKey),
      fingerprint,
      builtAt: new Date().toISOString(),
      chunks
    }
    this.indexes.set(String(bookKey), index)
    return index
  }

  invalidate(bookKey) {
    this.indexes.delete(String(bookKey))
  }

  async search(bookKey, query, options = {}) {
    const normalizedQuery = String(query || '').trim()
    if (!normalizedQuery) return { results: [], truncated: false, builtAt: null }
    const index = await this.ensureIndex(bookKey)
    const terms = queryTerms(normalizedQuery)
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(options.limit) || DEFAULT_LIMIT))
    const excludeConversationId = String(options.excludeConversationId || '').trim()
    const scored = index.chunks
      .filter((chunk) => !excludeConversationId || chunk.targetId !== excludeConversationId)
      .map((chunk) => {
        const match = scoreChunk(chunk, normalizedQuery, terms)
        if (!match) return null
        return {
          reference: chunk.reference,
          sourceType: chunk.sourceType,
          targetId: chunk.targetId,
          title: chunk.title,
          snippet: snippetFor(chunk.text, normalizedQuery, match.matchedTerms),
          matchedTerms: match.matchedTerms.slice(0, 12),
          authorityStatus: chunk.authorityStatus,
          contentHash: chunk.contentHash,
          savedAt: chunk.savedAt,
          score: Number(match.score.toFixed(4)),
          location: chunk.metadata
        }
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          b.score - a.score || String(b.savedAt || '').localeCompare(String(a.savedAt || ''))
      )
    return {
      results: scored.slice(0, limit),
      truncated: scored.length > limit,
      builtAt: index.builtAt
    }
  }

  async readConversationSource(bookKey, reference, options = {}) {
    const parsed = parseConversationReference(reference)
    const index = await this.ensureIndex(bookKey)
    const selected = index.chunks.find(
      (chunk) =>
        chunk.targetId === parsed.conversationId &&
        chunk.metadata.referenceKind === parsed.kind &&
        chunk.metadata.referenceId === parsed.id
    )
    if (!selected) throw new Error('历史对话来源不存在或不属于当前书籍')
    const siblings = index.chunks
      .filter((chunk) => chunk.targetId === selected.targetId)
      .sort((a, b) => String(a.savedAt || '').localeCompare(String(b.savedAt || '')))
    const selectedIndex = siblings.findIndex((chunk) => chunk.chunkId === selected.chunkId)
    const before = Math.max(0, Math.min(5, Number(options.before) || 0))
    const after = Math.max(0, Math.min(5, Number(options.after) || 0))
    const related = siblings.slice(Math.max(0, selectedIndex - before), selectedIndex + after + 1)
    const content = related
      .map((chunk) => {
        const heading = `[${chunk.metadata.conversationTitle} · ${chunk.savedAt || '时间未知'}]`
        return `${heading}\n${chunk.text}`
      })
      .join('\n\n')
    const bounded = truncate(content, clampChars(options.maxChars))
    return {
      success: true,
      versionChanged: Boolean(parsed.contentHash && parsed.contentHash !== selected.contentHash),
      source: {
        reference: selected.reference,
        sourceType: selected.sourceType,
        targetId: selected.targetId,
        contentHash: selected.contentHash,
        authorityStatus: selected.authorityStatus,
        savedAt: selected.savedAt,
        metadata: selected.metadata
      },
      content: bounded.text,
      truncated: bounded.truncated,
      location: {
        conversationId: selected.targetId,
        turnId: selected.metadata.turnId,
        userMessageId: selected.metadata.userMessageId,
        assistantMessageId: selected.metadata.assistantMessageId,
        before,
        after
      },
      message:
        parsed.contentHash && parsed.contentHash !== selected.contentHash
          ? '历史对话索引版本已变化，以下为当前持久化记录'
          : undefined
    }
  }
}

export { parseConversationReference }
export default ConversationRetrievalService
