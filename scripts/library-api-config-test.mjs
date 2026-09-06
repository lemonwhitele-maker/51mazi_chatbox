import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  API_CONFIG_KEYS,
  LibraryApiConfigStore,
  deleteConfigValue,
  getConfigValue,
  isLibraryMetadataName,
  setConfigValue
} from '../src/main/services/libraryApiConfigStore.js'
import { FunctionApiService } from '../src/main/services/functionApiService.js'
import { BookSavedSnapshotService } from '../src/main/services/bookSavedSnapshotService.js'
import { HarnessStore } from '../src/main/harness/store/harnessStore.js'
import { LegacyCodexHarnessMigrationV1 } from '../src/main/harness/migration/legacyCodexHarnessMigrationV1.js'
import { migrateLibraryApiConfig } from './migrate-library-api-config.mjs'

const testRoot = fs.mkdtempSync(join(os.tmpdir(), '51mazi-library-api-test-'))
let cases = 0

function directory(name) {
  const path = join(testRoot, name)
  fs.mkdirSync(path, { recursive: true })
  return path
}

function memoryStore(initial) {
  const data = structuredClone(initial)
  return {
    data,
    get(key, fallback) {
      return getConfigValue(data, key, fallback)
    },
    set(key, value) {
      setConfigValue(data, key, value)
    },
    delete(key) {
      deleteConfigValue(data, key)
    }
  }
}

function writeApi(root, value) {
  fs.mkdirSync(join(root, '.51mazi'), { recursive: true })
  fs.writeFileSync(join(root, '.51mazi', 'api-config.json'), JSON.stringify(value))
}

function check(label, action) {
  action()
  cases += 1
  console.log(`PASS ${label}`)
}

try {
  check(
    'all API categories migrate without application preferences or external runtime login',
    () => {
      const booksDir = directory('原书库 中文')
      const seed = {
        booksDir,
        config: { booksDir, theme: 'dark' },
        window: { width: 1200 },
        codexAgent: { login: 'synthetic-external-runtime' },
        agentApi: { profiles: [{ id: 'profile-test', apiKey: 'synthetic-agent-key' }] },
        functionApi: { config: { apiKey: 'synthetic-title-key' } },
        deepseek: { apiKey: 'synthetic-deepseek-key' },
        tongyiwanxiang: { apiKey: 'synthetic-image-key' },
        gemini: { apiKey: 'synthetic-gemini-key' },
        doubao: { apiKey: 'synthetic-doubao-key', model: 'synthetic-model' },
        imageAi: { lastProvider: 'doubao', panelWidth: 420 }
      }
      const legacy = memoryStore(seed)
      const store = new LibraryApiConfigStore({ legacyStore: legacy })
      const result = store.initialize()
      assert.equal(result.categoryCount, API_CONFIG_KEYS.length)
      assert.equal(result.verified, true)
      const saved = JSON.parse(fs.readFileSync(store.getApiConfigPath(), 'utf8'))
      const backup = JSON.parse(fs.readFileSync(result.backupPath, 'utf8'))
      assert.deepEqual(saved, backup)
      assert.equal(saved.booksDir, undefined)
      assert.equal(saved.codexAgent, undefined)
      assert.deepEqual(saved.imageAi, { lastProvider: 'doubao' })
      assert.deepEqual(legacy.data.imageAi, { panelWidth: 420 })
      assert.deepEqual(legacy.data.config, seed.config)
      assert.deepEqual(legacy.data.window, seed.window)
      assert.deepEqual(legacy.data.codexAgent, seed.codexAgent)
      for (const key of API_CONFIG_KEYS) assert.equal(legacy.get(key), undefined)
      store.set('deepseek.apiKey', 'synthetic-replacement')
      assert.equal(legacy.get('deepseek.apiKey'), undefined)
      assert.equal(store.get('deepseek.apiKey'), 'synthetic-replacement')
      const repeat = store.initialize()
      assert.equal(repeat.migrated, false)
      assert.equal(
        fs.readdirSync(join(booksDir, '.51mazi')).filter((name) => name.includes('backup')).length,
        1
      )
    }
  )

  check(
    'existing target values win; absent nested settings are filled and original values backed up',
    () => {
      const booksDir = directory('existing')
      writeApi(booksDir, {
        doubao: { apiKey: 'target-key', model: '' },
        agentApi: { profiles: [] }
      })
      const legacy = memoryStore({
        booksDir,
        doubao: { apiKey: 'source-key', model: 'source-model', baseUrl: 'https://example.invalid' },
        agentApi: { profiles: [{ id: 'old' }] }
      })
      const store = new LibraryApiConfigStore({ legacyStore: legacy })
      const result = store.initialize()
      assert.equal(store.get('doubao.apiKey'), 'target-key')
      assert.equal(store.get('doubao.model'), '')
      assert.equal(store.get('doubao.baseUrl'), 'https://example.invalid')
      assert.deepEqual(store.get('agentApi.profiles'), [])
      assert.equal(JSON.parse(fs.readFileSync(result.backupPath)).doubao.apiKey, 'source-key')
    }
  )

  check('unconfigured library never reads or writes legacy API secrets', () => {
    const legacy = memoryStore({
      deepseek: { apiKey: 'legacy-only' },
      imageAi: { lastProvider: 'doubao', panelWidth: 420 }
    })
    const store = new LibraryApiConfigStore({ legacyStore: legacy })
    assert.equal(store.initialize().reason, 'books-directory-not-configured')
    assert.equal(store.get('deepseek.apiKey', 'empty'), 'empty')
    assert.deepEqual(store.get('imageAi'), { panelWidth: 420 })
    assert.throws(() => store.set('deepseek.apiKey', 'new'), /有效书库/)
    assert.throws(() => store.bindApiStore().set('functionApi.config', {}), /有效书库/)
    assert.equal(legacy.get('deepseek.apiKey'), 'legacy-only')
    assert.equal(legacy.get('imageAi.lastProvider'), 'doubao')
    const firstLibrary = directory('first-library')
    store.set('booksDir', firstLibrary)
    assert.equal(store.get('deepseek.apiKey'), 'legacy-only')
    assert.equal(legacy.get('deepseek.apiKey'), undefined)
  })

  check('malformed target stops migration before changing source or creating a backup', () => {
    const booksDir = directory('malformed')
    writeApi(booksDir, {})
    fs.writeFileSync(join(booksDir, '.51mazi', 'api-config.json'), '{broken')
    const legacy = memoryStore({ booksDir, gemini: { apiKey: 'unchanged' } })
    const store = new LibraryApiConfigStore({ legacyStore: legacy })
    assert.throws(() => store.initialize(), /损坏/)
    assert.equal(legacy.get('gemini.apiKey'), 'unchanged')
    assert.equal(fs.readdirSync(join(booksDir, '.51mazi')).length, 1)
  })

  check('linked library metadata directory cannot redirect API secrets outside the library', () => {
    const booksDir = directory('linked-metadata-library')
    const outside = directory('linked-metadata-outside')
    fs.symlinkSync(outside, join(booksDir, '.51mazi'), process.platform === 'win32' ? 'junction' : 'dir')
    const legacy = memoryStore({ booksDir, deepseek: { apiKey: 'synthetic-linked-secret' } })
    const store = new LibraryApiConfigStore({ legacyStore: legacy })
    assert.throws(() => store.initialize(), /符号链接|目录联接/)
    assert.equal(legacy.get('deepseek.apiKey'), 'synthetic-linked-secret')
    assert.deepEqual(fs.readdirSync(outside), [])
  })

  check('failed destination write leaves source and existing destination intact', () => {
    const booksDir = directory('failed-write')
    writeApi(booksDir, { gemini: { apiKey: 'target' } })
    const legacy = memoryStore({ booksDir, deepseek: { apiKey: 'source' } })
    const faultyFs = {
      ...fs,
      renameSync(from, to) {
        if (to.endsWith('api-config.json'))
          throw Object.assign(new Error('synthetic denial'), { code: 'EACCES' })
        return fs.renameSync(from, to)
      }
    }
    const store = new LibraryApiConfigStore({ legacyStore: legacy, fsImpl: faultyFs })
    assert.throws(() => store.initialize(), /写入或校验失败/)
    assert.equal(legacy.get('deepseek.apiKey'), 'source')
    assert.deepEqual(JSON.parse(fs.readFileSync(store.getApiConfigPath())), {
      gemini: { apiKey: 'target' }
    })
    assert.equal(
      fs.readdirSync(join(booksDir, '.51mazi')).some((name) => name.endsWith('.tmp')),
      false
    )
  })

  check('failed readback verification prevents legacy cleanup', () => {
    const booksDir = directory('readback')
    const legacy = memoryStore({ booksDir, deepseek: { apiKey: 'source' } })
    let targetWritten = false
    const faultyFs = {
      ...fs,
      renameSync(from, to) {
        fs.renameSync(from, to)
        if (to.endsWith('api-config.json')) targetWritten = true
      },
      readFileSync(file, options) {
        if (targetWritten && String(file).endsWith('api-config.json')) return '{}'
        return fs.readFileSync(file, options)
      }
    }
    assert.throws(
      () => new LibraryApiConfigStore({ legacyStore: legacy, fsImpl: faultyFs }).initialize(),
      /校验失败/
    )
    assert.equal(legacy.get('deepseek.apiKey'), 'source')
  })

  check('partially failed legacy cleanup restores missing source categories and can retry', () => {
    const booksDir = directory('cleanup-failure')
    const legacy = memoryStore({
      booksDir,
      agentApi: {},
      deepseek: { apiKey: 'source' },
      gemini: { apiKey: 'source-two' }
    })
    const originalDelete = legacy.delete.bind(legacy)
    legacy.delete = (key) => {
      if (key === 'deepseek') throw new Error('synthetic delete failure')
      originalDelete(key)
    }
    const store = new LibraryApiConfigStore({ legacyStore: legacy })
    assert.throws(() => store.initialize(), /清理失败/)
    assert.deepEqual(legacy.get('agentApi'), {})
    assert.equal(legacy.get('deepseek.apiKey'), 'source')
    legacy.delete = originalDelete
    assert.equal(store.initialize().verified, true)
    assert.equal(legacy.get('deepseek'), undefined)
  })

  check(
    'library switching uses its existing target and copies only to an unconfigured target',
    () => {
      const first = directory('switch first')
      const second = directory('switch second')
      const third = directory('switch 中文 third')
      writeApi(first, { gemini: { apiKey: 'first-key' } })
      writeApi(second, { gemini: { apiKey: 'second-key' } })
      const changes = []
      const legacy = memoryStore({ booksDir: first, theme: 'light' })
      const store = new LibraryApiConfigStore({
        legacyStore: legacy,
        onDirectoryChanged: (event) => changes.push(event)
      })
      store.initialize()
      const firstBound = store.bindApiStore()
      store.set('booksDir', second)
      assert.equal(store.get('gemini.apiKey'), 'second-key')
      firstBound.set('gemini.apiKey', 'late-first-key')
      assert.equal(store.get('gemini.apiKey'), 'second-key')
      assert.equal(firstBound.get('gemini.apiKey'), 'late-first-key')
      assert.equal(firstBound.get('booksDir'), first)
      assert.throws(() => firstBound.set('theme', 'dark'), /仅允许/)
      store.set('booksDir', third)
      assert.equal(store.get('gemini.apiKey'), 'second-key')
      assert.equal(
        JSON.parse(fs.readFileSync(join(second, '.51mazi', 'api-config.json'))).gemini.apiKey,
        'second-key'
      )
      assert.equal(changes.length, 2)
      assert.equal(legacy.get('theme'), 'light')
      const invalid = directory('switch-invalid')
      writeApi(invalid, {})
      fs.writeFileSync(join(invalid, '.51mazi', 'api-config.json'), '[]')
      assert.throws(() => store.set('booksDir', invalid), /损坏/)
      assert.equal(store.getBooksDir(), third)
      assert.equal(legacy.get('booksDir'), third)
    }
  )

  check('generic settings access also routes image provider and directory aliases', () => {
    const first = directory('aliases-first')
    const second = directory('aliases-second')
    const legacy = memoryStore({ config: { booksDir: first, theme: 'dark' } })
    const store = new LibraryApiConfigStore({ legacyStore: legacy })
    store.set('imageAi', { lastProvider: 'gemini', panelWidth: 300 })
    assert.equal(legacy.get('imageAi.lastProvider'), undefined)
    assert.deepEqual(store.get('imageAi'), { lastProvider: 'gemini', panelWidth: 300 })
    store.set('config.booksDir', second)
    assert.equal(store.get('imageAi.lastProvider'), 'gemini')
    assert.equal(legacy.get('booksDir'), second)
    store.delete('imageAi')
    assert.deepEqual(store.get('imageAi'), {})
    assert.throws(() => store.set('agentApi.__proto__.polluted', 'x'), /无效/)
    assert.equal({}.polluted, undefined)
  })

  {
    const first = directory('async-validation-first')
    const second = directory('async-validation-second')
    const store = new LibraryApiConfigStore({ legacyStore: memoryStore({ booksDir: first }) })
    store.set('functionApi.config', {
      provider: 'custom',
      apiKey: 'first-key',
      model: 'first-model',
      baseUrl: 'https://example.invalid'
    })
    writeApi(second, { functionApi: { config: { apiKey: 'second-key', model: 'second-model' } } })
    let finish
    const service = new FunctionApiService({
      store,
      fetchImpl: () =>
        new Promise((done) => {
          finish = done
        })
    })
    const pending = service.validateConfig({ enabled: true })
    store.set('booksDir', second)
    finish({ ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) })
    assert.equal((await pending).isValid, true)
    assert.equal(store.get('functionApi.config.apiKey'), 'second-key')
    assert.equal(store.get('functionApi.config.lastValidationStatus'), undefined)
    assert.equal(
      JSON.parse(fs.readFileSync(join(first, '.51mazi', 'api-config.json'))).functionApi.config
        .lastValidationStatus,
      'success'
    )
    cases += 1
    console.log('PASS asynchronous validation writes only to the library captured when it started')
  }

  {
    const booksDir = directory('enumeration')
    fs.mkdirSync(join(booksDir, '.51mazi'))
    fs.writeFileSync(
      join(booksDir, '.51mazi', 'api-config.json'),
      JSON.stringify({ gemini: { apiKey: 'hidden' } })
    )
    fs.mkdirSync(join(booksDir, '合成书本'))
    const snapshotService = new BookSavedSnapshotService({ booksDirProvider: () => booksDir })
    assert.equal(isLibraryMetadataName('.51MAZI'), true)
    assert.equal(isLibraryMetadataName(' .51mazi... '), true)
    assert.throws(() => snapshotService.resolveBookPath('.51mazi'), /保留/)
    assert.throws(() => snapshotService.resolveBookPath('.51mazi.'), /保留/)
    const outsideBook = directory('linked-book-outside')
    const linkedBook = join(booksDir, '联接书本')
    fs.symlinkSync(outsideBook, linkedBook, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => snapshotService.resolveBookPath('联接书本'), /不存在/)
    fs.rmSync(linkedBook)
    const harnessStore = new HarnessStore({ snapshotService })
    const recovered = []
    harnessStore.recoverInterruptedTurns = async (name) => {
      recovered.push(name)
      return []
    }
    await harnessStore.recoverAllKnownBooks()
    assert.deepEqual(recovered, ['合成书本'])
    const migration = new LegacyCodexHarnessMigrationV1({
      store: memoryStore({ codexAgent: { bookBindingsV1: { '.51mazi': {} } } }),
      harnessStore,
      snapshotService
    })
    await migration.migrate()
    assert.equal(fs.existsSync(join(booksDir, '.51mazi', '.51mazi')), false)
    assert.equal(
      fs.existsSync(join(booksDir, '合成书本', '.51mazi', 'harness', 'migration-v1.json')),
      true
    )
    cases += 1
    console.log(
      'PASS library metadata cannot resolve as a book or enter recovery and legacy migration'
    )
  }

  check(
    'migration command enforces the configured directory and preserves all non-API settings',
    () => {
      const booksDir = directory('script-library')
      const wrongDir = directory('script-wrong-library')
      const source = join(directory('synthetic-app-data'), 'config.json')
      fs.writeFileSync(
        source,
        JSON.stringify({
          booksDir,
          theme: 'dark',
          deepseek: { apiKey: 'synthetic-secret' },
          imageAi: { panelWidth: 500, lastProvider: 'gemini' }
        })
      )
      assert.throws(() => migrateLibraryApiConfig({ source, booksDir: wrongDir }), /不一致/)
      assert.equal(fs.existsSync(join(wrongDir, '.51mazi')), false)
      const before = fs.readFileSync(source, 'utf8')
      const checked = migrateLibraryApiConfig({ source, booksDir, checkOnly: true })
      assert.equal(checked.categoryCount, 2)
      assert.equal(fs.readFileSync(source, 'utf8'), before)
      const result = migrateLibraryApiConfig({ source, booksDir })
      assert.equal(result.sourceApiRemoved, true)
      assert.equal(result.nonApiUnchanged, true)
      assert.equal(JSON.stringify(result).includes('synthetic-secret'), false)
      assert.deepEqual(JSON.parse(fs.readFileSync(source)), {
        booksDir,
        theme: 'dark',
        imageAi: { panelWidth: 500 }
      })
      assert.equal(migrateLibraryApiConfig({ source, booksDir }).migrated, false)
    }
  )

  console.log(`Library API config: ${cases} scenarios passed.`)
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true })
}
