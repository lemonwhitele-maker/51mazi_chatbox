import { randomUUID } from 'node:crypto'

export function createId(prefix) {
  return `${prefix}_${randomUUID()}`
}

export function nowIso() {
  return new Date().toISOString()
}
