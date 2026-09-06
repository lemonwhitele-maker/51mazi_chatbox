import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import readline from 'node:readline'

const codexRequire = createRequire(import.meta.url)
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const STARTUP_TIMEOUT_MS = 20_000

function normalizeError(error, fallback = 'Codex App Server 请求失败') {
  if (error instanceof Error) return error
  const message = error?.message || fallback
  const normalized = new Error(String(message))
  if (error?.code !== undefined) normalized.code = error.code
  if (error?.data !== undefined) normalized.data = error.data
  return normalized
}

function findBundledCodexEntry() {
  const candidates = []

  try {
    candidates.push(codexRequire.resolve('@openai/codex'))
  } catch {
    // 部分版本不导出主入口，继续尝试 package.json。
  }

  try {
    const packageJsonPath = codexRequire.resolve('@openai/codex/package.json')
    const packageDir = dirname(packageJsonPath)
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    const binEntry =
      typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin?.codex || Object.values(packageJson.bin || {})[0]
    if (binEntry) candidates.push(join(packageDir, binEntry))
    candidates.push(join(packageDir, 'bin', 'codex.js'))
  } catch {
    // 未安装固定运行时，后续回退到 PATH 中的官方 codex 命令。
  }

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null
}

function findBundledCodexExecutable() {
  const targets = {
    'win32:x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc', 'codex.exe'],
    'win32:arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc', 'codex.exe'],
    'darwin:x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin', 'codex'],
    'darwin:arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin', 'codex'],
    'linux:x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl', 'codex'],
    'linux:arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl', 'codex']
  }
  const target = targets[`${process.platform}:${process.arch}`]
  if (!target) return null

  try {
    const packageJsonPath = codexRequire.resolve(`${target[0]}/package.json`)
    const executable = join(dirname(packageJsonPath), 'vendor', target[1], 'bin', target[2])
    const asarMarker = `${sep}app.asar${sep}`
    const unpackedMarker = `${sep}app.asar.unpacked${sep}`
    const unpackedExecutable = executable.includes(asarMarker)
      ? executable.replace(asarMarker, unpackedMarker)
      : executable
    if (fs.existsSync(unpackedExecutable)) return unpackedExecutable
    return fs.existsSync(executable) ? executable : null
  } catch {
    return null
  }
}

function resolveLaunchSpec() {
  // 仅供开发和自动化测试覆盖；渲染进程不会暴露这个入口。
  const commandOverride = String(process.env.MAZI_CODEX_COMMAND || '').trim()
  if (commandOverride) {
    return {
      command: commandOverride,
      args: ['app-server', '--listen', 'stdio://'],
      source: 'environment'
    }
  }

  const bundledExecutable = findBundledCodexExecutable()
  if (bundledExecutable) {
    return {
      command: bundledExecutable,
      args: ['app-server', '--listen', 'stdio://'],
      source: 'bundled-native'
    }
  }

  const bundledEntry = findBundledCodexEntry()
  if (bundledEntry) {
    return {
      command: process.execPath,
      args: [bundledEntry, 'app-server', '--listen', 'stdio://'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      source: 'bundled'
    }
  }

  return {
    command: 'codex',
    args: ['app-server', '--listen', 'stdio://'],
    source: 'path'
  }
}

function sanitizeAccount(result) {
  const account = result?.account || null
  if (!account) {
    return {
      signedIn: false,
      requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth)
    }
  }

  return {
    signedIn: true,
    type: account.type || null,
    email: account.email || null,
    planType: account.planType || null,
    requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth)
  }
}

export class CodexAppServerBridge extends EventEmitter {
  constructor({ clientVersion = '0.0.0', requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, experimentalApi = false } = {}) {
    super()
    this.clientVersion = clientVersion
    this.requestTimeoutMs = requestTimeoutMs
    this.experimentalApi = Boolean(experimentalApi)
    this.process = null
    this.readline = null
    this.nextRequestId = 1
    this.pending = new Map()
    this.serverRequestHandlers = new Map()
    this.activeServerRequests = new Map()
    this.startPromise = null
    this.intentionalStop = false
    this.stderrTail = []
    this.state = {
      phase: 'stopped',
      runtimeSource: null,
      account: null,
      error: null
    }
  }

  getStatus() {
    return {
      ...this.state,
      account: this.state.account ? { ...this.state.account } : null
    }
  }

  setState(patch) {
    this.state = { ...this.state, ...patch }
    this.emit('status', this.getStatus())
  }

  registerServerRequestHandler(method, handler) {
    if (!method || typeof handler !== 'function') throw new Error('服务端请求处理器无效')
    this.serverRequestHandlers.set(String(method), handler)
    return () => {
      if (this.serverRequestHandlers.get(String(method)) === handler) this.serverRequestHandlers.delete(String(method))
    }
  }

  async start() {
    if (this.state.phase === 'ready' && this.process) return this.getStatus()
    if (this.startPromise) return this.startPromise

    this.startPromise = this.startInternal()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async startInternal() {
    this.stopProcessOnly()
    this.intentionalStop = false
    this.stderrTail = []

    const launch = resolveLaunchSpec()
    this.setState({
      phase: 'starting',
      runtimeSource: launch.source,
      account: null,
      error: null
    })

    let child
    try {
      child = spawn(launch.command, launch.args, {
        cwd: process.cwd(),
        env: { ...process.env, ...(launch.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      this.handleFatalError(error)
      throw normalizeError(error, '无法启动 Codex App Server')
    }

    this.process = child
    child.once('error', (error) => this.handleFatalError(error))
    child.once('exit', (code, signal) => this.handleExit(code, signal))
    child.stderr.on('data', (chunk) => this.captureStderr(chunk))
    this.readline = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.readline.on('line', (line) => this.handleLine(line))

    const startupTimer = setTimeout(() => {
      this.rejectAll(new Error('Codex App Server 启动超时'))
      this.stopProcessOnly()
    }, STARTUP_TIMEOUT_MS)

    try {
      await this.requestRaw('initialize', {
        clientInfo: {
          name: '51mazi',
          title: '51码字',
          version: this.clientVersion
        },
        ...(this.experimentalApi ? { capabilities: { experimentalApi: true } } : {})
      })
      this.notify('initialized', {})

      return await this.refreshAccount({ refreshToken: true })
    } catch (error) {
      const normalized = normalizeError(error, 'Codex App Server 初始化失败')
      this.setState({ phase: 'error', error: normalized.message })
      this.stopProcessOnly()
      throw normalized
    } finally {
      clearTimeout(startupTimer)
    }
  }

  async restart() {
    await this.stop()
    return this.start()
  }

  async refreshAccount({ refreshToken = true } = {}) {
    const accountResult = await this.requestRaw('account/read', { refreshToken })
    const account = sanitizeAccount(accountResult)
    this.setState({ phase: 'ready', account, error: null })
    return this.getStatus()
  }

  async listModels() {
    const models = []
    let cursor = null
    for (let page = 0; page < 20; page += 1) {
      const params = { includeHidden: false }
      if (cursor) params.cursor = cursor
      const result = await this.request('model/list', params)
      const pageModels = Array.isArray(result?.data)
        ? result.data
        : result?.data?.models || result?.models || []
      if (Array.isArray(pageModels)) models.push(...pageModels)
      cursor = result?.nextCursor || result?.next_cursor || result?.data?.nextCursor || null
      if (!cursor) break
    }
    return { models }
  }

  async stop() {
    this.intentionalStop = true
    this.rejectAll(new Error('Codex App Server 已停止'))
    this.stopProcessOnly()
    this.setState({ phase: 'stopped', account: null, error: null })
  }

  stopProcessOnly() {
    if (this.readline) {
      this.readline.close()
      this.readline = null
    }
    if (this.process) {
      this.process.removeAllListeners()
      this.process.stdout?.removeAllListeners()
      this.process.stderr?.removeAllListeners()
      if (!this.process.killed) this.process.kill()
      this.process = null
    }
    this.activeServerRequests.clear()
  }

  async request(method, params = {}, options = {}) {
    await this.start()
    return this.requestRaw(method, params, options)
  }

  requestRaw(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new Error('Codex App Server 尚未连接'))
    }

    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex App Server 请求超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })

      try {
        this.writeMessage({ method, id, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(normalizeError(error))
      }
    })
  }

  notify(method, params = {}) {
    if (!this.process?.stdin?.writable) return false
    this.writeMessage({ method, params })
    return true
  }

  writeMessage(message) {
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  handleLine(line) {
    const trimmed = String(line || '').trim()
    if (!trimmed) return

    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      this.emit('protocol-warning', { message: 'Codex App Server 输出了非 JSON 数据' })
      return
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(normalizeError(message.error))
      else pending.resolve(message.result)
      return
    }

    if (message.id !== undefined && message.method) {
      const method = String(message.method)
      const handler = this.serverRequestHandlers.get(method)
      if (!handler) {
        this.writeMessage({ id: message.id, error: { code: -32601, message: `51mazi 暂不支持服务端请求：${method}` } })
        this.emit('server-request-rejected', { method })
        return
      }
      const requestKey = String(message.id)
      if (this.activeServerRequests.has(requestKey)) return
      this.activeServerRequests.set(requestKey, { method })
      Promise.resolve()
        .then(() => handler(message.params, { requestId: message.id }))
        .then((result) => {
          if (!this.activeServerRequests.has(requestKey) || !this.process?.stdin?.writable) return
          this.writeMessage({ id: message.id, result })
        })
        .catch((error) => {
          if (!this.activeServerRequests.has(requestKey) || !this.process?.stdin?.writable) return
          this.writeMessage({ id: message.id, error: { code: -32000, message: String(error?.message || '服务端请求处理失败') } })
        })
        .finally(() => this.activeServerRequests.delete(requestKey))
      return
    }

    if (message.method) {
      this.emit('notification', message)
    }
  }

  captureStderr(chunk) {
    const lines = String(chunk || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    this.stderrTail.push(...lines)
    if (this.stderrTail.length > 20) this.stderrTail.splice(0, this.stderrTail.length - 20)
  }

  handleFatalError(error) {
    const normalized = normalizeError(error, 'Codex App Server 进程错误')
    this.rejectAll(normalized)
    this.setState({ phase: 'error', error: normalized.message })
    this.emit('fatal-error', normalized)
  }

  handleExit(code, signal) {
    this.process = null
    this.readline = null
    const stderr = this.stderrTail.slice(-3).join(' | ')
    const message = this.intentionalStop
      ? null
      : `Codex App Server 已退出（code=${code ?? 'null'}, signal=${signal || 'none'}）${stderr ? `：${stderr}` : ''}`

    if (message) {
      const error = new Error(message)
      this.rejectAll(error)
      this.setState({ phase: 'error', account: null, error: message })
      this.emit('fatal-error', error)
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export default CodexAppServerBridge
