import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from './env.js'
import { logger } from './logger.js'

type AgentTraceMode = 'off' | 'errors' | 'full'
type AgentTraceStatus = 'success' | 'error'

export interface AgentTraceContext {
  source: 'message' | 'scheduler' | 'subagent' | 'unknown'
  chatId?: string
  taskId?: string
  agentId?: string
  description?: string
}

interface WriteAgentTraceInput {
  prompt: string
  resultText: string | null
  model?: string
  sessionId?: string
  newSessionId?: string
  status: AgentTraceStatus
  error?: string
  durationMs: number
  context?: AgentTraceContext
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const VALID_MODES = new Set<AgentTraceMode>(['off', 'errors', 'full'])
const REDACTED = '***REDACTED***'

const env = readEnvFile(['AGENT_TRACE_MODE', 'AGENT_TRACE_RETENTION_DAYS', 'AGENT_TRACE_DIR'])
const rawMode = (process.env.AGENT_TRACE_MODE ?? env['AGENT_TRACE_MODE'] ?? 'off').toLowerCase()
const TRACE_MODE: AgentTraceMode = VALID_MODES.has(rawMode as AgentTraceMode)
  ? rawMode as AgentTraceMode
  : 'off'
const TRACE_RETENTION_DAYS = parseRetentionDays(
  process.env.AGENT_TRACE_RETENTION_DAYS ?? env['AGENT_TRACE_RETENTION_DAYS'] ?? '14'
)
const TRACE_DIR =
  process.env.AGENT_TRACE_DIR ??
  env['AGENT_TRACE_DIR'] ??
  resolve(PROJECT_ROOT, 'store', 'agent-trace')

const zurichFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zurich',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

let lastCleanupDay: string | null = null

export async function writeAgentTrace(input: WriteAgentTraceInput): Promise<void> {
  if (!shouldPersist(input.status)) return

  const today = todayZurich()
  const includePayload = TRACE_MODE === 'full' || input.status === 'error'
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    source: input.context?.source ?? 'unknown',
    chatId: input.context?.chatId,
    taskId: input.context?.taskId,
    agentId: input.context?.agentId,
    description: input.context?.description,
    model: input.model ?? null,
    sessionId: input.sessionId ?? null,
    newSessionId: input.newSessionId ?? null,
    status: input.status,
    durationMs: input.durationMs,
    error: input.error ? redact(input.error) : null,
  }

  if (includePayload) {
    record['prompt'] = redact(input.prompt)
    record['result'] = input.resultText === null ? null : redact(input.resultText)
  }

  try {
    await mkdir(TRACE_DIR, { recursive: true })
    await cleanupOldTraceFiles(today)

    const path = resolve(TRACE_DIR, `${today}.jsonl`)
    await appendFile(path, JSON.stringify(withoutUndefined(record)) + '\n')
  } catch (err) {
    logger.warn({ err }, 'Failed to persist agent trace')
  }
}

function shouldPersist(status: AgentTraceStatus): boolean {
  if (TRACE_MODE === 'off') return false
  if (TRACE_MODE === 'errors') return status === 'error'
  return true
}

function todayZurich(): string {
  const parts = zurichFormatter.formatToParts(new Date())
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970'
  const m = parts.find((p) => p.type === 'month')?.value ?? '01'
  const d = parts.find((p) => p.type === 'day')?.value ?? '01'
  return `${y}-${m}-${d}`
}

function parseRetentionDays(raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 365) return 14
  return parsed
}

async function cleanupOldTraceFiles(today: string): Promise<void> {
  if (lastCleanupDay === today) return
  lastCleanupDay = today

  let files: string[]
  try {
    files = await readdir(TRACE_DIR)
  } catch {
    return
  }

  const todayMs = Date.parse(`${today}T00:00:00.000Z`)
  if (Number.isNaN(todayMs)) return

  for (const file of files) {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file)
    if (!match) continue

    const fileDate = match[1]
    const fileMs = Date.parse(`${fileDate}T00:00:00.000Z`)
    if (Number.isNaN(fileMs)) continue

    const ageDays = Math.floor((todayMs - fileMs) / 86_400_000)
    if (ageDays <= TRACE_RETENTION_DAYS) continue

    try {
      await unlink(resolve(TRACE_DIR, file))
    } catch {
      // ignore per-file cleanup errors
    }
  }
}

function redact(text: string): string {
  let out = text

  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, `Bearer ${REDACTED}`)
  out = out.replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, REDACTED)

  for (const secret of gatherSecrets()) {
    if (!secret || secret.length < 6) continue
    out = out.split(secret).join(REDACTED)
  }

  return out
}

function gatherSecrets(): string[] {
  const envFromFile = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'GROQ_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
  ])

  const values = [
    process.env.TELEGRAM_BOT_TOKEN ?? envFromFile['TELEGRAM_BOT_TOKEN'],
    process.env.GROQ_API_KEY ?? envFromFile['GROQ_API_KEY'],
    process.env.GEMINI_API_KEY ?? envFromFile['GEMINI_API_KEY'],
    process.env.GOOGLE_API_KEY ?? envFromFile['GOOGLE_API_KEY'],
  ]

  return Array.from(new Set(values.filter((v): v is string => !!v)))
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out
}
