import { HarnessError } from '../harnessErrors.js'
import crypto from 'node:crypto'

function senderKey(senderId, frameId) {
  return `${String(senderId)}:${String(frameId)}`
}

export class BookScopeRegistry {
  constructor({ sandboxService } = {}) {
    this.sandboxService = sandboxService
    this.scopes = new Map()
    this.conversationScopes = new Map()
    this.confirmationGrants = new Map()
  }

  bindBook({ senderId, frameId, bookName }) {
    const key = senderKey(senderId, frameId)
    const previous = this.scopes.get(key)
    if (previous?.bookKey === String(bookName || '').trim()) {
      try {
        this.sandboxService.assertScope(previous)
        return { scope: previous, replacedScopeId: null }
      } catch (error) {
        if (error?.code !== 'BOOK_SCOPE_MISMATCH') throw error
      }
    }
    const scope = this.sandboxService.bindBook(bookName, { senderId, frameId })
    this.scopes.set(key, scope)
    if (previous) {
      for (const [conversationId, scopeId] of this.conversationScopes) {
        if (scopeId === previous.scopeId) this.conversationScopes.delete(conversationId)
      }
      for (const [token, grant] of this.confirmationGrants)
        if (grant.scopeId === previous.scopeId) this.confirmationGrants.delete(token)
    }
    return { scope, replacedScopeId: previous?.scopeId || null }
  }

  assertBound({ senderId, frameId, bookName, conversationId = null, turnId = null }) {
    const scope = this.scopes.get(senderKey(senderId, frameId))
    if (!scope)
      throw new HarnessError('BOOK_SCOPE_MISMATCH', '当前窗口尚未绑定书籍', { retryable: false })
    if (
      scope.senderId !== senderId ||
      scope.frameId !== frameId ||
      scope.bookKey !== String(bookName || '').trim()
    ) {
      throw new HarnessError('BOOK_SCOPE_MISMATCH', '请求与当前窗口绑定的书籍不一致', {
        retryable: false
      })
    }
    this.sandboxService.assertScope(scope)
    if (conversationId) this.conversationScopes.set(String(conversationId), scope.scopeId)
    return Object.freeze({ ...scope, conversationId, turnId })
  }

  assertScopeToken(scope) {
    const current = this.scopes.get(senderKey(scope?.senderId, scope?.frameId))
    if (!current || current.scopeId !== scope?.scopeId) {
      throw new HarnessError('BOOK_SCOPE_MISMATCH', '书籍 scope 已被切换或撤销', {
        retryable: false
      })
    }
    return this.sandboxService.assertScope(current)
  }

  currentBinding({ senderId, frameId }) {
    const scope = this.scopes.get(senderKey(senderId, frameId))
    if (!scope) throw new HarnessError('BOOK_SCOPE_MISMATCH', '当前窗口尚未绑定书籍')
    this.assertScopeToken(scope)
    return scope
  }

  isScopeActive(scopeId) {
    return [...this.scopes.values()].some((scope) => scope.scopeId === scopeId)
  }

  issueConfirmation(scope, proposal) {
    this.assertScopeToken(scope)
    for (const [existingToken, grant] of this.confirmationGrants)
      if (grant.expiresAt < Date.now()) this.confirmationGrants.delete(existingToken)
    while (this.confirmationGrants.size >= 4096)
      this.confirmationGrants.delete(this.confirmationGrants.keys().next().value)
    const token = crypto.randomBytes(32).toString('base64url')
    this.confirmationGrants.set(token, {
      scopeId: scope.scopeId,
      senderId: scope.senderId,
      frameId: scope.frameId,
      bookIdentity: scope.bookIdentity,
      bookKey: scope.bookKey,
      conversationId: String(proposal.conversationId || ''),
      proposalId: String(proposal.proposalId || ''),
      revision: Number(proposal.revision),
      candidateHash: String(proposal.candidateHash || ''),
      expiresAt: Math.min(Date.parse(proposal.expiresAt) || Date.now() + 3600000, Date.now() + 3600000)
    })
    return token
  }

  verifyConfirmation({ senderId, frameId, proposalId, revision, confirmationCredential }) {
    const token = String(confirmationCredential || '')
    const grant = this.confirmationGrants.get(token)
    const scope = this.currentBinding({ senderId, frameId })
    if (
      !grant || grant.expiresAt < Date.now() || grant.scopeId !== scope.scopeId ||
      grant.senderId !== senderId || grant.frameId !== frameId ||
      grant.bookIdentity !== scope.bookIdentity || grant.proposalId !== String(proposalId || '') ||
      grant.revision !== Number(revision)
    ) throw new HarnessError('PROPOSAL_CONFIRMATION_INVALID', '确认凭据无效、过期或不属于当前窗口')
    return { scope, grant }
  }

  canReceive({ senderId, bookName = null, conversationId = null }) {
    const candidates = [...this.scopes.values()].filter((scope) => scope.senderId === senderId)
    return candidates.some((scope) => {
      if (bookName && scope.bookKey !== bookName) return false
      if (conversationId && this.conversationScopes.get(String(conversationId)) !== scope.scopeId)
        return false
      try {
        this.sandboxService.assertScope(scope)
        return true
      } catch {
        return false
      }
    })
  }

  revokeSender(senderId) {
    const removed = new Set()
    for (const [key, scope] of this.scopes)
      if (scope.senderId === senderId) {
        removed.add(scope.scopeId)
        this.scopes.delete(key)
      }
    for (const [conversationId, scopeId] of this.conversationScopes)
      if (removed.has(scopeId)) this.conversationScopes.delete(conversationId)
    for (const [token, grant] of this.confirmationGrants)
      if (removed.has(grant.scopeId)) this.confirmationGrants.delete(token)
  }

  revokeAll() {
    this.scopes.clear()
    this.conversationScopes.clear()
    this.confirmationGrants.clear()
  }
}

export default BookScopeRegistry
