import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import syncFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const source = await fs.readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')
const handlerStart = source.indexOf("ipcMain.handle('create-chapter'")
const handlerEnd = source.indexOf("ipcMain.handle('load-chapters'", handlerStart)
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, '找不到创建章节 IPC')
const handler = source.slice(handlerStart, handlerEnd)

assert.match(
  handler,
  /const chapterName = generateChapterName\(nextChapterNumber, chapterSettings\)/,
  '新增章节应直接使用正式章节名'
)
assert.equal(
  handler.includes('`${generateChapterName(nextChapterNumber, chapterSettings)} `'),
  false,
  '新增章节文件名不得包含标题占位空格'
)

// Exercise the actual handler's sync block, including the error path that leaked a handle.
const syncBlock = handler.slice(handler.indexOf('  try {', handler.indexOf("fs.writeFileSync(filePath, '')")), handler.indexOf('  return { success: true, chapterName, filePath }'))
const directory = await fs.mkdtemp(path.join(os.tmpdir(), '51mazi-chapter-close-'))
const filePath = path.join(directory, 'chapter.txt')
const replacement = path.join(directory, 'candidate.tmp')
try {
  for (const failSync of [false, true]) {
    await fs.writeFile(filePath, '')
    const opened = new Set()
    const fileSystem = {
      ...syncFs,
      openSync(target, flags) {
        const fd = syncFs.openSync(target, flags)
        opened.add(fd)
        return fd
      },
      fsyncSync(fd) {
        if (failSync) throw Object.assign(new Error('injected sync failure'), { code: 'EPERM' })
        return syncFs.fsyncSync(fd)
      },
      closeSync(fd) { syncFs.closeSync(fd); opened.delete(fd) }
    }
    try {
      vm.runInNewContext(syncBlock, { fs: fileSystem, filePath, console: { warn() {} } })
      assert.equal(opened.size, 0, '同步成功或失败后都必须关闭文件句柄')
      await fs.writeFile(replacement, 'saved')
      await fs.rename(replacement, filePath)
      assert.equal(await fs.readFile(filePath, 'utf8'), 'saved')
    } finally {
      for (const fd of opened) syncFs.closeSync(fd)
    }
  }
} finally {
  for (const file of [replacement, filePath]) await fs.unlink(file).catch(() => {})
  await fs.rmdir(directory)
}
console.log('chapter creation contract and handle cleanup checks passed')
