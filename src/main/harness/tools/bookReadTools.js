import { parseSourceReference } from '../../services/bookSavedSnapshotService.js'
import {
  TOOL_SCOPES,
  listBookStructureSchema,
  readBookBacklinksSchema,
  readBookSourceSchema,
  readOutlineContextSchema,
  searchBookKnowledgeSchema
} from './toolSchemas.js'

const scopeToSource = {
  chapters: 'chapter',
  characters: 'character',
  settings: 'setting',
  outlines: 'outline',
  notes: 'note',
  conversations: 'conversation'
}
const BOOK_SCOPES = ['chapters', 'characters', 'settings', 'outlines', 'notes']
const MIN_READ_CHARS = 200
const MAX_READ_CHARS = 20000
const AUTHORITY_PRIORITY = Object.freeze({
  authoritative_saved: 3,
  user_confirmed_conversation: 2,
  unconfirmed_conversation: 1
})

function normalizeScopes(value) {
  return value.filter((scope) => TOOL_SCOPES.includes(scope))
}

function canonicalReadArguments(args) {
  return {
    ...args,
    source: args.source,
    locator: args.locator || { type: 'reference' },
    context: args.context || {},
    maxChars: Number.isInteger(args.maxChars)
      ? Math.min(MAX_READ_CHARS, Math.max(MIN_READ_CHARS, args.maxChars))
      : 6000
  }
}

function readOptions(args) {
  const locator = args.locator || { type: 'reference' }
  return {
    maxChars: args.maxChars,
    before: args.context?.before || 0,
    after: args.context?.after || 0,
    ...(locator.type === 'lines' ? { startLine: locator.startLine, endLine: locator.endLine } : {}),
    ...(locator.type === 'section' ? { sectionKey: locator.sectionKey } : {}),
    ...(locator.type === 'heading' ? { heading: locator.heading } : {})
  }
}

function resolveSourceReference(args, retrievalService, bookKey) {
  if (args.source.type === 'reference') return args.source.reference
  if (args.source.type === 'id' && args.source.sourceType === 'conversation')
    return `conversation:${encodeURIComponent(args.source.objectId)}`
  const structure = retrievalService.listBookStructure(bookKey, BOOK_SCOPES, { mode: 'flat' })
  const expected = String(
    args.source.type === 'id' ? args.source.objectId : args.source.relativePath
  ).replaceAll('\\', '/')
  const expectedSourceType = args.source.type === 'id' ? args.source.sourceType : ''
  const matches = BOOK_SCOPES.flatMap((scope) =>
    (structure[scope] || []).map((item) => ({ ...item, resolvedSourceType: scopeToSource[scope] }))
  ).filter((item) => {
    if (expectedSourceType && item.resolvedSourceType !== expectedSourceType) return false
    const candidate = args.source.type === 'id'
      ? item.targetId || item.id
      : item.relativePath || item.path || item.metadata?.relativePath
    return String(candidate || '').replaceAll('\\', '/') === expected
  })
  if (matches.length !== 1 || !matches[0].reference) {
    const selector = args.source.type === 'id' ? '对象 ID' : '书内相对路径'
    const error = new Error(matches.length > 1 ? `${selector}存在歧义` : `${selector}未找到`)
    error.code = matches.length > 1
      ? args.source.type === 'id' ? 'SOURCE_ID_AMBIGUOUS' : 'SOURCE_PATH_AMBIGUOUS'
      : 'BOOK_SOURCE_NOT_FOUND'
    throw error
  }
  return matches[0].reference
}

export function createBookReadTools({ retrievalService, conversationRetrievalService = null }) {
  return [
    {
      name: 'list_book_structure',
      version: '2',
      risk: 'read',
      description: '列出当前书籍资料与历史对话的结构和短元数据，不返回整篇内容。',
      inputSchema: listBookStructureSchema,
      normalizeArguments(args) {
        return { ...args, mode: args.mode || 'grouped', limitPerScope: args.limitPerScope || 100 }
      },
      async execute(context, args) {
        const scopes = normalizeScopes(args.scopes)
        const bookScopes = scopes.filter((scope) => BOOK_SCOPES.includes(scope))
        const result = bookScopes.length
          ? retrievalService.listBookStructure(context.bookKey, bookScopes, { mode: args.mode })
          : { bookName: context.bookKey }
        if (scopes.includes('conversations')) {
          if (!conversationRetrievalService) throw new Error('历史对话检索服务不可用')
          result.conversations = await conversationRetrievalService.listConversationStructure(
            context.bookKey
          )
        }
        const limit = args.limitPerScope
        const sections = scopes.map((scope) => ({
          scope,
          items: (result[scope] || []).slice(0, limit).map((item) => ({
            id: String(item.targetId || item.id || ''),
            title: item.title || item.name || '未命名',
            parentId: item.parentId ?? null,
            order: item.ordinal ?? item.order ?? null,
            reference: item.reference || null,
            relativePath: item.relativePath || item.path || item.metadata?.relativePath || null,
            savedHash: item.contentHash || item.rawHash || null,
            aliases: item.aliases || [],
            tags: item.tags || [],
            kind: item.kind || null,
            status: item.status || null,
            sections: item.sections || [],
            ambiguity: Boolean(item.ambiguity || item.ambiguous)
          }))
        }))
        return {
          data: {
            book: { key: context.bookKey, title: context.bookKey },
            mode: args.mode || 'grouped',
            sections,
            ...(args.mode === 'flat'
              ? {
                  items: sections.flatMap((section) =>
                    section.items.map((item) => ({ ...item, scope: section.scope }))
                  )
                }
              : {}),
            truncated: scopes.some((scope) => (result[scope] || []).length > limit)
          }
        }
      }
    },
    {
      name: 'search_book_knowledge',
      version: '2',
      risk: 'read',
      description:
        '在当前书籍资料和已持久化历史对话中检索相关片段；需要回忆先前讨论时使用 conversations scope。',
      inputSchema: searchBookKnowledgeSchema,
      normalizeArguments(args) {
        return { ...args, limit: args.limit || 8, mode: args.mode || 'hybrid' }
      },
      async execute(context, args) {
        const scopes = normalizeScopes(args.scopes)
        const bookScopes = scopes.filter((scope) => BOOK_SCOPES.includes(scope))
        const limit = Math.min(12, args.limit)
        const bookResult = bookScopes.length
          ? retrievalService.searchBookKnowledge(context.bookKey, args.query, {
              scopes: bookScopes,
              limit,
              mode: args.mode,
              filters: args.filters
            })
          : { results: [], truncated: false }
        const conversationResult = scopes.includes('conversations')
          ? await conversationRetrievalService?.search(context.bookKey, args.query, {
              limit,
              excludeConversationId: context.conversationId
            })
          : { results: [], truncated: false }
        if (scopes.includes('conversations') && !conversationRetrievalService)
          throw new Error('历史对话检索服务不可用')
        const combined = [
          ...(bookResult.results || []),
          ...(conversationResult?.results || [])
        ].sort(
          (a, b) =>
            Number(AUTHORITY_PRIORITY[b.authorityStatus] || 0) -
              Number(AUTHORITY_PRIORITY[a.authorityStatus] || 0) ||
            Number(b.score || 0) - Number(a.score || 0) ||
            String(b.savedAt || '').localeCompare(String(a.savedAt || ''))
        )
        const results = combined.slice(0, limit)
        return {
          data: {
            query: args.query,
            hits: results.map((hit, index) => ({
              rank: index + 1,
              score: hit.score ?? null,
              scope: hit.sourceType,
              objectId: hit.targetId,
              title: hit.title,
              snippet: String(hit.snippet || '').slice(0, 600),
              reference: hit.reference,
              savedHash: hit.contentHash || '',
              authorityStatus: hit.authorityStatus || null,
              savedAt: hit.savedAt || null,
              location: hit.location || null,
              ambiguous: Boolean(hit.ambiguous),
              ambiguousNames: hit.ambiguousNames || []
            })),
            truncated: Boolean(
              bookResult.truncated || conversationResult?.truncated || combined.length > limit
            )
          },
          references: results.map((hit) => hit.reference).filter(Boolean)
        }
      }
    },
    {
      name: 'read_book_source',
      version: '2',
      risk: 'read',
      description: '读取当前书籍某条资料或历史对话来源的有限范围内容。优先原样使用 list_book_structure 或 search_book_knowledge 返回的 reference；使用 id/path selector 时必须原样使用返回的 id/relativePath，不要自行删改扩展名或拼接路径。',
      inputSchema: readBookSourceSchema,
      normalizeArguments(args) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) return args
        return canonicalReadArguments(args)
      },
      async execute(context, args) {
        if (args.locator.type === 'lines' && args.locator.endLine < args.locator.startLine)
          return { ok: false, error: { code: 'SOURCE_LOCATOR_INVALID', message: 'endLine 必须大于或等于 startLine', retryable: false } }
        const reference = resolveSourceReference(args, retrievalService, context.bookKey)
        const options = readOptions(args)
        if (/^(?:[a-z]+:)?[\\/]|^[A-Za-z]:|\.\.|https?:/i.test(reference))
          return {
            ok: false,
            error: {
              code: 'SOURCE_REFERENCE_INVALID',
              message: '来源引用不是受支持的书籍引用',
              retryable: false
            }
          }
        if (reference.startsWith('conversation:')) {
          if (args.source.type === 'path') return { ok: false, error: { code: 'SOURCE_SELECTOR_INVALID', message: '历史对话不支持 path selector', retryable: false } }
          if (!conversationRetrievalService) throw new Error('历史对话检索服务不可用')
          const result = await conversationRetrievalService.readConversationSource(
            context.bookKey,
            reference,
            options
          )
          if (result.versionChanged)
            return {
              ok: false,
              error: {
                code: 'SOURCE_CHANGED',
                message: '历史对话索引版本已变化，请重新搜索后再读取',
                retryable: true
              }
            }
          return {
            data: {
              reference: result.source?.reference || reference,
              normalizedReference: result.source?.reference || reference,
              sourceType: 'conversation',
              scope: 'conversation',
              objectId: result.source?.targetId || '',
              title: result.source?.metadata?.conversationTitle || '历史对话',
              savedHash: result.source?.contentHash || '',
              text: result.content || '',
              range: result.location || null,
              authorityStatus: result.source?.authorityStatus || 'unconfirmed_conversation',
              truncated: Boolean(result.truncated),
              metadata: result.source?.metadata || {}
            },
            references: [result.source?.reference || reference],
            truncated: Boolean(result.truncated)
          }
        }
        const parsed = parseSourceReference(reference)
        if (!Object.values(scopeToSource).includes(parsed.sourceType))
          return {
            ok: false,
            error: {
              code: 'SOURCE_SCOPE_INVALID',
              message: '来源不属于只读正式资料范围',
              retryable: false
            }
          }
        if (args.locator.type === 'section' && !['character', 'setting', 'outline'].includes(parsed.sourceType))
          return { ok: false, error: { code: 'SOURCE_LOCATOR_INVALID', message: '当前来源类型不支持 section locator', retryable: false } }
        const result = retrievalService.readBookSource(context.bookKey, reference, options)
        if (result.versionChanged)
          return {
            ok: false,
            error: {
              code: 'SOURCE_CHANGED',
              message: '来源正式版本已变化，请重新搜索后再读取',
              retryable: true
            }
          }
        return {
          data: {
            reference: result.source?.reference || reference,
            normalizedReference: result.source?.reference || reference,
            sourceType: result.source?.sourceType || parsed.sourceType,
            scope: result.source?.sourceType || parsed.sourceType,
            objectId: result.source?.targetId || parsed.targetId,
            title:
              result.source?.metadata?.chapterName ||
              result.source?.metadata?.characterId ||
              parsed.targetId,
            savedHash: result.source?.contentHash || '',
            text: result.content || '',
            range: {
              start: result.location?.startLine || null,
              end: result.location?.endLine || null,
              section: result.location?.section || null,
              heading: result.location?.heading || null
            },
            authorityStatus: result.source?.authorityStatus || 'authoritative_saved',
            truncated: Boolean(result.truncated),
            hasMoreBefore: Boolean(result.hasMoreBefore),
            hasMoreAfter: Boolean(result.hasMoreAfter),
            adjacentSections: result.adjacentSections || [],
            continueWith: result.continueWith || null,
            metadata: result.source?.metadata || {}
          },
          references: [result.source?.reference || reference],
          truncated: Boolean(result.truncated)
        }
      }
    },
    {
      name: 'read_book_backlinks',
      version: '2',
      risk: 'read',
      description: '读取人物、设定、大纲、章节或速记的显式反向引用与弱文本命中。',
      inputSchema: readBookBacklinksSchema,
      async execute(context, args) {
        const result = retrievalService.readBookBacklinks(context.bookKey, args.reference, {
          includeWeak: args.includeWeak !== false,
          limit: args.limit
        })
        return {
          data: result,
          references: [args.reference],
          truncated: Boolean(result.truncated)
        }
      }
    },
    {
      name: 'read_outline_context',
      version: '2',
      risk: 'read',
      description: '按大纲或章节稳定引用读取预算内的相关大纲、相邻排序和人物/设定引用清单。',
      inputSchema: readOutlineContextSchema,
      normalizeArguments(args) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) return args
        return {
          ...args,
          ...(Number.isInteger(args.maxChars)
            ? { maxChars: Math.min(MAX_READ_CHARS, Math.max(MIN_READ_CHARS, args.maxChars)) }
            : {})
        }
      },
      async execute(context, args) {
        const result = retrievalService.readOutlineContext(context.bookKey, args.reference, args)
        return {
          data: result,
          references: (result.documents || []).map((item) => item.reference).filter(Boolean),
          truncated: Boolean(result.truncated)
        }
      }
    }
  ]
}
