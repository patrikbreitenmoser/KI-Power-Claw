import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { STORE_DIR, TELEGRAM_BOT_TOKEN } from './config.js'
import { initDatabase } from './db.js'
import { runDecaySweep } from './memory.js'
import { cleanupOldUploads } from './media.js'
import { createBot, createSendFn, BOT_COMMANDS } from './bot.js'
import { initScheduler, stopScheduler } from './scheduler.js'
import { initSubagentSystem } from './subagent.js'
import { loadPersona } from './persona.js'
import { logger } from './logger.js'

const PID_FILE = resolve(STORE_DIR, 'kipowerclaw.pid')
const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

const PINK = '\x1b[38;2;255;64;129m'
const RESET = '\x1b[0m'
const BANNER = `${PINK}
██╗  ██╗██╗    ██████╗  ██████╗ ██╗    ██╗███████╗██████╗
██║ ██╔╝██║    ██╔══██╗██╔═══██╗██║    ██║██╔════╝██╔══██╗
█████╔╝ ██║    ██████╔╝██║   ██║██║ █╗ ██║█████╗  ██████╔╝
██╔═██╗ ██║    ██╔═══╝ ██║   ██║██║███╗██║██╔══╝  ██╔══██╗
██║  ██╗██║    ██║     ╚██████╔╝╚███╔███╔╝███████╗██║  ██║
╚═╝  ╚═╝╚═╝    ╚═╝      ╚═════╝  ╚══╝╚══╝ ╚══════╝╚═╝  ╚═╝
 ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██║     ██╔══██╗██║    ██║
██║     ██║     ███████║██║ █╗ ██║
██║     ██║     ██╔══██║██║███╗██║
╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
${RESET}`

function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true })

  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (oldPid && !isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0) // Check if alive
        logger.warn({ oldPid }, 'Killing stale KI Power Claw process')
        process.kill(oldPid, 'SIGTERM')
      } catch {
        // Process not running, stale PID file
      }
    }
  }

  writeFileSync(PID_FILE, String(process.pid))
  logger.debug({ pid: process.pid }, 'PID lock acquired')
}

function releaseLock(): void {
  try {
    unlinkSync(PID_FILE)
  } catch {
    // Already cleaned up
  }
}

async function main(): Promise<void> {
  // 1. Banner
  console.log(BANNER)

  // 2. Check required config
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('\n  TELEGRAM_BOT_TOKEN is not set.')
    console.error('  Run `npm run setup` to configure, or add it to .env\n')
    process.exit(1)
  }

  // 3. Acquire PID lock
  acquireLock()

  // 4. Initialize database
  initDatabase()

  // 4.5. Load persona files (SOUL.md, USER.md, IDENTITY.md)
  loadPersona()

  // 5. Run initial memory decay sweep + schedule daily
  runDecaySweep()
  const decayTimer = setInterval(runDecaySweep, DECAY_INTERVAL_MS)

  // 6. Clean up old uploads
  cleanupOldUploads()

  // 7. Create bot
  const bot = createBot()

  // 7.5. Register commands with Telegram menu
  await bot.api.setMyCommands(BOT_COMMANDS)

  // 8. Initialize scheduler + subagent system
  const sendFn = createSendFn(bot)
  initScheduler(sendFn)
  initSubagentSystem(sendFn)

  // 9. Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...')
    stopScheduler()
    clearInterval(decayTimer)
    bot.stop()
    releaseLock()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // 10. Start bot
  try {
    logger.info('Starting Telegram bot...')
    await bot.start()
  } catch (err) {
    logger.fatal({ err }, 'Failed to start bot')
    releaseLock()
    process.exit(1)
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Unhandled error in main')
  releaseLock()
  process.exit(1)
})
