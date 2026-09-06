import fs from 'node:fs'
import crypto from 'node:crypto'
import { join, resolve } from 'node:path'

export const API_CONFIG_KEYS = Object.freeze([
  'agentApi',
  'functionApi',
  'deepseek',
  'tongyiwanxiang',
  'gemini',
  'doubao',
  'imageAi.lastProvider'
])
export const LIBRARY_METADATA_DIRECTORY = '.51mazi'
const API_CONFIG_FILENAME = 'api-config.json'
const INVALID_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

export function isLibraryMetadataName(value) {
  const normalized = String(value || '')
    .trim()
    // Win32 resolves trailing dots/spaces to the same directory name.
    .replace(/[. ]+$/g, '')
    .toLowerCase()
  return normalized === LIBRARY_METADATA_DIRECTORY
}

export function isApiConfigKey(key) {
  return (
    typeof key === 'string' &&
    API_CONFIG_KEYS.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))
  )
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function object(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function segments(key) {
  const result = String(key).split('.')
  if (result.some((part) => !part || INVALID_SEGMENTS.has(part))) throw new Error('配置名称无效')
  return result
}

export function getConfigValue(source, key, fallback) {
  let current = source
  for (const part of segments(key)) {
    if (!object(current) || !Object.prototype.hasOwnProperty.call(current, part))
      return clone(fallback)
    current = current[part]
  }
  return current === undefined ? clone(fallback) : clone(current)
}

export function setConfigValue(source, key, value) {
  const parts = segments(key)
  let current = source
  for (const part of parts.slice(0, -1)) {
    if (!object(current[part])) current[part] = {}
    current = current[part]
  }
  current[parts.at(-1)] = clone(value)
}

export function deleteConfigValue(source, key) {
  const parts = segments(key)
  let current = source
  for (const part of parts.slice(0, -1)) {
    if (!object(current[part])) return
    current = current[part]
  }
  delete current[parts.at(-1)]
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function mergeMissing(target, source) {
  const result = clone(target)
  for (const [key, value] of Object.entries(source)) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = clone(value)
    else if (object(result[key]) && object(value)) result[key] = mergeMissing(result[key], value)
  }
  return result
}

function validatePayload(value) {
  if (!object(value)) throw new Error('书库 API 配置格式无效，请修复配置文件后重试')
  for (const key of Object.keys(value)) {
    if (!API_CONFIG_KEYS.includes(key) && key !== 'imageAi')
      throw new Error('书库 API 配置包含未知类别')
    if (!object(value[key])) throw new Error('书库 API 配置类别格式无效')
    if (key === 'imageAi' && Object.keys(value[key]).some((child) => child !== 'lastProvider')) {
      throw new Error('书库图片 API 配置格式无效')
    }
  }
  return value
}

function apiPayload(store) {
  const result = {}
  for (const key of API_CONFIG_KEYS) {
    const value = store.get(key)
    if (value !== undefined) setConfigValue(result, key, value)
  }
  return validatePayload(result)
}

function validBooksDir(value, io, required = false) {
  if (typeof value === 'string' && value.trim()) {
    try {
      const directory = resolve(value)
      if (io.statSync(directory).isDirectory()) return io.realpathSync(directory)
    } catch {
      /* An unavailable library never falls back to application-level secrets. */
    }
  }
  if (required) throw new Error('请先选择有效书库目录，再保存 API 设置')
  return ''
}

function comparablePath(value) {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isInside(root, target) {
  const comparableRoot = comparablePath(root)
  const comparableTarget = comparablePath(target)
  const prefix = comparableRoot.endsWith(process.platform === 'win32' ? '\\' : '/')
    ? comparableRoot
    : `${comparableRoot}${process.platform === 'win32' ? '\\' : '/'}`
  return comparableTarget === comparableRoot || comparableTarget.startsWith(prefix)
}

export class LibraryApiConfigStore {
  constructor({ legacyStore, onDirectoryChanged, fsImpl = fs } = {}) {
    if (!legacyStore?.get || !legacyStore?.set || !legacyStore?.delete)
      throw new Error('缺少应用配置存储')
    this.legacyStore = legacyStore
    this.onDirectoryChanged = onDirectoryChanged
    this.fs = fsImpl
    this.booksDir = validBooksDir(
      legacyStore.get('booksDir') || legacyStore.get('config.booksDir'),
      this.fs
    )
  }

  getBooksDir() {
    return this.booksDir
  }
  getApiConfigPath(booksDir = this.booksDir) {
    return booksDir ? join(booksDir, LIBRARY_METADATA_DIRECTORY, API_CONFIG_FILENAME) : ''
  }

  resolveMetadataDirectory(booksDir, { create = false } = {}) {
    const root = validBooksDir(booksDir, this.fs, true)
    const metadataPath = join(root, LIBRARY_METADATA_DIRECTORY)
    if (!this.fs.existsSync(metadataPath)) {
      if (!create) return { root, metadataPath, exists: false }
      try {
        this.fs.mkdirSync(metadataPath)
      } catch {
        throw new Error('无法创建书库 API 配置目录，原应用配置已保留')
      }
    }
    let stat
    let realMetadataPath
    try {
      stat = this.fs.lstatSync(metadataPath)
      realMetadataPath = this.fs.realpathSync(metadataPath)
    } catch {
      throw new Error('无法检查书库 API 配置目录，原应用配置已保留')
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || !isInside(root, realMetadataPath)) {
      throw new Error('书库 API 配置目录不能是符号链接或目录联接')
    }
    return { root, metadataPath: realMetadataPath, exists: true }
  }

  resolveManagedFile(booksDir, fileName, { createMetadata = false } = {}) {
    const metadata = this.resolveMetadataDirectory(booksDir, { create: createMetadata })
    const filePath = join(metadata.metadataPath, fileName)
    if (!metadata.exists || !this.fs.existsSync(filePath)) {
      return { ...metadata, filePath, exists: false }
    }
    let stat
    let realFilePath
    try {
      stat = this.fs.lstatSync(filePath)
      realFilePath = this.fs.realpathSync(filePath)
    } catch {
      throw new Error('无法检查书库 API 配置文件，原应用配置已保留')
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      !isInside(metadata.metadataPath, realFilePath)
    ) {
      throw new Error('书库 API 配置文件不能是符号链接或书库外文件')
    }
    return { ...metadata, filePath: realFilePath, exists: true }
  }

  readPayload(booksDir) {
    if (!booksDir) return {}
    const location = this.resolveManagedFile(booksDir, API_CONFIG_FILENAME)
    if (!location.exists) return {}
    let source
    try {
      source = this.fs.readFileSync(location.filePath, 'utf8')
    } catch {
      throw new Error('无法读取书库 API 配置，请检查目录权限')
    }
    try {
      return validatePayload(JSON.parse(source.replace(/^\uFEFF/, '')))
    } catch {
      throw new Error('书库 API 配置损坏，请修复配置文件后重试')
    }
  }

  writeJson(file, payload) {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      this.fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      this.fs.renameSync(temporary, file)
      const verified = JSON.parse(this.fs.readFileSync(file, 'utf8'))
      if (stable(verified) !== stable(payload)) throw new Error('内容校验失败')
    } catch {
      throw new Error('书库 API 配置写入或校验失败，原应用配置已保留')
    } finally {
      try {
        this.fs.unlinkSync(temporary)
      } catch {
        /* Renamed files no longer have a temporary entry. */
      }
    }
  }

  writePayload(booksDir, payload) {
    validatePayload(payload)
    const location = this.resolveManagedFile(booksDir, API_CONFIG_FILENAME, {
      createMetadata: true
    })
    this.writeJson(location.filePath, payload)
  }

  migrateLegacy(booksDir) {
    if (!booksDir)
      return {
        migrated: false,
        reason: 'books-directory-not-configured',
        categories: [],
        categoryCount: 0
      }
    const target = this.readPayload(booksDir)
    const source = apiPayload(this.legacyStore)
    const categories = API_CONFIG_KEYS.filter((key) => getConfigValue(source, key) !== undefined)
    if (!categories.length) return { migrated: false, verified: true, categories, categoryCount: 0 }
    const merged = mergeMissing(target, source)
    const fingerprint = crypto
      .createHash('sha256')
      .update(stable(source))
      .digest('hex')
      .slice(0, 20)
    const backupName = `api-config.migration-backup.${fingerprint}.json`
    const backup = this.resolveManagedFile(booksDir, backupName, { createMetadata: true })
    const backupPath = backup.filePath
    if (backup.exists) {
      let parsedBackup
      try {
        parsedBackup = JSON.parse(this.fs.readFileSync(backupPath, 'utf8'))
      } catch {
        throw new Error('API 迁移备份无法读取，原应用配置已保留')
      }
      if (stable(parsedBackup) !== stable(source))
        throw new Error('API 迁移备份校验失败，原应用配置已保留')
    } else this.writeJson(backupPath, source)
    this.writePayload(booksDir, merged)
    try {
      if (typeof this.legacyStore.deleteMany === 'function') this.legacyStore.deleteMany(categories)
      else for (const key of categories) this.legacyStore.delete(key)
      if (categories.some((key) => this.legacyStore.get(key) !== undefined))
        throw new Error('旧配置清理失败')
    } catch {
      for (const key of categories) {
        if (this.legacyStore.get(key) === undefined)
          this.legacyStore.set(key, getConfigValue(source, key))
      }
      throw new Error('API 已备份到书库，但旧应用配置清理失败，请重试迁移')
    }
    return {
      migrated: true,
      verified: true,
      categories,
      categoryCount: categories.length,
      backupPath
    }
  }

  initialize() {
    return this.migrateLegacy(this.booksDir)
  }

  switchBooksDir(value, key = 'booksDir') {
    const nextDirectory = validBooksDir(value, this.fs, true)
    const previousDirectory = this.booksDir
    const targetExists = this.fs.existsSync(this.getApiConfigPath(nextDirectory))
    // Read before changing the preference: malformed targets cannot redirect a working library.
    this.readPayload(nextDirectory)
    if (!targetExists) {
      const current = this.readPayload(previousDirectory)
      if (Object.keys(current).length) this.writePayload(nextDirectory, current)
    }
    this.migrateLegacy(nextDirectory)
    this.legacyStore.set(key, nextDirectory)
    if (key === 'config.booksDir') this.legacyStore.set('booksDir', nextDirectory)
    this.booksDir = nextDirectory
    if (nextDirectory !== previousDirectory)
      this.onDirectoryChanged?.({ booksDir: nextDirectory, previousBooksDir: previousDirectory })
    return nextDirectory
  }

  bindApiStore() {
    const booksDir = this.booksDir
    return Object.freeze({
      booksDir,
      apiConfigPath: this.getApiConfigPath(booksDir),
      get: (key, fallback) => this.getBound(booksDir, key, fallback),
      set: (key, value) => this.setBound(booksDir, key, value),
      delete: (key) => this.deleteBound(booksDir, key),
      has: (key) => this.getBound(booksDir, key) !== undefined
    })
  }

  getBound(booksDir, key, fallback) {
    if (key === 'booksDir' || key === 'config.booksDir') return booksDir || fallback
    if (isApiConfigKey(key)) return getConfigValue(this.readPayload(booksDir), key, fallback)
    // imageAi is a mixed namespace: only the provider preference belongs with API settings.
    if (key === 'imageAi') {
      const preferences = this.legacyStore.get(key, {}) || {}
      delete preferences.lastProvider
      return { ...preferences, ...(this.readPayload(booksDir).imageAi || {}) }
    }
    return this.legacyStore.get(key, fallback)
  }

  setBound(booksDir, key, value) {
    if (!isApiConfigKey(key)) throw new Error('固定书库配置仅允许保存 API 设置')
    validBooksDir(booksDir, this.fs, true)
    const payload = this.readPayload(booksDir)
    setConfigValue(payload, key, value)
    this.writePayload(booksDir, payload)
  }

  deleteBound(booksDir, key) {
    if (!isApiConfigKey(key)) throw new Error('固定书库配置仅允许删除 API 设置')
    validBooksDir(booksDir, this.fs, true)
    const payload = this.readPayload(booksDir)
    deleteConfigValue(payload, key)
    this.writePayload(booksDir, payload)
  }

  get(key, fallback) {
    return this.getBound(this.booksDir, key, fallback)
  }
  has(key) {
    return this.get(key) !== undefined
  }

  set(key, value) {
    if (object(key)) {
      for (const [entry, next] of Object.entries(key)) this.set(entry, next)
      return
    }
    if (key === 'booksDir' || key === 'config.booksDir') {
      this.switchBooksDir(value, key)
      return
    }
    if (isApiConfigKey(key)) {
      this.setBound(this.booksDir, key, value)
      return
    }
    if (key === 'imageAi' && object(value)) {
      if (Object.prototype.hasOwnProperty.call(value, 'lastProvider'))
        this.setBound(this.booksDir, 'imageAi.lastProvider', value.lastProvider)
      const applicationPreferences = clone(value)
      delete applicationPreferences.lastProvider
      this.legacyStore.set(key, applicationPreferences)
      return
    }
    if (
      key === 'config' &&
      object(value) &&
      Object.prototype.hasOwnProperty.call(value, 'booksDir')
    ) {
      this.switchBooksDir(value.booksDir)
      this.legacyStore.set(key, { ...value, booksDir: this.booksDir })
      return
    }
    this.legacyStore.set(key, value)
  }

  delete(key) {
    if (isApiConfigKey(key)) {
      this.deleteBound(this.booksDir, key)
      return
    }
    if (key === 'imageAi') {
      if (this.booksDir) this.deleteBound(this.booksDir, 'imageAi.lastProvider')
      this.legacyStore.delete(key)
      return
    }
    this.legacyStore.delete(key)
    if (key === 'booksDir' || key === 'config.booksDir' || key === 'config') {
      const previousDirectory = this.booksDir
      this.booksDir = validBooksDir(
        this.legacyStore.get('booksDir') || this.legacyStore.get('config.booksDir'),
        this.fs
      )
      if (this.booksDir !== previousDirectory)
        this.onDirectoryChanged?.({ booksDir: this.booksDir, previousBooksDir: previousDirectory })
    }
  }
}

export default LibraryApiConfigStore
