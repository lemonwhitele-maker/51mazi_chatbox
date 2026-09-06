import fs from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import {
  API_CONFIG_KEYS,
  LibraryApiConfigStore,
  deleteConfigValue,
  getConfigValue,
  setConfigValue
} from '../src/main/services/libraryApiConfigStore.js'

function readJson(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置格式无效')
  return value
}

function comparableDirectory(value) {
  const directory = fs.realpathSync(resolve(String(value)))
  return process.platform === 'win32' ? directory.toLowerCase() : directory
}

function nonApi(value) {
  const remaining = structuredClone(value)
  for (const key of API_CONFIG_KEYS) deleteConfigValue(remaining, key)
  return remaining
}

export function migrateLibraryApiConfig({ source, booksDir, checkOnly = false }) {
  if (!source || !booksDir) throw new Error('需要指定原应用配置和目标书库目录')
  const sourcePath = resolve(source)
  const initial = readJson(sourcePath)
  const configuredDirectory = initial.booksDir || initial.config?.booksDir
  if (
    !configuredDirectory ||
    comparableDirectory(configuredDirectory) !== comparableDirectory(booksDir)
  ) {
    throw new Error('来源配置中的书库目录与目标不一致，迁移已停止')
  }
  let current = initial
  let router
  const legacyStore = {
    get(key, fallback) {
      return getConfigValue(current, key, fallback)
    },
    set(key, value) {
      const next = readJson(sourcePath)
      setConfigValue(next, key, value)
      router.writeJson(sourcePath, next)
      current = next
    },
    delete(key) {
      this.deleteMany([key])
    },
    deleteMany(keys) {
      const next = readJson(sourcePath)
      if (!isDeepStrictEqual(next, initial))
        throw new Error('迁移期间应用配置已变化，请退出旧应用后重试')
      for (const key of keys) deleteConfigValue(next, key)
      router.writeJson(sourcePath, next)
      current = next
    }
  }
  router = new LibraryApiConfigStore({ legacyStore })
  const categories = API_CONFIG_KEYS.filter((key) => legacyStore.get(key) !== undefined)
  router.readPayload(router.getBooksDir())
  if (checkOnly) {
    return {
      checkOnly: true,
      sourceMatchesLibrary: true,
      categories,
      categoryCount: categories.length,
      targetExists: fs.existsSync(router.getApiConfigPath())
    }
  }
  const result = router.initialize()
  const sourceAfter = readJson(sourcePath)
  const nonApiUnchanged = isDeepStrictEqual(nonApi(sourceAfter), nonApi(initial))
  const remainingApiCategories = API_CONFIG_KEYS.filter(
    (key) => getConfigValue(sourceAfter, key) !== undefined
  )
  if (!nonApiUnchanged || remainingApiCategories.length)
    throw new Error('迁移后的原应用配置校验失败')
  return {
    migrated: result.migrated,
    verified: result.verified === true,
    categories: result.categories,
    categoryCount: result.categoryCount,
    sourceApiRemoved: true,
    nonApiUnchanged,
    targetVerified: true,
    backupCreated: Boolean(result.backupPath)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const allowed = new Set(['--source', '--books-dir', '--check'])
    const options = {}
    for (let index = 0; index < args.length; index += 1) {
      const flag = args[index]
      if (!allowed.has(flag)) throw new Error('迁移参数无效')
      if (flag === '--check') options.checkOnly = true
      else {
        const value = args[++index]
        if (!value || value.startsWith('--')) throw new Error('迁移参数缺少值')
        options[flag === '--source' ? 'source' : 'booksDir'] = value
      }
    }
    console.log(JSON.stringify(migrateLibraryApiConfig(options)))
  } catch {
    // Never print source contents, provider responses, or secrets, even for malformed JSON.
    console.error('API 配置迁移未完成；请确认书库路径、配置文件和目录权限，并退出旧应用后重试。')
    process.exitCode = 1
  }
}
