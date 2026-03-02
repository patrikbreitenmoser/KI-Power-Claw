import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { execSync, spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ANSI colors
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const ok = (msg: string) => console.log(`  ${GREEN}✓${RESET} ${msg}`)
const warn = (msg: string) => console.log(`  ${YELLOW}⚠${RESET} ${msg}`)
const fail = (msg: string) => console.log(`  ${RED}✗${RESET} ${msg}`)
const heading = (msg: string) => console.log(`\n${BOLD}${msg}${RESET}\n`)

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string, opts?: { signal?: AbortSignal }): Promise<string> =>
  new Promise((resolve) => {
    if (opts?.signal) {
      rl.question(`  ${q}: `, { signal: opts.signal }, (answer) => resolve(answer))
      opts.signal.addEventListener('abort', () => resolve(''), { once: true })
    } else {
      rl.question(`  ${q}: `, resolve)
    }
  })

const PINK = '\x1b[38;2;255;64;129m'
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

async function main() {
  console.log(BANNER)
  heading('Checking requirements')

  // Check Node version
  const nodeVersion = process.versions.node
  const major = parseInt(nodeVersion.split('.')[0], 10)
  if (major >= 20) {
    ok(`Node.js ${nodeVersion}`)
  } else {
    fail(`Node.js ${nodeVersion} -- need 20+`)
    process.exit(1)
  }

  // Check Claude CLI
  try {
    const claudeVersion = execSync('claude --version 2>&1', { encoding: 'utf-8' }).trim()
    ok(`Claude CLI: ${claudeVersion}`)
  } catch {
    fail('Claude CLI not found. Install it and run `claude login` first.')
    process.exit(1)
  }

  // Check QMD
  try {
    execSync('qmd --version 2>&1', { encoding: 'utf-8' })
    ok('QMD CLI')
  } catch {
    fail('QMD CLI not found. Install it from https://github.com/tobi/qmd')
    process.exit(1)
  }

  // Build the project
  heading('Building project')
  const buildResult = spawnSync('npm', ['run', 'build'], {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    encoding: 'utf-8',
  })
  if (buildResult.status === 0) {
    ok('TypeScript compiled successfully')
  } else {
    fail('Build failed:')
    console.log(buildResult.stderr || buildResult.stdout)
    process.exit(1)
  }

  // Collect configuration
  heading('Configuration')

  console.log('  You\'ll need a Telegram bot token from @BotFather.')
  console.log(`  ${DIM}Open Telegram, search for @BotFather, send /newbot, follow the prompts.${RESET}\n`)

  const botToken = await ask('Telegram bot token')
  if (!botToken) {
    fail('Bot token is required')
    process.exit(1)
  }

  // Validate token format (digits:alphanumeric)
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken.trim())) {
    fail('That doesn\'t look like a valid bot token. Expected format: 123456:ABC-DEF...')
    process.exit(1)
  }

  console.log('')
  const groqKey = await ask('Groq API key for voice transcription (or press Enter to skip)')
  const googleKey = await ask('Google API key for video analysis (or press Enter to skip)')

  // Write .env
  heading('Writing .env')
  const envLines = [
    `TELEGRAM_BOT_TOKEN=${botToken}`,
    `ALLOWED_USER_IDS=`,
    `GROQ_API_KEY=${groqKey}`,
    `GEMINI_API_KEY=${googleKey}`,
    `GOOGLE_API_KEY=${googleKey}`,
    `LOG_LEVEL=info`,
  ]
  writeFileSync(resolve(PROJECT_ROOT, '.env'), envLines.join('\n') + '\n')
  ok('.env written')

  // Personalize bot identity and user info
  heading('Personalizing your bot')
  console.log(`  ${DIM}Press Enter to keep the default value.${RESET}\n`)

  const userName = (await ask('Your name (or press Enter to skip)')).trim()
  const userTimezone = (await ask('Your timezone, e.g. Europe/Zurich (Enter = Europe/Zurich)')).trim() || 'Europe/Zurich'
  const botName = (await ask('Name for your bot (Enter = Assistant)')).trim() || 'Assistant'
  const botEmoji = (await ask('Emoji for your bot (Enter = 🤖)')).trim() || '🤖'

  // Write USER.md
  const userMd = `# USER.md - About Your Human

Learn about the person you're helping. Update this as you go.

- Name: ${userName}
- What to call them: ${userName}
- Pronouns:
- Timezone: ${userTimezone}
- Notes:

## Context

<!-- What do they care about? What projects are they working on? -->
<!-- What annoys them? What makes them laugh? -->
<!-- Build this over time. -->

The more you know, the better you can help. But remember -- you're learning about a person, not building a dossier. Respect the difference.
`
  writeFileSync(resolve(PROJECT_ROOT, 'USER.md'), userMd)
  ok('USER.md written')

  // Write IDENTITY.md
  const identityMd = `# IDENTITY.md - Who Am I?

- Name: ${botName}
- Creature: AI assistant
- Vibe:
- Emoji: ${botEmoji}
- Avatar:

This isn't just metadata. It's the start of figuring out who you are.
`
  writeFileSync(resolve(PROJECT_ROOT, 'IDENTITY.md'), identityMd)
  ok('IDENTITY.md written')

  // Get chat ID by polling Telegram API directly (avoids conflicts with running bot instances)
  heading('Getting your chat ID')

  let chatId = ''

  const trimmedToken = botToken.trim()
  const apiBase = `https://api.telegram.org/bot${trimmedToken}`

  // Validate token and get bot info
  let botUsername = ''
  try {
    const meResp = await fetch(`${apiBase}/getMe`)
    const meData = await meResp.json() as any
    if (!meData.ok) throw new Error(meData.description || 'Invalid token')
    botUsername = meData.result.username
    ok(`Bot connected: @${botUsername}`)
  } catch (err: any) {
    fail(`Invalid bot token: ${err.message ?? err}`)
    console.log(`  ${DIM}Double-check the token from @BotFather and run setup again.${RESET}`)
    process.exit(1)
  }

  // Delete any existing webhook so polling works
  await fetch(`${apiBase}/deleteWebhook`)

  console.log(`  Open Telegram, search for @${botUsername}, and send any message (e.g. "hi").`)
  console.log(`  ${DIM}If you already know your chat ID, paste it below instead.${RESET}\n`)

  // Poll for a message using short getUpdates calls (no long-polling conflict)
  const pollForChatId = async (): Promise<string> => {
    const deadline = Date.now() + 120_000 // 2 min timeout
    let offset = -1
    // Clear any old updates first
    try {
      const clear = await fetch(`${apiBase}/getUpdates?offset=-1&timeout=0`)
      const clearData = await clear.json() as any
      if (clearData.ok && clearData.result.length > 0) {
        offset = clearData.result[clearData.result.length - 1].update_id + 1
      }
    } catch { /* best effort */ }

    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`${apiBase}/getUpdates?offset=${offset}&timeout=5&limit=1`)
        const data = await resp.json() as any
        if (data.ok && data.result.length > 0) {
          const update = data.result[0]
          const msg = update.message || update.edited_message
          if (msg?.chat?.id) {
            const id = String(msg.chat.id)
            // Send confirmation (best effort)
            try {
              await fetch(`${apiBase}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: id, text: `Got it! Your chat ID is ${id}. Finishing setup...` }),
              })
            } catch { /* best effort */ }
            return id
          }
          offset = update.update_id + 1
        }
      } catch {
        // Network error, wait and retry
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    return ''
  }

  console.log('  Waiting for a message from you in Telegram...\n')

  const askAc = new AbortController()
  const manualChatId = await Promise.race([
    ask('Chat ID (or just message the bot)', { signal: askAc.signal }).then(v => v.trim()),
    pollForChatId().then(id => { askAc.abort(); return id }),
  ])

  // If the manual input resolved first, use it; otherwise use polled ID
  if (manualChatId && /^\d+$/.test(manualChatId)) {
    chatId = manualChatId
  } else {
    chatId = manualChatId || ''
  }

  if (chatId) {
    const envContent = readFileSync(resolve(PROJECT_ROOT, '.env'), 'utf-8')
    writeFileSync(
      resolve(PROJECT_ROOT, '.env'),
      envContent.replace('ALLOWED_USER_IDS=', `ALLOWED_USER_IDS=${chatId}`)
    )
    ok(`Chat ID set: ${chatId}`)
  } else {
    warn('No chat ID captured. Set ALLOWED_USER_IDS in .env manually, or leave it empty -- the bot will accept anyone until you set it.')
  }

  // Set up QMD for memory search
  heading('Memory search (QMD)')
  const memoryDir = resolve(PROJECT_ROOT, 'memory')

  // Initialize MEMORY.md if it doesn't exist
  const memoryMdPath = resolve(memoryDir, 'MEMORY.md')
  if (!existsSync(memoryMdPath)) {
    const memoryMd = `# Long-Term Memory

Last consolidated: never

## About ${userName || '[User]'}
(Personal information, interests, background)

## Preferences
(Communication style, tools, workflows)

## Projects
(Active projects and their locations)

## Important Dates
(Birthdays, deadlines, recurring events)

## Active Threads
(What you're currently working on -- update as projects progress)

## Misc
(Anything else worth remembering)
`
    writeFileSync(memoryMdPath, memoryMd)
    ok('memory/MEMORY.md created')
  } else {
    ok('memory/MEMORY.md already exists')
  }

  try {
    const qmdSuffix = createHash('md5').update(PROJECT_ROOT).digest('hex').slice(0, 6)
    execSync(`qmd collection add "${memoryDir}" --name bot-memory-${qmdSuffix} --mask "**/*.md" 2>&1`, { encoding: 'utf-8' })
    ok('QMD collection created')
  } catch {
    ok('QMD collection already exists')
  }

  try {
    execSync('qmd update 2>&1', { encoding: 'utf-8', timeout: 30_000 })
    execSync('qmd embed 2>&1', { encoding: 'utf-8', timeout: 120_000 })
    ok('QMD index built')
  } catch (err: any) {
    warn(`QMD indexing failed: ${err.message ?? err}`)
  }

  // Install background service
  heading('Background service')
  const os = platform()
  let serviceInstalled = false

  if (os === 'darwin') {
    const shouldInstall = await ask('Install as macOS launch agent? (y/n)')
    if (shouldInstall.toLowerCase() === 'y') {
      installLaunchd()
      serviceInstalled = true
    } else {
      warn('Skipped service installation. Run with `npm start` manually.')
    }
  } else if (os === 'linux') {
    const shouldInstall = await ask('Install as systemd user service? (y/n)')
    if (shouldInstall.toLowerCase() === 'y') {
      installSystemd()
      serviceInstalled = true
    } else {
      warn('Skipped service installation. Run with `npm start` manually.')
    }
  } else {
    console.log('  For Windows, install PM2 globally:')
    console.log('    npm install -g pm2')
    console.log('    pm2 start dist/index.js --name kipowerclaw')
    console.log('    pm2 save && pm2 startup')
  }

  // Done
  const username = botUsername
  heading('Setup complete!')

  if (serviceInstalled) {
    console.log(`  Your bot is running! Open Telegram, search for @${username}, and say hi.`)
  } else {
    console.log('  Next steps:')
    console.log(`  ${GREEN}1.${RESET} Run: npm start`)
    console.log(`  ${GREEN}2.${RESET} Open Telegram, search for @${username}, and say hi`)
  }

  console.log('')
  console.log(`  ${DIM}Status: npm run status${RESET}`)
  console.log('')

  rl.close()
}

function installLaunchd(): void {
  const label = 'com.kipowerclaw.app'
  const nodePath = execSync('which node', { encoding: 'utf-8' }).trim()
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${resolve(PROJECT_ROOT, 'dist', 'index.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/tmp/kipowerclaw.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/kipowerclaw.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
  </dict>
</dict>
</plist>`

  const plistPath = resolve(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
  writeFileSync(plistPath, plist)

  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { encoding: 'utf-8' })
  } catch { /* might not be loaded */ }

  execSync(`launchctl load "${plistPath}"`, { encoding: 'utf-8' })
  ok(`Service installed: ${plistPath}`)
  ok('Service started. It will auto-start on login.')
}

function installSystemd(): void {
  const nodePath = execSync('which node', { encoding: 'utf-8' }).trim()
  const unit = `[Unit]
Description=KI Power Claw Telegram Bot
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${resolve(PROJECT_ROOT, 'dist', 'index.js')}
WorkingDirectory=${PROJECT_ROOT}
Restart=always
RestartSec=5
Environment=PATH=${process.env.PATH}

[Install]
WantedBy=default.target
`

  const serviceDir = resolve(homedir(), '.config', 'systemd', 'user')
  execSync(`mkdir -p "${serviceDir}"`)
  const servicePath = resolve(serviceDir, 'kipowerclaw.service')
  writeFileSync(servicePath, unit)

  execSync('systemctl --user daemon-reload')
  execSync('systemctl --user enable kipowerclaw')
  execSync('systemctl --user start kipowerclaw')
  ok(`Service installed: ${servicePath}`)
  ok('Service started and enabled on login.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
