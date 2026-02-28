// Nightly consolidation: extract key facts from daily logs into MEMORY.md.
// Uses Claude Code SDK login/session with tools disabled.

import { readFile, writeFile, appendFile, readdir, rename, mkdir, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { MEMORY_DIR, PROJECT_ROOT } from './config.js'
import { todayZurich } from './memory.js'
import { scheduleReindex } from './qmd.js'
import { logger } from './logger.js'

const MEMORY_MD_PATH = resolve(MEMORY_DIR, 'MEMORY.md')
const ARCHIVE_DIR = resolve(MEMORY_DIR, 'archive')
const COLD_DIR = resolve(MEMORY_DIR, 'cold')
const MEMORY_INDEX_PATH = resolve(MEMORY_DIR, 'memory_index.json')

const HOT_MAX_LINES = 200
const HOT_TARGET_LINES = 180

// ── Section classifier ───────────────────────────────────────

const SECTION_RULES: Array<{ keywords: RegExp; section: string }> = [
  {
    keywords: /\b(prefer|preference|like to|dislike|always|never|bevorzug|praeferenz|mag|nicht gern|immer|nie)\b/i,
    section: '## Preferences',
  },
  {
    keywords: /\b(project|projects|building|working on|startup|company|produkt|projekt|projekte|arbeite an|baue|firma|kunde|kundin)\b/i,
    section: '## Projects',
  },
  {
    keywords: /\b(deadline|due date|birthday|anniversary|appointment|event|date|geburtstag|termin|frist|datum|jahrestag)\b/i,
    section: '## Important Dates',
  },
  {
    keywords: /\b(currently|next step|todo|to-do|pending|follow-up|wip|im moment|aktuell|als naechstes|offen|naechster schritt)\b/i,
    section: '## Active Threads',
  },
  {
    keywords: /\b(golf|hobby|familie|family|wohnort|lebt in|based in|call him|pronouns?)\b/i,
    section: '## About Patrik',
  },
]
const DEFAULT_SECTION = '## Misc'

const SECTION_DEFAULTS: Record<string, { importance: number; volatility: number }> = {
  '## About Patrik': { importance: 0.85, volatility: 0.2 },
  '## Preferences': { importance: 0.8, volatility: 0.2 },
  '## Projects': { importance: 0.75, volatility: 0.45 },
  '## Important Dates': { importance: 0.7, volatility: 0.9 },
  '## Active Threads': { importance: 0.65, volatility: 0.8 },
  '## Misc': { importance: 0.5, volatility: 0.6 },
}

interface MemoryIndexEntry {
  id: string
  text: string
  section: string
  created_at: string
  last_seen_at: string
  last_used_at: string
  importance: number
  confidence: number
  volatility: number
  pinned: boolean
  state: 'hot' | 'cold'
  demoted_at?: string
}

interface MemoryIndexFile {
  version: 1
  updated_at: string
  entries: Record<string, MemoryIndexEntry>
}

interface ParsedMemoryEntry {
  id: string
  line: string
  section: string
  lineIndex: number
}

interface DemotedEntry {
  line: string
  section: string
  score: number
}

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

function normalizeFactLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ').toLowerCase()
}

function createEntryId(line: string): string {
  return createHash('sha1').update(normalizeFactLine(line)).digest('hex').slice(0, 16)
}

function parseMemoryEntries(content: string): ParsedMemoryEntry[] {
  const lines = content.split('\n')
  let currentSection = DEFAULT_SECTION
  const entries: ParsedMemoryEntry[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('## ')) {
      currentSection = line
      continue
    }
    if (!line.startsWith('- ')) continue

    entries.push({
      id: createEntryId(line),
      line,
      section: currentSection,
      lineIndex: i,
    })
  }

  return entries
}

function defaultImportance(section: string, text: string): number {
  let value = SECTION_DEFAULTS[section]?.importance ?? SECTION_DEFAULTS[DEFAULT_SECTION].importance
  if (/\b(always|never|must|wichtig|immer|nie)\b/i.test(text)) value += 0.1
  if (/\b(maybe|vielleicht|unsure|unklar)\b/i.test(text)) value -= 0.1
  return clamp(value, 0, 1)
}

function defaultVolatility(section: string): number {
  return clamp(
    SECTION_DEFAULTS[section]?.volatility ?? SECTION_DEFAULTS[DEFAULT_SECTION].volatility,
    0,
    1
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function daysSince(iso: string, now: Date): number {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 0
  return (now.getTime() - then) / (1000 * 60 * 60 * 24)
}

function scoreEntry(meta: MemoryIndexEntry, now: Date): number {
  const seenDays = daysSince(meta.last_seen_at, now)
  const usedDays = daysSince(meta.last_used_at, now)
  const recency = Math.max(0, 1 - seenDays / 180)
  const usage = Math.max(0, 1 - usedDays / 90)

  let score = 0
  score += meta.importance * 3.0
  score += meta.confidence * 2.0
  score += recency * 1.5
  score += usage * 1.0
  score += (1 - meta.volatility) * 1.0

  if (meta.section === '## Active Threads' && seenDays > 30) score -= 1.2
  if (meta.section === '## Important Dates' && seenDays > 365) score -= 0.8

  const yearMatch = meta.text.match(/\b(20\d{2})\b/)
  if (yearMatch) {
    const year = Number(yearMatch[1])
    if (!Number.isNaN(year) && year < now.getFullYear() - 1) {
      score -= 0.5
    }
  }

  if (meta.pinned) score += 100
  return score
}

function normalizeSpacing(content: string): string {
  return content.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

async function readMemoryIndex(): Promise<MemoryIndexFile> {
  try {
    const raw = await readFile(MEMORY_INDEX_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<MemoryIndexFile>
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      return {
        version: 1,
        updated_at: parsed.updated_at ?? new Date().toISOString(),
        entries: parsed.entries as Record<string, MemoryIndexEntry>,
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err }, 'Failed to read memory index, rebuilding')
    }
  }

  return { version: 1, updated_at: new Date().toISOString(), entries: {} }
}

async function writeMemoryIndex(index: MemoryIndexFile): Promise<void> {
  index.updated_at = new Date().toISOString()
  await writeFile(MEMORY_INDEX_PATH, JSON.stringify(index, null, 2) + '\n')
}

function syncIndexWithHotEntries(
  index: MemoryIndexFile,
  hotEntries: ParsedMemoryEntry[],
  nowIso: string
): void {
  const hotIds = new Set<string>()

  for (const entry of hotEntries) {
    hotIds.add(entry.id)
    const existing = index.entries[entry.id]
    if (existing) {
      existing.text = entry.line
      existing.section = entry.section
      existing.last_seen_at = nowIso
      if (!existing.last_used_at) existing.last_used_at = nowIso
      existing.state = 'hot'
      delete existing.demoted_at
      continue
    }

    index.entries[entry.id] = {
      id: entry.id,
      text: entry.line,
      section: entry.section,
      created_at: nowIso,
      last_seen_at: nowIso,
      last_used_at: nowIso,
      importance: defaultImportance(entry.section, entry.line),
      confidence: 0.75,
      volatility: defaultVolatility(entry.section),
      pinned: false,
      state: 'hot',
    }
  }

  for (const meta of Object.values(index.entries)) {
    if (meta.state === 'hot' && !hotIds.has(meta.id)) {
      meta.state = 'cold'
      if (!meta.demoted_at) meta.demoted_at = nowIso
    }
  }
}

function compactHotMemory(
  content: string,
  index: MemoryIndexFile,
  now: Date
): { content: string; demoted: DemotedEntry[] } {
  const lines = content.split('\n')
  if (lines.length <= HOT_MAX_LINES) {
    return { content, demoted: [] }
  }

  const entries = parseMemoryEntries(content)
  if (entries.length === 0) {
    return { content, demoted: [] }
  }

  const candidates = entries
    .map(entry => {
      const meta = index.entries[entry.id]
      const score = meta ? scoreEntry(meta, now) : 0
      return { entry, meta, score }
    })
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      const aCreated = Date.parse(a.meta?.created_at ?? '')
      const bCreated = Date.parse(b.meta?.created_at ?? '')
      if (Number.isNaN(aCreated) || Number.isNaN(bCreated)) return 0
      return aCreated - bCreated
    })

  const removeLineIndexes = new Set<number>()
  const demoted: DemotedEntry[] = []
  let projectedLineCount = lines.length
  const nowIso = now.toISOString()

  for (const candidate of candidates) {
    if (projectedLineCount <= HOT_TARGET_LINES) break
    if (candidate.meta?.pinned) continue
    if (removeLineIndexes.has(candidate.entry.lineIndex)) continue

    removeLineIndexes.add(candidate.entry.lineIndex)
    projectedLineCount -= 1
    demoted.push({
      line: candidate.entry.line,
      section: candidate.entry.section,
      score: candidate.score,
    })

    const meta = index.entries[candidate.entry.id]
    if (meta) {
      meta.state = 'cold'
      meta.demoted_at = nowIso
      meta.last_seen_at = nowIso
    }
  }

  if (demoted.length === 0) {
    return { content, demoted: [] }
  }

  const compactedLines = lines.filter((_, idx) => !removeLineIndexes.has(idx))
  return { content: normalizeSpacing(compactedLines.join('\n')), demoted }
}

async function appendDemotedEntriesToCold(demoted: DemotedEntry[]): Promise<void> {
  if (demoted.length === 0) return

  await mkdir(COLD_DIR, { recursive: true })
  const day = todayZurich()
  const coldPath = resolve(COLD_DIR, `${day}.md`)

  try {
    await writeFile(coldPath, `# Demoted Memory Entries (${day})\n\n`, { flag: 'ax' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  const time = new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Europe/Zurich',
    hour12: false,
  })
  const blockLines = [
    `## ${time}`,
    '',
    ...demoted.map(d => `${d.line} [section=${d.section}] [score=${d.score.toFixed(2)}] [demoted_for_hot_limit]`),
    '',
    '---',
    '',
  ]
  await appendFile(coldPath, blockLines.join('\n'))
}

async function enforceMemoryHotLimit(): Promise<{ demoted: number }> {
  let memoryContent = await readMemoryMd()
  const index = await readMemoryIndex()
  const now = new Date()
  const nowIso = now.toISOString()

  const hotEntries = parseMemoryEntries(memoryContent)
  syncIndexWithHotEntries(index, hotEntries, nowIso)

  const { content: compacted, demoted } = compactHotMemory(memoryContent, index, now)
  if (compacted !== memoryContent) {
    memoryContent = compacted
    await writeFile(MEMORY_MD_PATH, memoryContent)
  }

  await appendDemotedEntriesToCold(demoted)
  await writeMemoryIndex(index)

  return { demoted: demoted.length }
}

// ── Main consolidation function ──────────────────────────────

let consolidationRunning = false

function buildConsolidationPrompt(date: string, content: string): string {
  return `Review this daily conversation log and extract any important facts, preferences, decisions, or information worth remembering long-term. Return ONLY the facts as a bulleted list (each line starting with "- "), or "nothing notable" if there's nothing worth keeping. Be selective -- only genuinely useful information.\n\nDate: ${date}\n\n${content}`
}

async function extractFactsFromLog(date: string, content: string): Promise<string> {
  const prompt = buildConsolidationPrompt(date, content)

  // Use Claude Code SDK login/session, but disable all tools.
  let resultText = ''
  const response = query({
    prompt,
    options: {
      model: 'claude-sonnet-4-6',
      cwd: PROJECT_ROOT,
      settingSources: [],
      tools: [],
      permissionMode: 'default',
      maxTurns: 1,
      persistSession: false,
    },
  })

  for await (const event of response) {
    if (event.type !== 'result') continue
    if (event.subtype === 'success') {
      resultText = event.result ?? ''
      continue
    }
    throw new Error(`Consolidation agent returned ${event.subtype}`)
  }

  return resultText.trim()
}

export async function consolidateDailyLogs(): Promise<{ processed: number; facts: number }> {
  if (consolidationRunning) {
    logger.warn('Consolidation already in progress, skipping')
    return { processed: 0, facts: 0 }
  }

  consolidationRunning = true
  try {
    logger.info({ backend: 'claude-code-sdk' }, 'Consolidation backend selected')

    // List daily logs matching YYYY-MM-DD.md pattern
    const allFiles = await readdir(MEMORY_DIR)
    const dailyLogPattern = /^\d{4}-\d{2}-\d{2}\.md$/
    const dailyLogs = allFiles.filter(f => dailyLogPattern.test(f)).sort()

    // Skip today's log (still being written)
    const today = todayZurich()
    const eligible = dailyLogs.filter(f => f.replace('.md', '') < today)

    if (eligible.length === 0) {
      const { demoted } = await enforceMemoryHotLimit()
      if (demoted > 0) {
        logger.info({ demoted }, 'Memory hot limit enforced without new daily logs')
      }
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

        const responseText = await extractFactsFromLog(date, content)

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

    const { demoted } = await enforceMemoryHotLimit()
    if (demoted > 0) {
      logger.info({ demoted }, 'Demoted low-relevance memory entries to cold storage')
      scheduleReindex()
    }

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
