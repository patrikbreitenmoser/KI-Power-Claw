import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from './env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = resolve(__dirname, '..')
export const STORE_DIR = resolve(PROJECT_ROOT, 'store')
export const MEMORY_DIR = resolve(PROJECT_ROOT, 'memory')

const env = readEnvFile()

// Telegram
export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''

// Allowlist: comma-separated Telegram user IDs
const rawAllowedIds = env['ALLOWED_USER_IDS'] ?? ''
export const ALLOWED_USER_IDS: Set<string> = new Set(
  rawAllowedIds.split(',').map(id => id.trim()).filter(Boolean)
)

// Voice STT (Groq)
export const GROQ_API_KEY = env['GROQ_API_KEY'] ?? ''

// Video analysis (Gemini)
export const GEMINI_API_KEY = env['GEMINI_API_KEY'] ?? env['GOOGLE_API_KEY'] ?? ''
export const GOOGLE_API_KEY = env['GOOGLE_API_KEY'] ?? env['GEMINI_API_KEY'] ?? ''

// Model
export const DEFAULT_MODEL = env['DEFAULT_MODEL'] ?? 'claude-sonnet-4-6'

// Logging
export const LOG_LEVEL = env['LOG_LEVEL'] ?? 'info'

// Limits
export const MAX_MESSAGE_LENGTH = 4096
export const TYPING_REFRESH_MS = 4000

// Swarm
export const AGENT_WORKSPACE_ROOT = env['AGENT_WORKSPACE_ROOT'] ?? resolve(PROJECT_ROOT, '..', 'agent-workspaces')
export const AGENT_LOG_DIR = resolve(STORE_DIR, 'agent-logs')

function safeInt(raw: string | undefined, fallback: number, min: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n >= min ? n : fallback
}

function safeFloat(raw: string | undefined, fallback: number, min: number): number {
  const n = parseFloat(raw ?? '')
  return Number.isFinite(n) && n >= min ? n : fallback
}

export const MAX_CONCURRENT_SWARM_AGENTS = safeInt(env['MAX_CONCURRENT_SWARM_AGENTS'], 8, 1)
export const SWARM_AGENT_BUDGET_USD = safeFloat(env['SWARM_AGENT_BUDGET_USD'], 5.0, 0)
export const SWARM_DAILY_BUDGET_USD = safeFloat(env['SWARM_DAILY_BUDGET_USD'], 50.0, 0)
export const SWARM_MONITOR_INTERVAL_MS = safeInt(env['SWARM_MONITOR_INTERVAL_MS'], 120_000, 1000) // 2 min
