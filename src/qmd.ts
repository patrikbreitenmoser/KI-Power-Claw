// QMD v1.0.7 -- collection configured in T1
// CLI wrapper for QMD semantic search over memory/ directory.
// Always uses execFile (no shell spawning) to prevent injection.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { logger } from './logger.js'
import { PROJECT_ROOT } from './config.js'

const execFileAsync = promisify(execFile)

const suffix = createHash('md5').update(PROJECT_ROOT).digest('hex').slice(0, 6)
const QMD_COLLECTION = `bot-memory-${suffix}`

// ── Types ──────────────────────────────────────────────────

export interface QmdSearchResult {
  docid: string
  score: number
  file: string
  title: string
  snippet: string
}

function isQmdSearchResult(value: unknown): value is QmdSearchResult {
  return (
    typeof value === 'object' && value !== null &&
    typeof (value as Record<string, unknown>).docid === 'string' &&
    typeof (value as Record<string, unknown>).score === 'number' &&
    typeof (value as Record<string, unknown>).snippet === 'string'
  )
}

// ── Search ─────────────────────────────────────────────────

export async function searchMemory(query: string, limit?: number): Promise<QmdSearchResult[]> {
  try {
    const { stdout } = await execFileAsync('qmd', [
      'search', query, '-c', QMD_COLLECTION, '--json', '-n', String(limit ?? 5),
    ], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })

    if (!stdout.trim()) return []
    let parsed: unknown
    try { parsed = JSON.parse(stdout) } catch { return [] }
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isQmdSearchResult)
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; code?: number }
    logger.warn({ err, stderr: execErr.stderr, code: execErr.code }, 'QMD search failed')
    return []
  }
}

// ── Reindex (debounced) ────────────────────────────────────

let reindexTimer: ReturnType<typeof setTimeout> | undefined
let reindexInProgress = false

export function scheduleReindex(): void {
  if (reindexTimer) clearTimeout(reindexTimer)
  reindexTimer = setTimeout(async () => {
    if (reindexInProgress) return
    reindexInProgress = true
    try {
      await execFileAsync('qmd', ['update'], { timeout: 30_000 })
      await execFileAsync('qmd', ['embed'], { timeout: 120_000 })
    } catch (err) {
      logger.warn({ err }, 'QMD reindex failed')
    } finally {
      reindexInProgress = false
    }
  }, 5_000)
}

// ── Health check ───────────────────────────────────────────

export async function checkQmdAvailable(): Promise<boolean> {
  try {
    await execFileAsync('qmd', ['status'], { timeout: 5_000 })
    logger.info('QMD is available')
    return true
  } catch (err) {
    logger.warn({ err }, 'QMD is not available')
    return false
  }
}
