import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from './chapterWriteService.js'

const STATS_RELATIVE_PATH = join('.51mazi', 'stats', 'word-stats.json')
const LEGACY_STATS_FILE = 'word_stats.json'

function emptyStats() {
  return { schemaVersion: 1, dailyStats: {}, chapterStats: {}, bookDailyStats: {} }
}

function countWords(content) {
  return String(content || '').replace(/[\s\n\r\t]/g, '').length
}

function normalizedStats(value) {
  return {
    schemaVersion: 1,
    dailyStats: value?.dailyStats && typeof value.dailyStats === 'object' ? value.dailyStats : {},
    chapterStats:
      value?.chapterStats && typeof value.chapterStats === 'object' ? value.chapterStats : {},
    bookDailyStats:
      value?.bookDailyStats && typeof value.bookDailyStats === 'object'
        ? value.bookDailyStats
        : {}
  }
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

export class BookWordStatsService {
  constructor({ snapshotService } = {}) {
    if (!snapshotService) throw new TypeError('snapshotService is required')
    this.snapshotService = snapshotService
    this.queues = new Map()
  }

  statsPath(bookName) {
    const bookPath = this.snapshotService.resolveBookPath(String(bookName || '').trim())
    return this.snapshotService.resolveInside(bookPath, STATS_RELATIVE_PATH, '书内统计')
  }

  readBook(bookName) {
    return normalizedStats(readJson(this.statsPath(bookName), emptyStats()))
  }

  async writeBook(bookName, stats) {
    const target = this.statsPath(bookName)
    await fs.promises.mkdir(dirname(target), { recursive: true })
    await writeFileAtomically(target, Buffer.from(JSON.stringify(normalizedStats(stats), null, 2), 'utf8'))
  }

  enqueue(bookName, work) {
    const key = String(bookName || '')
    const previous = this.queues.get(key) || Promise.resolve()
    const current = previous.catch(() => {}).then(work)
    this.queues.set(key, current)
    return current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key)
    })
  }

  updateChapter(bookName, volumeName, chapterName, oldContent, newContent) {
    return this.enqueue(bookName, async () => {
      const stats = this.readBook(bookName)
      const today = new Date().toISOString().split('T')[0]
      const chapterKey = `${volumeName}/${chapterName}`
      const oldLength = countWords(oldContent)
      const newLength = countWords(newContent)
      const previous = stats.chapterStats[chapterKey]
      // 以已持久化的章节统计为幂等基线。崩溃恢复重放同一次
      // onCommitted 时，不会再次累加每日增删字数。
      const activityBase = previous ? Number(previous.totalWords || 0) : oldLength
      const wordChange = newLength - activityBase
      const lastUpdate = previous?.lastUpdate || today

      if (previous && stats.dailyStats[lastUpdate]) {
        stats.dailyStats[lastUpdate] = Math.max(
          0,
          Number(stats.dailyStats[lastUpdate] || 0) - Number(previous.totalWords || 0)
        )
      }
      stats.dailyStats[today] = Number(stats.dailyStats[today] || 0) + newLength
      if (newContent === '' && newLength === 0) delete stats.chapterStats[chapterKey]
      else {
        stats.chapterStats[chapterKey] = {
          totalWords: newLength,
          lastUpdate: today,
          wordChange,
          lastContentLength: oldLength
        }
      }

      const daily = stats.bookDailyStats[today] || {
        netWords: 0,
        addWords: 0,
        deleteWords: 0,
        totalWords: 0
      }
      if (wordChange > 0) daily.addWords += wordChange
      else if (wordChange < 0) daily.deleteWords += Math.abs(wordChange)
      daily.netWords = daily.addWords - daily.deleteWords
      daily.totalWords = Object.values(stats.chapterStats).reduce(
        (sum, item) => sum + Number(item?.totalWords || 0),
        0
      )
      stats.bookDailyStats[today] = daily
      await this.writeBook(bookName, stats)
      return stats
    })
  }

  listBookNames() {
    const root = this.snapshotService.getBooksDir()
    if (!fs.existsSync(root)) return []
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          this.snapshotService.resolveBookPath(name)
          return true
        } catch {
          return false
        }
      })
  }

  readAggregate() {
    const aggregate = { dailyStats: {}, chapterStats: {}, bookDailyStats: {} }
    for (const bookName of this.listBookNames()) {
      const stats = this.readBook(bookName)
      for (const [date, count] of Object.entries(stats.dailyStats))
        aggregate.dailyStats[date] = Number(aggregate.dailyStats[date] || 0) + Number(count || 0)
      for (const [chapter, item] of Object.entries(stats.chapterStats))
        aggregate.chapterStats[`${bookName}/${chapter}`] = item
      aggregate.bookDailyStats[bookName] = stats.bookDailyStats
    }
    return aggregate
  }

  async migrateLegacyRootStats() {
    const root = this.snapshotService.getBooksDir()
    const legacyPath = join(root, LEGACY_STATS_FILE)
    const legacy = readJson(legacyPath, null)
    if (!legacy) return { migrated: 0 }
    let migrated = 0
    for (const bookName of this.listBookNames()) {
      const target = this.statsPath(bookName)
      if (fs.existsSync(target)) continue
      const prefix = `${bookName}/`
      const chapterStats = Object.fromEntries(
        Object.entries(legacy.chapterStats || {})
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key.slice(prefix.length), value])
      )
      const bookDailyStats = legacy.bookDailyStats?.[bookName] || {}
      if (!Object.keys(chapterStats).length && !Object.keys(bookDailyStats).length) continue
      const dailyStats = {}
      for (const item of Object.values(chapterStats)) {
        const date = item?.lastUpdate
        if (date) dailyStats[date] = Number(dailyStats[date] || 0) + Number(item?.totalWords || 0)
      }
      await this.writeBook(bookName, { schemaVersion: 1, dailyStats, chapterStats, bookDailyStats })
      migrated += 1
    }
    return { migrated }
  }
}

export { STATS_RELATIVE_PATH, countWords as countChapterWords }
export default BookWordStatsService
