import { createInterface } from 'node:readline'
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
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(`  ${q}: `, resolve))

const BANNER = `
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝
 ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██║     ██╔══██╗██║    ██║
██║     ██║     ███████║██║ █╗ ██║
██║     ██║     ██╔══██║██║███╗██║
╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝  setup wizard
`

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

  console.log('')
  const groqKey = await ask('Groq API key for voice transcription (or press Enter to skip)')
  const googleKey = await ask('Google API key for video analysis (or press Enter to skip)')

  // Write .env
  heading('Writing .env')
  const envLines = [
    `TELEGRAM_BOT_TOKEN=${botToken}`,
    `ALLOWED_USER_IDS=`,
    `GROQ_API_KEY=${groqKey}`,
    `GOOGLE_API_KEY=${googleKey}`,
    `LOG_LEVEL=info`,
  ]
  writeFileSync(resolve(PROJECT_ROOT, '.env'), envLines.join('\n') + '\n')
  ok('.env written')

  // Open CLAUDE.md for personalization
  heading('Personalizing CLAUDE.md')
  const editor = process.env.EDITOR ?? 'nano'
  console.log(`  Opening CLAUDE.md in ${editor}...`)
  console.log(`  ${DIM}Fill in [YOUR NAME], [YOUR ASSISTANT NAME], and your context.${RESET}`)
  console.log(`  ${DIM}Save and close when done.${RESET}\n`)

  try {
    spawnSync(editor, [resolve(PROJECT_ROOT, 'CLAUDE.md')], { stdio: 'inherit' })
    ok('CLAUDE.md personalized')
  } catch {
    warn(`Could not open editor. Edit CLAUDE.md manually at:\n    ${resolve(PROJECT_ROOT, 'CLAUDE.md')}`)
  }

  // Get chat ID
  heading('Getting your chat ID')
  console.log('  I\'ll start the bot temporarily. Send /chatid to your bot in Telegram.')
  console.log(`  ${DIM}Press Enter when ready...${RESET}`)
  await ask('Press Enter to start bot')

  console.log('  Starting bot... Send /chatid to your bot now.\n')

  // Start bot in background, watch for chat ID
  const chatIdPromise = new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve(''), 120_000) // 2 min timeout

    const checkInterval = setInterval(() => {
      // Read .env to check if ALLOWED_CHAT_ID was manually set
      try {
        const envContent = readFileSync(resolve(PROJECT_ROOT, '.env'), 'utf-8')
        const match = envContent.match(/ALLOWED_USER_IDS=(\d+)/)
        if (match && match[1]) {
          clearInterval(checkInterval)
          clearTimeout(timer)
          resolve(match[1])
        }
      } catch { /* ignore */ }
    }, 2000)
  })

  console.log(`  ${DIM}Alternatively, paste your chat ID here:${RESET}`)
  const manualChatId = await ask('Chat ID (or wait for /chatid)')

  let chatId = manualChatId.trim()
  if (!chatId) {
    chatId = await chatIdPromise
  }

  if (chatId) {
    // Update .env with chat ID
    const envContent = readFileSync(resolve(PROJECT_ROOT, '.env'), 'utf-8')
    writeFileSync(
      resolve(PROJECT_ROOT, '.env'),
      envContent.replace('ALLOWED_USER_IDS=', `ALLOWED_USER_IDS=${chatId}`)
    )
    ok(`Chat ID set: ${chatId}`)
  } else {
    warn('No chat ID captured. You can set ALLOWED_CHAT_ID in .env manually, or send /chatid to your bot after starting it.')
  }

  // Install background service
  heading('Background service')
  const os = platform()

  if (os === 'darwin') {
    const shouldInstall = await ask('Install as macOS launch agent? (y/n)')
    if (shouldInstall.toLowerCase() === 'y') {
      installLaunchd()
    } else {
      warn('Skipped service installation. Run with `npm start` manually.')
    }
  } else if (os === 'linux') {
    const shouldInstall = await ask('Install as systemd user service? (y/n)')
    if (shouldInstall.toLowerCase() === 'y') {
      installSystemd()
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
  heading('Setup complete!')
  console.log('  Next steps:')
  console.log(`  ${GREEN}1.${RESET} Run: npm start`)
  console.log(`  ${GREEN}2.${RESET} Open Telegram and message your bot`)
  console.log(`  ${GREEN}3.${RESET} Try: "What can you do?"`)
  console.log('')
  console.log(`  ${DIM}Logs: /tmp/kipowerclaw.log (if service installed)${RESET}`)
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
