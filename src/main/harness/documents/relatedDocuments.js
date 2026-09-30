// Match each returned fragment separately: names must not span pages or files.
export function matchRelatedDocuments(structure, fragments) {
  const documents = new Map()
  for (const [collection, sourceType] of [['characters', 'character'], ['settings', 'setting']]) {
    for (const entry of structure[collection] || []) {
      const path = `book/${String(entry.path || `knowledge/${collection}/${entry.targetId}.md`).replaceAll('\\', '/')}`
      const matchedNames = new Set()
      for (const value of [entry.title, ...(entry.aliases || [])]) {
        const name = typeof value === 'string' ? value.trim() : ''
        if (!name) continue
        const pattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
        for (const text of fragments) {
          for (const match of text.matchAll(pattern)) matchedNames.add(match[0])
        }
      }
      if (!matchedNames.size) continue
      const previous = documents.get(path)
      documents.set(path, {
        sourceType,
        title: entry.title,
        path,
        matchedNames: [...new Set([...(previous?.matchedNames || []), ...matchedNames])]
      })
    }
  }
  return [...documents.values()]
}
