// Nightly consolidation: extract key facts from daily logs into MEMORY.md.
// Uses direct Anthropic Messages API -- NO agent tools, NO bypassPermissions.

import { readFile, writeFile, appendFile, readdir, rename, mkdir, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { ANTHROPIC_API_KEY, MEMORY_DIR } from './config.js'
import { todayZurich } from './memory.js'
import { scheduleReindex } from './qmd.js'
import { logger } from './logger.js'

const MEMORY_MD_PATH = resolve(MEMORY_DIR, 'MEMORY.md')
const ARCHIVE_DIR = resolve(MEMORY_DIR, 'archive')

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

// ── Section classifier ───────────────────────────────────────

const SECTION_RULES: Array<{ keywords: RegExp; section: string }> = [
  { keywords: /prefer|like|dislike|always|never/i, section: '## Preferences' },
  { keywords: /project|building|working on/i, section: '## Projects' },
  { keywords: /birthday|deadline|date|event/i, section: '## Important Dates' },
]
const DEFAULT_SECTION = '## Misc'

function classifyFact(line: string): string {
  for (const rule of SECTION_RULES) {
    if (rule.keywords.test(line)) return rule.section
  }
  return DEFAULT_SECTION
}

// ── Section insertion helper ─────────────────────────────────

async function readMemoryMd(): Promise<string> {
  try {
    return await readFile(MEMORY_MD_PATH, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

function insertUnderSection(content: string, section: string, newLines: string[]): string {
  const lines = content.split('\n')
  // Find the target section header
  const sectionIdx = lines.findIndex(l => l.trim() === section)
  if (sectionIdx === -1) {
    // Section not found -- append at end with header
    return content.trimEnd() + '\n\n' + section + '\n' + newLines.join('\n') + '\n'
  }

  // Find the next section header (## ...) after our target, or EOF
  let insertIdx = lines.length
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      insertIdx = i
      break
    }
  }

  // Insert new lines before the next section (or EOF)
  const before = lines.slice(0, insertIdx)
  const after = lines.slice(insertIdx)

  // Trim trailing empty lines from `before` to keep formatting clean
  while (before.length > 0 && before[before.length - 1].trim() === '') {
    before.pop()
  }

  return [...before, ...newLines, '', ...after].join('\n')
}

// ── Main consolidation function ──────────────────────────────

let consolidationRunning = false

export async function consolidateDailyLogs(): Promise<{ processed: number; facts: number }> {
  if (consolidationRunning) {
    logger.warn('Consolidation already in progress, skipping')
    return { processed: 0, facts: 0 }
  }
  if (!ANTHROPIC_API_KEY) {
    logger.warn('ANTHROPIC_API_KEY not set, skipping consolidation')
    return { processed: 0, facts: 0 }
  }

  consolidationRunning = true
  try {
    // List daily logs matching YYYY-MM-DD.md pattern
    const allFiles = await readdir(MEMORY_DIR)
    const dailyLogPattern = /^\d{4}-\d{2}-\d{2}\.md$/
    const dailyLogs = allFiles.filter(f => dailyLogPattern.test(f)).sort()

    // Skip today's log (still being written)
    const today = todayZurich()
    const eligible = dailyLogs.filter(f => f.replace('.md', '') < today)

    if (eligible.length === 0) {
      logger.info('No daily logs to consolidate')
      return { processed: 0, facts: 0 }
    }

    logger.info({ count: eligible.length }, 'Starting daily log consolidation')

    // Create archive directory
    await mkdir(ARCHIVE_DIR, { recursive: true })

    // Backup MEMORY.md once before we start modifying it
    await copyFile(MEMORY_MD_PATH, MEMORY_MD_PATH + '.bak').catch(() => {})

    let totalProcessed = 0
    let totalFacts = 0

    for (const file of eligible) {
      const date = file.replace('.md', '')
      const filePath = resolve(MEMORY_DIR, file)

      try {
        // Read and truncate log content
        let content = await readFile(filePath, 'utf-8')
        if (content.length > 50_000) {
          content = content.slice(0, 50_000)
        }

        if (content.trim().length === 0) {
          // Empty log, just archive it
          await rename(filePath, resolve(ARCHIVE_DIR, file))
          totalProcessed++
          continue
        }

        // Call Anthropic Messages API (no tools, no agent)
        const response = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: `Review this daily conversation log and extract any important facts, preferences, decisions, or information worth remembering long-term. Return ONLY the facts as a bulleted list (each line starting with "- "), or "nothing notable" if there's nothing worth keeping. Be selective -- only genuinely useful information.\n\nDate: ${date}\n\n${content}`,
          }],
        })

        // Extract text from response
        const textBlock = response.content.find(b => b.type === 'text')
        const responseText = textBlock ? textBlock.text.trim() : ''

        if (!responseText || /^nothing notable$/i.test(responseText)) {
          logger.debug({ date }, 'No notable facts in daily log')
          await rename(filePath, resolve(ARCHIVE_DIR, file))
          totalProcessed++
          continue
        }

        // Validate and extract fact lines
        const factLines = responseText
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.startsWith('- '))

        if (factLines.length === 0) {
          logger.debug({ date, responseText }, 'Claude response contained no valid fact lines')
          await rename(filePath, resolve(ARCHIVE_DIR, file))
          totalProcessed++
          continue
        }

        // Read current MEMORY.md for dedup and insertion
        let memoryContent = await readMemoryMd()

        // Group facts by section
        const factsBySection = new Map<string, string[]>()
        for (const line of factLines) {
          // Dedup: skip if identical line already exists
          if (memoryContent.includes(line)) {
            logger.debug({ line }, 'Skipping duplicate fact')
            continue
          }

          const section = classifyFact(line)
          const existing = factsBySection.get(section) ?? []
          existing.push(line)
          factsBySection.set(section, existing)
        }

        // Insert facts under their sections
        let newFactCount = 0
        for (const [section, lines] of factsBySection) {
          memoryContent = insertUnderSection(memoryContent, section, lines)
          newFactCount += lines.length
        }

        if (newFactCount > 0) {
          await writeFile(MEMORY_MD_PATH, memoryContent)
          totalFacts += newFactCount
          logger.info({ date, facts: newFactCount }, 'Extracted facts from daily log')
        }

        // Move processed log to archive
        await rename(filePath, resolve(ARCHIVE_DIR, file))
        totalProcessed++

      } catch (err) {
        logger.error({ err, date }, 'Failed to consolidate daily log')
        // Continue with next log, don't abort the whole batch
      }
    }

    // Trigger QMD re-index after all changes
    scheduleReindex()

    // Warn if MEMORY.md is getting large
    const finalContent = await readMemoryMd()
    const lineCount = finalContent.split('\n').length
    if (lineCount > 200) {
      logger.warn({ lineCount }, 'MEMORY.md exceeds 200 lines -- consider manual review and pruning')
    }

    logger.info({ processed: totalProcessed, facts: totalFacts }, 'Consolidation complete')
    return { processed: totalProcessed, facts: totalFacts }

  } finally {
    consolidationRunning = false
  }
}
