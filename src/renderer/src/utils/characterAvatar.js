import { joinedPathToFileUrl, pathToLocalFileUrl } from './localFileUrl.js'

/** Resolve book-relative avatars at display time so a copied library stays portable. */
export function getAvatarSrc(avatarPath, booksDir = '', bookName = '') {
  if (!avatarPath) return ''
  avatarPath = String(avatarPath).trim()

  if (
    avatarPath.startsWith('http://') ||
    avatarPath.startsWith('https://') ||
    avatarPath.startsWith('file://') ||
    avatarPath.startsWith('data:')
  ) {
    return avatarPath
  }

  const absoluteUrl = pathToLocalFileUrl(avatarPath)
  if (absoluteUrl) return absoluteUrl
  if (!booksDir || !bookName || avatarPath.split(/[\\/]/).includes('..')) return ''
  return joinedPathToFileUrl(booksDir, bookName, avatarPath)
}

/** Only positively identified links follow a character; custom node images stay independent. */
export function syncCharacterAvatars(
  nodes,
  characters,
  previousCharacters = [],
  booksDir = '',
  bookName = ''
) {
  const byId = new Map(characters.map((character) => [character.id, character]))
  const previousById = new Map(previousCharacters.map((character) => [character.id, character]))
  let changed = false
  for (const node of nodes) {
    const data = node.data
    const character = data && byId.get(data.characterId)
    if (!character || data.avatarSource === 'custom') continue
    const previous = previousById.get(character.id) || character
    const matchingPrevious =
      getAvatarSrc(data.avatar, booksDir, bookName) ===
      getAvatarSrc(previous.avatar, booksDir, bookName)
    const legacyLinkedWithoutAvatar = !data.avatarSource && !String(data.avatar || '').trim()
    if (data.avatarSource !== 'character' && !matchingPrevious && !legacyLinkedWithoutAvatar)
      continue
    if (data.avatar !== (character.avatar || '') || data.avatarSource !== 'character')
      changed = true
    data.avatar = character.avatar || ''
    data.avatarSource = 'character'
  }
  return changed
}

/** Returns an empty string when the user closes the image picker. */
export async function selectLocalAvatar() {
  const result = await window.electron.selectImage()
  return result?.filePath ? getAvatarSrc(result.filePath) : ''
}
