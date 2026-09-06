import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

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

console.log('chapter creation contract checks passed')
