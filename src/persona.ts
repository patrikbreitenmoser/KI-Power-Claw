import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

// --- Types ---

export interface Identity {
  name: string
  creature: string
  vibe: string
  emoji: string
  avatar: string
}

interface PersonaCache {
  soul: string
  user: string
  identity: string
  parsedIdentity: Identity
  contextBlock: string
}

// --- File paths ---

const PERSONA_FILES = {
  soul: resolve(PROJECT_ROOT, 'SOUL.md'),
  user: resolve(PROJECT_ROOT, 'USER.md'),
  identity: resolve(PROJECT_ROOT, 'IDENTITY.md'),
} as const

// --- Cache ---

let cache: PersonaCache | null = null

// --- Parsing ---

/**
 * Parse IDENTITY.md for structured fields.
 * Looks for lines like "- Name: Klaw" and extracts the value.
 */
function parseIdentity(raw: string): Identity {
  const extract = (key: string): string => {
    const re = new RegExp(`^-\\s*${key}:\\s*(.+)$`, 'im')
    const match = raw.match(re)
    return match?.[1]?.trim() ?? ''
  }

  return {
    name: extract('Name'),
    creature: extract('Creature'),
    vibe: extract('Vibe'),
    emoji: extract('Emoji'),
    avatar: extract('Avatar'),
  }
}

/**
 * Read a file if it exists, return empty string otherwise.
 */
function safeRead(path: string): string {
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    logger.warn({ err, path }, 'Failed to read persona file')
    return ''
  }
}

/**
 * Build the context block that gets prepended to messages.
 * Only includes sections that have actual content (not just template placeholders).
 */
function buildContextBlock(soul: string, user: string, identity: string): string {
  const sections: string[] = []

  if (soul.trim()) {
    sections.push(`[Soul]\n${soul.trim()}`)
  }

  if (user.trim()) {
    sections.push(`[User]\n${user.trim()}`)
  }

  if (identity.trim()) {
    sections.push(`[Identity]\n${identity.trim()}`)
  }

  if (sections.length === 0) return ''

  return sections.join('\n\n') + '\n\n'
}

// --- Public API ---

/**
 * Load all persona files from disk and cache them.
 * Call this at startup and after any file updates.
 */
export function loadPersona(): void {
  const soul = safeRead(PERSONA_FILES.soul)
  const user = safeRead(PERSONA_FILES.user)
  const identity = safeRead(PERSONA_FILES.identity)
  const parsedIdentity = parseIdentity(identity)
  const contextBlock = buildContextBlock(soul, user, identity)

  cache = { soul, user, identity, parsedIdentity, contextBlock }

  const loaded = [
    soul && 'SOUL.md',
    user && 'USER.md',
    identity && 'IDENTITY.md',
  ].filter(Boolean)

  logger.info({ files: loaded, botName: parsedIdentity.name || '(unnamed)' }, 'Persona loaded')
}

/**
 * Get the persona context block to prepend to messages.
 */
export function getPersonaContext(): string {
  if (!cache) loadPersona()
  return cache!.contextBlock
}

/**
 * Get parsed identity fields (name, emoji, etc).
 */
export function getIdentity(): Identity {
  if (!cache) loadPersona()
  return cache!.parsedIdentity
}

/**
 * Get the bot's display name, falling back to "Assistant".
 */
export function getBotName(): string {
  return getIdentity().name || 'Assistant'
}

/**
 * Get the bot's emoji prefix, or empty string if not set.
 */
export function getBotEmoji(): string {
  return getIdentity().emoji
}
