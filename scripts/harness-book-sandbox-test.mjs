import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import BookSandboxService from '../src/main/harness/sandbox/bookSandboxService.js'
import BookScopeRegistry from '../src/main/harness/sandbox/bookScopeRegistry.js'
import HarnessStore from '../src/main/harness/store/harnessStore.js'

const temp = await fsp.mkdtemp(join(os.tmpdir(), '51mazi-book-sandbox-'))
const libraryA = join(temp, 'library-a')
const libraryB = join(temp, 'library-b')
let configuredRoot = libraryA

async function expectCode(action, code) {
  await assert.rejects(Promise.resolve().then(action), (error) => error?.code === code)
}

try {
  for (const library of [libraryA, libraryB]) {
    await fsp.mkdir(join(library, '同名书', '正文', '第一卷'), { recursive: true })
    await fsp.mkdir(join(library, 'B书'), { recursive: true })
    await fsp.writeFile(join(library, '同名书', '正文', '第一卷', '第一章.txt'), `${library}-A`)
    await fsp.writeFile(join(library, 'B书', 'secret.txt'), `${library}-B-secret`)
    await fsp.writeFile(join(library, 'word_stats.json'), `${library}-root-secret`)
  }
  await fsp.writeFile(join(temp, 'outside.txt'), 'outside-secret')

  const sandbox = new BookSandboxService({ booksDirProvider: () => configuredRoot })
  const scope = sandbox.bindBook('同名书', { senderId: 7, frameId: 3 })
  const chapter = sandbox.resolveReadable(scope, '正文/第一卷/第一章.txt')
  assert.equal(await fsp.readFile(chapter, 'utf8'), `${libraryA}-A`)
  assert.equal(
    sandbox.prepareCandidateTarget(scope, '正文/第一卷/新章节.txt'),
    join(libraryA, '同名书', '正文', '第一卷', '新章节.txt')
  )
  assert.equal(
    sandbox.prepareInternalPath(scope, '.51mazi/harness/v1/conversations.json'),
    join(libraryA, '同名书', '.51mazi', 'harness', 'v1', 'conversations.json')
  )

  for (const invalid of [
    '../B书/secret.txt',
    '../../outside.txt',
    '正文\\第一卷\\第一章.txt',
    'C:relative.txt',
    'C:/absolute.txt',
    '//server/share/file',
    '正文/NUL.txt',
    '正文/trailing./file.txt',
    '正文/trailing /file.txt',
    '.51mazi/harness/v1/state.json'
  ])
    await expectCode(() => sandbox.resolveReadable(scope, invalid), 'PATH_OUTSIDE_BOOK')
  await expectCode(
    () => sandbox.resolveReadable(scope, '正文/第一卷/missing/target.txt'),
    'DOCUMENT_NOT_FOUND'
  )

  const hardlink = join(libraryA, '同名书', '正文', '第一卷', 'hardlink.txt')
  await fsp.link(join(libraryA, 'B书', 'secret.txt'), hardlink)
  await expectCode(
    () => sandbox.resolveReadable(scope, '正文/第一卷/hardlink.txt'),
    'PATH_OUTSIDE_BOOK'
  )

  let junctionCovered = false
  try {
    const junction = join(libraryA, '同名书', 'linked-parent')
    await fsp.symlink(
      join(libraryA, 'B书'),
      junction,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    junctionCovered = true
    await expectCode(
      () => sandbox.resolveReadable(scope, 'linked-parent/secret.txt'),
      'PATH_OUTSIDE_BOOK'
    )
    await expectCode(
      () => sandbox.prepareCandidateTarget(scope, 'linked-parent/new.txt'),
      'PATH_OUTSIDE_BOOK'
    )
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error
  }

  const registry = new BookScopeRegistry({ sandboxService: sandbox })
  const first = registry.bindBook({ senderId: 7, frameId: 3, bookName: '同名书' }).scope
  assert.equal(
    registry.assertBound({ senderId: 7, frameId: 3, bookName: '同名书', conversationId: 'conv-a' })
      .scopeId,
    first.scopeId
  )
  assert.equal(
    registry.canReceive({ senderId: 7, bookName: '同名书', conversationId: 'conv-a' }),
    true
  )
  assert.equal(
    registry.canReceive({ senderId: 8, bookName: '同名书', conversationId: 'conv-a' }),
    false
  )
  await expectCode(
    () => registry.assertBound({ senderId: 8, frameId: 3, bookName: '同名书' }),
    'BOOK_SCOPE_MISMATCH'
  )
  await expectCode(
    () => registry.assertBound({ senderId: 7, frameId: 4, bookName: '同名书' }),
    'BOOK_SCOPE_MISMATCH'
  )
  await expectCode(
    () => registry.assertBound({ senderId: 7, frameId: 3, bookName: 'B书' }),
    'BOOK_SCOPE_MISMATCH'
  )

  configuredRoot = libraryB
  await expectCode(
    () => registry.assertBound({ senderId: 7, frameId: 3, bookName: '同名书' }),
    'BOOK_SCOPE_MISMATCH'
  )
  const rebound = registry.bindBook({ senderId: 7, frameId: 3, bookName: '同名书' }).scope
  assert.notEqual(rebound.scopeId, first.scopeId)
  await expectCode(() => registry.assertScopeToken(first), 'BOOK_SCOPE_MISMATCH')
  assert.equal(registry.assertScopeToken(rebound).scopeId, rebound.scopeId)

  configuredRoot = libraryA
  const replaceScope = sandbox.bindBook('同名书')
  await fsp.rename(join(libraryA, '同名书'), join(libraryA, '旧同名书'))
  await fsp.mkdir(join(libraryA, '同名书'), { recursive: true })
  await expectCode(() => sandbox.assertScope(replaceScope), 'BOOK_SCOPE_MISMATCH')

  await fsp.rename(join(libraryA, '旧同名书'), join(libraryA, '同名书2'))
  const store = new HarnessStore({
    snapshotService: { resolveBookPath: (name) => join(libraryA, name) },
    sandboxService: sandbox
  })
  const conversation = await store.createConversation({ bookKey: '同名书2', runtimeId: 'fake' })
  const statePath = join(
    libraryA,
    '同名书2',
    '.51mazi',
    'harness',
    'v1',
    'conversations',
    conversation.conversationId,
    'state.json'
  )
  assert.equal(fs.existsSync(statePath), true)
  assert.equal(fs.existsSync(join(libraryA, '.51mazi')), false)

  console.log(
    `harness book sandbox test passed (junction=${junctionCovered ? 'covered' : 'not-supported'})`
  )
} finally {
  await fsp.rm(temp, { recursive: true, force: true })
}
