import crypto from 'node:crypto'

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function sha256Canonical(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

export function contractProjection(definition) {
  const fields = ['name', 'version', 'description', 'risk', 'sideEffect', 'inputSchema', 'outputSchema', 'semanticPolicy', 'normalizationPolicy', 'errorPolicy', 'timeoutMs', 'resultBudget']
  return Object.fromEntries(fields.filter((key) => definition[key] !== undefined).map((key) => [key, definition[key]]))
}

export function contractHash(definition) { return sha256Canonical(contractProjection(definition)) }
export function toolsetHash(definitions) {
  return sha256Canonical(definitions.map((definition) => ({ name: definition.name, contractHash: definition.contractHash || contractHash(definition) })).sort((a, b) => a.name.localeCompare(b.name)))
}
