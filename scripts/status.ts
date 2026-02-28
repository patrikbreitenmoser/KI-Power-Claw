import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const ok = (msg: string) => console.log(`  ${GREEN}✓${RESET} ${msg}`)
const warn = (msg: string) => console.log(`  ${YELLOW}⚠${RESET} ${msg}`)
const fail = (msg: string) => console.log(`  ${RED}✗${RESET} ${msg}`)

console.log(`\n${BOLD}ClaudeClaw Status${RESET}\n`)

// Node version
const nodeVersion = process.versions.node
const major = parseInt(nodeVersion.split('.')[0], 10)
if (major >= 20) {
  ok(`Node.js ${nodeVersion}`)
} else {
  fail(`Node.js ${nodeVersion} (need 20+)`)
}

// Claude CLI
try {
  const ver = execSync('claude --version 2>&1', { encoding: 'utf-8' }).trim()
  ok(`Claude CLI: ${ver}`)
} catch {
  fail('Claude CLI not found')
}

// .env exists
const envPath = resolve(PROJECT_ROOT, '.env')
if (existsSync(envPath)) {
  ok('.env file exists')

  const envContent = readFileSync(envPath, 'utf-8')
  const getValue = (key: string): string => {
    const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'))
    return match?.[1]?.trim() ?? ''
  }

  // Bot token
  const token = getValue('TELEGRAM_BOT_TOKEN')
  if (token) {
    ok(`Telegram bot token: ${DIM}${token.slice(0, 10)}...${RESET}`)
  } else {
    fail('TELEGRAM_BOT_TOKEN not set')
  }

  // Chat ID
  const chatId = getValue('ALLOWED_CHAT_ID')
  if (chatId) {
    ok(`Chat ID: ${chatId}`)
  } else {
    warn('ALLOWED_CHAT_ID not set (bot accepts all users)')
  }

  // Groq
  const groq = getValue('GROQ_API_KEY')
  if (groq) {
    ok('Voice STT (Groq): configured')
  } else {
    warn('Voice STT (Groq): not configured')
  }

  // Google
  const google = getValue('GOOGLE_API_KEY')
  if (google) {
    ok('Video analysis (Gemini): configured')
  } else {
    warn('Video analysis (Gemini): not configured')
  }
} else {
  fail('.env not found. Run: npm run setup')
}

// Database
const dbPath = resolve(PROJECT_ROOT, 'store', 'claudeclaw.db')
if (existsSync(dbPath)) {
  ok('Database exists')

  // Try to get memory count
  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath, { readonly: true })
    const memCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c
    const taskCount = (db.prepare('SELECT COUNT(*) as c FROM scheduled_tasks').get() as { c: number }).c
    ok(`Memories: ${memCount}`)
    ok(`Scheduled tasks: ${taskCount}`)
    db.close()
  } catch {
    warn('Could not read database stats')
  }
} else {
  warn('Database not created yet (starts on first run)')
}

// Service status
const os = platform()
if (os === 'darwin') {
  try {
    const result = execSync('launchctl list com.claudeclaw.app 2>&1', { encoding: 'utf-8' })
    if (result.includes('PID')) {
      ok('macOS service: running')
    } else {
      warn('macOS service: installed but not running')
    }
  } catch {
    warn('macOS service: not installed')
  }
} else if (os === 'linux') {
  try {
    const result = execSync('systemctl --user is-active claudeclaw 2>&1', { encoding: 'utf-8' }).trim()
    if (result === 'active') {
      ok('systemd service: running')
    } else {
      warn(`systemd service: ${result}`)
    }
  } catch {
    warn('systemd service: not installed')
  }
}

// PID file
const pidPath = resolve(PROJECT_ROOT, 'store', 'claudeclaw.pid')
if (existsSync(pidPath)) {
  const pid = readFileSync(pidPath, 'utf-8').trim()
  try {
    process.kill(parseInt(pid, 10), 0)
    ok(`Process running (PID ${pid})`)
  } catch {
    warn(`Stale PID file (PID ${pid} not running)`)
  }
} else {
  warn('No PID file (bot not running)')
}

console.log('')
