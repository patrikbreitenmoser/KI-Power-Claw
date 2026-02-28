import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { MEMORY_DIR } from './config.js'
import { searchMemory, scheduleReindex } from './qmd.js'
import { logger } from './logger.js'

const MEMORY_MD_PATH = resolve(MEMORY_DIR, 'MEMORY.md')

// ── Date helpers (Zurich timezone) ──────────────────────────

const zurichFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zurich',
  year: 'numeric', month: '2-digit', day: '2-digit',
})

export function todayZurich(): string {
  const p = zurichFormatter.formatToParts(new Date())
  const y = p.find(x => x.type === 'year')!.value
  const m = p.find(x => x.type === 'month')!.value
  const d = p.find(x => x.type === 'day')!.value
  return `${y}-${m}-${d}`
}

// ── Read MEMORY.md with graceful missing-file handling ──────

async function readMemoryMd(): Promise<string> {
  try {
    return await readFile(MEMORY_MD_PATH, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

// ── Query memory (replaces buildMemoryContext) ──────────────

export async function queryMemory(userMessage: string): Promise<string> {
  const memoryMd = await readMemoryMd()

  let qmdSection = ''
  try {
    const results = await searchMemory(userMessage, 5)
    if (results.length > 0) {
      const lines = results.map(r => `- (from ${r.file}) ${r.snippet}`)
      qmdSection = `[Relevant past context]\n${lines.join('\n')}`
    }
  } catch (err) {
    logger.warn({ err }, 'QMD search failed during queryMemory')
  }

  if (!memoryMd.trim() && !qmdSection) return ''

  const parts: string[] = []
  if (memoryMd.trim()) {
    parts.push(`[Long-term memory]\n${memoryMd.trim()}`)
  }
  if (qmdSection) {
    parts.push(qmdSection)
  }

  return parts.join('\n\n') + '\n\n'
}

// ── Append to daily log (replaces saveConversationTurn) ─────

export async function appendToDailyLog(
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  if (userMessage.length <= 20 || userMessage.startsWith('/')) return

  const today = todayZurich()
  const logPath = resolve(MEMORY_DIR, `${today}.md`)

  // Create file with header if it doesn't exist (atomic via 'ax' flag)
  try {
    await writeFile(logPath, `# ${today}\n\n`, { flag: 'ax' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  // Current time in Zurich
  const now = new Date()
  const hh = now.toLocaleString('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', hour12: false })
  const mm = now.toLocaleString('en-GB', { timeZone: 'Europe/Zurich', minute: '2-digit' })
  const timeHeader = `${hh}:${mm.padStart(2, '0')}`

  const truncatedResponse = assistantResponse.slice(0, 2000)

  const entry = `## ${timeHeader}\n\n**User**: ${userMessage}\n\n**Assistant**: ${truncatedResponse}\n\n---\n\n`
  await appendFile(logPath, entry)

  // Trigger QMD re-index (debounced, fire-and-forget)
  scheduleReindex()

  logger.debug({ logPath }, 'Appended conversation turn to daily log')
}
