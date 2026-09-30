import assert from 'node:assert/strict'
import { editPreviewFragments } from '../src/renderer/src/components/Agent/editProposalPreview.js'

const original =
  '无需展示的前文。\n'.repeat(500) +
  '而边界一旦被讲清楚，下一次就会有人试着问：能不能把它再往外推一点。'
const continuation = '\n\n她合上电脑，想了想，又把它打开。'
const appended = editPreviewFragments(original, original + continuation)
assert.equal(appended.length, 1)
assert.equal(appended[0].before, '')
assert.equal(appended[0].after, continuation)
assert.ok(Array.from(appended[0].leading).length <= 40)
assert.equal(appended[0].omittedBefore, true)

const unchanged = '这一段保持不变。\n'.repeat(100)
const before = `开头。\n旧台词。\n${unchanged}旧结尾。\n尾声。`
const after = `开头。\n新台词。\n${unchanged}新结尾。\n尾声。`
const separated = editPreviewFragments(before, after)
assert.equal(separated.length, 2)
assert.deepEqual(
  separated.map(({ before, after }) => [before, after]),
  [
    ['旧', '新'],
    ['旧', '新']
  ]
)
assert.ok(separated.every((part) => part.leading.length <= 40 && part.trailing.length <= 40))
assert.deepEqual(editPreviewFragments('相同', '相同'), [])
assert.equal(editPreviewFragments('删除我', '')[0].before, '删除我')
assert.equal(editPreviewFragments('', '新增')[0].after, '新增')
assert.deepEqual(
  editPreviewFragments('头😀尾', '头😃尾').map(({ before, after }) => [before, after]),
  [['😀', '😃']]
)
assert.equal(editPreviewFragments('甲\r\n乙', '甲\r\n新\r\n乙')[0].after, '新\r\n')

// Every difference remains reviewable, including repeated lines and empty sides.
let seed = 42
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
for (let run = 0; run < 200; run++) {
  const a = Array.from(
    { length: 20 },
    () => ['甲\n', '乙\n', '😀\n'][Math.floor(random() * 3)]
  ).join('')
  const b = Array.from(
    { length: 20 },
    () => ['甲\n', '丙\n', '😃\n'][Math.floor(random() * 3)]
  ).join('')
  const parts = editPreviewFragments(a, b)
  let cursor = 0
  let rebuilt = ''
  for (const part of parts) {
    const match = a.indexOf(
      part.leading + part.before + part.trailing,
      Math.max(0, cursor - part.leading.length)
    )
    assert.ok(match >= 0)
    const start = match + part.leading.length
    assert.ok(start >= cursor)
    rebuilt += a.slice(cursor, start) + part.after
    cursor = start + part.before.length
  }
  assert.equal(rebuilt + a.slice(cursor), b)
}
const hugeBefore = '旧行\n'.repeat(1100)
const hugeAfter = '新行\n'.repeat(1100)
const hugeFragment = editPreviewFragments(hugeBefore, hugeAfter)[0]
assert.equal(hugeFragment.leading + hugeFragment.after + hugeFragment.trailing, hugeAfter)
console.log(
  'Edit proposal preview: append, replacement, separated changes, deletion, Unicode, CRLF, randomized reconstruction and large-input fallback passed.'
)
