import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const output = join(root, 'src', 'main', 'harness', 'runtime', 'codex-schema')
const cli = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
if (!existsSync(cli)) throw new Error(`找不到当前工程的 Codex CLI：${cli}`)
await fs.rm(output, { recursive: true, force: true })
await fs.mkdir(output, { recursive: true })
const result = spawnSync(process.execPath, [cli, 'app-server', 'generate-json-schema', '--out', output], { stdio: 'inherit', cwd: root })
if (result.status !== 0) process.exit(result.status || 1)
const packageJson = JSON.parse(await fs.readFile(join(root, 'node_modules', '@openai', 'codex', 'package.json'), 'utf8'))
await fs.writeFile(join(output, 'VERSION.json'), `${JSON.stringify({ package: '@openai/codex', version: packageJson.version, generatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
