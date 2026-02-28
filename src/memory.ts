import {
  searchMemoriesFts,
  getRecentMemories,
  touchMemory,
  insertMemory,
  decayAllMemories,
} from './db.js'
import { logger } from './logger.js'

const SEMANTIC_SIGNALS = /\b(my|i am|i'm|i prefer|remember|always|never)\b/i

/**
 * Build memory context to prepend before the user's message.
 * 1. FTS5 search for top 3 relevant memories
 * 2. Fetch 5 most recent memories
 * 3. Deduplicate by id
 * 4. Touch each result (boost salience + update accessed_at)
 * 5. Return formatted block or empty string
 */
export function buildMemoryContext(chatId: string, userMessage: string): string {
  const ftsResults = searchMemoriesFts(chatId, userMessage, 3)
  const recentResults = getRecentMemories(chatId, 5)

  // Deduplicate
  const seen = new Set<number>()
  const combined = []
  for (const m of [...ftsResults, ...recentResults]) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      combined.push(m)
    }
  }

  if (combined.length === 0) return ''

  // Touch each memory to reinforce salience
  for (const m of combined) {
    touchMemory(m.id)
  }

  const lines = combined.map((m) => `- ${m.content} (${m.sector})`)
  return `[Memory context]\n${lines.join('\n')}\n\n`
}

/**
 * Save a conversation turn as a memory.
 * Detects semantic signals to classify as semantic vs episodic.
 */
export function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string
): void {
  // Skip trivial messages or commands
  if (userMsg.length <= 20 || userMsg.startsWith('/')) return

  const sector = SEMANTIC_SIGNALS.test(userMsg) ? 'semantic' : 'episodic'

  // Save user message
  insertMemory(chatId, userMsg, sector)

  // Save assistant response if substantial
  if (assistantMsg.length > 50) {
    insertMemory(chatId, assistantMsg.slice(0, 500), 'episodic')
  }

  logger.debug({ chatId, sector }, 'Saved conversation turn to memory')
}

/**
 * Run the daily decay sweep.
 * Reduce salience by 2% for memories older than 24h.
 * Delete memories with salience below 0.1.
 */
export function runDecaySweep(): void {
  logger.info('Running memory decay sweep')
  decayAllMemories()
}
