import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureSaveDiagnostics, logSaveDiagnostic, logRendererSaveDiagnostic, saveErrorDetails } from '../src/main/services/saveDiagnostics.js'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), '51mazi-save-diagnostics-'))
configureSaveDiagnostics(directory)
const cause = Object.assign(new Error('file busy'), { code: 'EBUSY', syscall: 'rename' })
logSaveDiagnostic('test.failure', { error: saveErrorDetails(new Error('save failed', { cause })) })
logRendererSaveDiagnostic(1, { event: 'save.request', expectedHash: 'sha256:old', content: 'PRIVATE BODY', apiKey: 'SECRET' })
const file = path.join(directory, fs.readdirSync(directory)[0])
const raw = fs.readFileSync(file, 'utf8')
const rows = raw.trim().split('\n').map(JSON.parse)
assert.equal(rows[0].error.cause.code, 'EBUSY')
assert.equal(rows[1].expectedHash, 'sha256:old')
assert.equal(raw.includes('PRIVATE BODY'), false)
assert.equal(raw.includes('SECRET'), false)
// A log path that is a file must not turn a successful save into a failure.
configureSaveDiagnostics(file)
assert.doesNotThrow(() => logSaveDiagnostic('test.unwritable'))
configureSaveDiagnostics(null)
fs.unlinkSync(file)
fs.rmdirSync(directory)
console.log('save-diagnostics-test: ok')
