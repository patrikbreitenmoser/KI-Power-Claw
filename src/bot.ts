import { Bot, Context, InputFile } from 'grammy'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_USER_IDS,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
  DEFAULT_MODEL,
  MEMORY_DIR,
  PROJECT_ROOT,
} from './config.js'
import { getSession, setSession, clearSession } from './db.js'
import { runAgent } from './agent.js'
import { upsertEnvValue } from './env.js'
import { queryMemory, appendToDailyLog } from './memory.js'
import { consolidateDailyLogs } from './consolidation.js'
import { getPersonaContext } from './persona.js'
import { transcribeAudio, voiceCapabilities } from './voice.js'
import { downloadMedia, buildPhotoMessage, buildDocumentMessage, buildVideoMessage } from './media.js'
import {
  spawnSubagent,
  cancelSubagent,
  listRunning,
  listRecent,
  getSubagentInfo,
  runningCount,
  detectBackgroundIntent,
  parseSubagentBlocks,
} from './subagent.js'
import { logger } from './logger.js'

export const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'start', description: 'Show welcome message' },
  { command: 'chatid', description: 'Show your chat ID' },
  { command: 'newchat', description: 'Start a fresh session' },
  { command: 'forget', description: 'Clear session (alias for /newchat)' },
  { command: 'memory', description: 'Show recent memories' },
  { command: 'consolidate', description: 'Run memory consolidation now' },
  { command: 'model', description: 'Switch Claude model' },
  { command: 'schedule', description: 'Manage scheduled tasks' },
  { command: 'agents', description: 'List background agents' },
]

// Per-chat model overrides
const modelOverrides = new Map<string, string>()

const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
}

function resolveModel(chatId: string): string {
  return modelOverrides.get(chatId) ?? DEFAULT_MODEL
}

// --- Formatting ---

/**
 * Convert Markdown to Telegram-compatible HTML.
 * Telegram only supports: <b>, <i>, <code>, <pre>, <s>, <a>, <u>
 */
export function formatForTelegram(text: string): string {
  // Extract code blocks and protect them
  const codeBlocks: string[] = []
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length
    const escaped = escapeHtml(code.trimEnd())
    codeBlocks.push(lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`)
    return `\x00CB${idx}\x00`
  })

  // Extract inline code and protect it
  const inlineCodes: string[] = []
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00IC${idx}\x00`
  })

  // Escape HTML in remaining text
  result = escapeHtml(result)

  // Headings -> bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')

  // Italic: *text* or _text_
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>')

  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Links
  result = result.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')

  // Checkboxes
  result = result.replace(/- \[ \]/g, '☐')
  result = result.replace(/- \[x\]/g, '☑')

  // Strip horizontal rules
  result = result.replace(/^-{3,}$/gm, '')
  result = result.replace(/^\*{3,}$/gm, '')

  // Restore code blocks and inline code
  result = result.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)])
  result = result.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCodes[parseInt(idx)])

  return result.trim()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Split a long message into chunks at newline boundaries.
 */
export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    // Find last newline before limit
    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt <= 0) {
      // No newline found, split at last space
      splitAt = remaining.lastIndexOf(' ', limit)
    }
    if (splitAt <= 0) {
      // No space found, hard split
      splitAt = limit
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

// --- Auth ---

async function ensureAccess(ctx: Context): Promise<string | null> {
  if (!ctx.chat || ctx.from?.id == null || ctx.from.is_bot) return null

  const chatId = String(ctx.chat.id)
  const userId = String(ctx.from.id)

  if (ALLOWED_USER_IDS.has(userId)) {
    return chatId
  }

  if (ALLOWED_USER_IDS.size > 0) {
    logger.warn({ chatId, userId }, 'Rejected unauthorised Telegram user')
    return null
  }

  if (ctx.chat.type !== 'private') {
    logger.warn({ chatId, userId }, 'Ignoring bootstrap attempt outside private chat')
    return null
  }

  try {
    await upsertEnvValue('ALLOWED_USER_IDS', userId)
    ALLOWED_USER_IDS.clear()
    ALLOWED_USER_IDS.add(userId)
    logger.info({ chatId, userId }, 'Registered first private user as bot owner')
    await ctx.reply(
      `Registered you as the owner.\n` +
        `Your Telegram user ID is ${userId}.\n` +
        `Future access is now limited to you.`
    )
    return chatId
  } catch (err) {
    logger.error({ err, chatId, userId }, 'Failed to persist bot owner to .env')
    await ctx.reply('Failed to save your owner ID to .env. Fix the file permissions and try again.')
    return null
  }
}

// --- Telegram response delivery ---

interface TelegramApi {
  sendMessage: (
    chatId: number | string,
    text: string,
    other?: Record<string, unknown>
  ) => Promise<unknown>
  sendPhoto: (chatId: number | string, photo: InputFile) => Promise<unknown>
  sendDocument: (chatId: number | string, document: InputFile) => Promise<unknown>
}

interface ExtractedMedia {
  mediaPaths: string[]
  text: string
}

function extractMedia(text: string): ExtractedMedia {
  const mediaRegex = /^\s*MEDIA:\s*(.+)$/gim
  const mediaPaths: string[] = []
  let match: RegExpExecArray | null

  while ((match = mediaRegex.exec(text)) !== null) {
    const normalized = normalizeMediaPath(match[1])
    if (normalized) mediaPaths.push(normalized)
  }

  const textWithoutMedia = text.replace(/^\s*MEDIA:\s*.+$/gim, '').trim()
  return { mediaPaths, text: textWithoutMedia }
}

function normalizeMediaPath(rawPath: string): string | null {
  let value = rawPath.trim()
  if (!value) return null

  const wrappedBy = value[0]
  if (
    (wrappedBy === '"' || wrappedBy === '\'' || wrappedBy === '`') &&
    value[value.length - 1] === wrappedBy
  ) {
    value = value.slice(1, -1).trim()
  }

  if (!value) return null

  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value)
}

async function sendTelegramText(
  api: TelegramApi,
  chatId: number | string,
  text: string
): Promise<void> {
  if (!text) return

  const formatted = formatForTelegram(text)
  const chunks = splitMessage(formatted)

  for (const chunk of chunks) {
    try {
      await api.sendMessage(chatId, chunk, { parse_mode: 'HTML' })
    } catch {
      await api.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ''))
    }
  }
}

async function sendTelegramMedia(
  api: TelegramApi,
  chatId: number | string,
  mediaPath: string
): Promise<boolean> {
  if (!existsSync(mediaPath)) {
    logger.warn({ mediaPath }, 'Generated media file does not exist')
    return false
  }

  try {
    await api.sendPhoto(chatId, new InputFile(mediaPath))
    return true
  } catch (photoErr) {
    logger.warn({ err: photoErr, mediaPath }, 'Failed to send media as photo, retrying as document')
  }

  try {
    await api.sendDocument(chatId, new InputFile(mediaPath))
    return true
  } catch (documentErr) {
    logger.error({ err: documentErr, mediaPath }, 'Failed to send media file')
    return false
  }
}

async function sendTelegramResponse(
  api: TelegramApi,
  chatId: number | string,
  text: string
): Promise<void> {
  const { mediaPaths, text: textWithoutMedia } = extractMedia(text)

  const failedMediaPaths: string[] = []
  for (const mediaPath of mediaPaths) {
    const sent = await sendTelegramMedia(api, chatId, mediaPath)
    if (!sent) failedMediaPaths.push(mediaPath)
  }

  let finalText = textWithoutMedia
  if (failedMediaPaths.length > 0) {
    const suffix = failedMediaPaths.length === 1 ? '' : 's'
    const failureNotice =
      `Could not send generated media file${suffix}:\n` + failedMediaPaths.join('\n')
    finalText = finalText ? `${finalText}\n\n${failureNotice}` : failureNotice
  }

  await sendTelegramText(api, chatId, finalText)
}

// --- Message handler ---

async function handleMessage(
  ctx: Context,
  rawText: string
): Promise<void> {
  const chatId = await ensureAccess(ctx)
  if (!chatId || !ctx.chat) return

  // Check if user wants this to run in the background
  if (detectBackgroundIntent(rawText)) {
    const model = resolveModel(chatId)
    const id = spawnSubagent(chatId, rawText.slice(0, 80), rawText, model)
    const running = runningCount(chatId)
    await ctx.reply(
      `Got it, working on this in the background (agent ${id}).\n` +
        `${running} background agent${running === 1 ? '' : 's'} running.\n` +
        `Use /agents to check status.`
    )
    return
  }

  // Get existing session (determines whether to inject persona)
  const sessionId = getSession(chatId) ?? undefined

  // Start typing immediately (before async memory query)
  ctx.api.sendChatAction(ctx.chat!.id, 'typing').catch(() => {})
  const memoryPrefix = await queryMemory(rawText)
  const fullMessage = (memoryPrefix ? memoryPrefix : '') + rawText

  // Inject persona as system prompt only when starting a fresh session
  const personaContext = sessionId ? undefined : getPersonaContext()

  // Start typing indicator refresh
  const refreshTyping = () => {
    ctx.api.sendChatAction(ctx.chat!.id, 'typing').catch(() => {})
  }

  try {
    const model = resolveModel(chatId)
    let { text, newSessionId } = await runAgent(
      fullMessage,
      sessionId,
      refreshTyping,
      model,
      undefined,
      { source: 'message', chatId },
      personaContext
    )

    // If we tried to resume but got no session back, the session is stale — clear and retry fresh
    if (sessionId && !newSessionId) {
      clearSession(chatId)
      const retried = await runAgent(
        fullMessage,
        undefined,
        refreshTyping,
        model,
        undefined,
        { source: 'message', chatId },
        getPersonaContext()
      )
      text = retried.text
      newSessionId = retried.newSessionId
    }

    // Persist session
    if (newSessionId) {
      setSession(chatId, newSessionId)
    }

    if (!text) {
      await ctx.reply('(no response from Claude)')
      return
    }

    // Save to daily log (fire-and-forget)
    appendToDailyLog(rawText, text).catch(err => logger.warn({ err }, 'Failed to save daily log'))

    // Parse and spawn any SUBAGENT blocks the agent requested
    const { cleaned: textAfterSubagents, subagents } = parseSubagentBlocks(text)
    for (const sub of subagents) {
      const subModel = resolveModel(chatId)
      const id = spawnSubagent(chatId, sub.description, sub.prompt, subModel)
      await ctx.reply(`Spawned background agent (${id}): ${sub.description}`)
    }

    await sendTelegramResponse(ctx.api as TelegramApi, ctx.chat.id, textAfterSubagents)
  } catch (err) {
    logger.error({ err, chatId }, 'handleMessage failed')
    await ctx.reply('Something went wrong. Check the logs.')
  }
}

// --- Bot creation ---

export function createBot(): Bot {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN not set. Run `npm run setup` or add it to .env'
    )
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN)

  // /start
  bot.command('start', async (ctx) => {
    if (!(await ensureAccess(ctx))) return
    const commandList = BOT_COMMANDS
      .filter(c => c.command !== 'start')
      .map(c => `/${c.command} - ${c.description}`)
      .join('\n')
    await ctx.reply(
      'KI Power Claw is online. Send me a message and I\'ll route it to Claude Code on your machine.\n\n' +
        'Commands:\n' + commandList
    )
  })

  // /chatid
  bot.command('chatid', async (ctx) => {
    if (!(await ensureAccess(ctx))) return
    const userId = ctx.from?.id
    if (userId == null) return
    await ctx.reply(
      `Your Telegram user ID: ${userId}\n` +
        `Current chat ID: ${ctx.chat.id}`
    )
  })

  // /newchat
  bot.command('newchat', async (ctx) => {
    const chatId = await ensureAccess(ctx)
    if (!chatId) return
    clearSession(chatId)
    await ctx.reply('Session cleared. Next message starts a fresh conversation.')
  })

  // /forget (alias)
  bot.command('forget', async (ctx) => {
    const chatId = await ensureAccess(ctx)
    if (!chatId) return
    clearSession(chatId)
    await ctx.reply('Session cleared.')
  })

  // /memory
  bot.command('memory', async (ctx) => {
    if (!(await ensureAccess(ctx))) return

    // Count daily log files
    let dailyLogCount = 0
    const dailyLogPattern = /^\d{4}-\d{2}-\d{2}\.md$/
    try {
      const files = await readdir(MEMORY_DIR)
      dailyLogCount = files.filter(f => dailyLogPattern.test(f)).length
    } catch { /* directory may not exist yet */ }

    // Count long-term facts in MEMORY.md
    let factCount = 0
    let recentToday = ''
    try {
      const memoryMd = await readFile(resolve(MEMORY_DIR, 'MEMORY.md'), 'utf-8')
      factCount = memoryMd.split('\n').filter(l => l.startsWith('- ')).length
    } catch { /* file may not exist yet */ }

    // Read today's log for recent entries
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Zurich' })
    try {
      const todayLog = await readFile(resolve(MEMORY_DIR, `${today}.md`), 'utf-8')
      // Extract last few entries (each starts with ## HH:MM)
      const entries = todayLog.split(/^## \d/m).slice(-3)
      if (entries.length > 0) {
        recentToday = entries.map(e => {
          const lines = e.trim().split('\n')
          const userLine = lines.find(l => l.startsWith('**User**:'))
          return userLine ? userLine.slice(0, 100) : ''
        }).filter(Boolean).join('\n')
      }
    } catch { /* no log today yet */ }

    if (dailyLogCount === 0 && factCount === 0) {
      await ctx.reply('No memories stored yet.')
      return
    }

    let msg = `Memory: ${dailyLogCount} daily logs, ${factCount} long-term facts`
    if (recentToday) {
      msg += `\n\nRecent today:\n${recentToday}`
    }
    await ctx.reply(msg)
  })

  // /consolidate
  bot.command('consolidate', async (ctx) => {
    if (!(await ensureAccess(ctx))) return
    await ctx.reply('Running consolidation...')
    try {
      const { processed, facts } = await consolidateDailyLogs()
      await ctx.reply(`Consolidation done: processed ${processed} logs, extracted ${facts} facts`)
    } catch (err) {
      logger.error({ err }, 'Manual consolidation failed')
      await ctx.reply('Consolidation failed. Check logs.')
    }
  })

  // /model
  bot.command('model', async (ctx) => {
    const chatId = await ensureAccess(ctx)
    if (!chatId) return
    const arg = (ctx.message?.text ?? '').replace('/model', '').trim().toLowerCase()

    if (!arg) {
      const current = resolveModel(chatId)
      const isOverride = modelOverrides.has(chatId)
      await ctx.reply(
        `Current model: ${current}${isOverride ? ' (override)' : ' (default)'}\n\n` +
          'Usage: /model <name>\n' +
          'Shortcuts: sonnet, opus, haiku\n' +
          '/model reset - back to default'
      )
      return
    }

    if (arg === 'reset') {
      modelOverrides.delete(chatId)
      clearSession(chatId)
      await ctx.reply(`Model reset to default: ${DEFAULT_MODEL}\nSession cleared.`)
      return
    }

    const resolved = MODEL_ALIASES[arg] ?? arg
    modelOverrides.set(chatId, resolved)
    clearSession(chatId)
    await ctx.reply(`Model set to: ${resolved}\nSession cleared.`)
  })

  // /schedule
  bot.command('schedule', async (ctx) => {
    if (!(await ensureAccess(ctx))) return
    const text = ctx.message?.text ?? ''
    const parts = text.replace('/schedule', '').trim()

    if (!parts) {
      await ctx.reply(
        'Schedule commands:\n' +
          '/schedule list - Show all tasks\n' +
          '/schedule create "<prompt>" "<cron>" - Create task\n' +
          '/schedule delete <id> - Delete task\n' +
          '/schedule pause <id> - Pause task\n' +
          '/schedule resume <id> - Resume task'
      )
      return
    }

    // Delegate to Claude for natural language scheduling
    await handleMessage(ctx, `Manage my scheduled tasks: ${parts}`)
  })

  // /agents
  bot.command('agents', async (ctx) => {
    const chatId = await ensureAccess(ctx)
    if (!chatId) return
    const arg = (ctx.message?.text ?? '').replace('/agents', '').trim()

    // /agents cancel <id>
    if (arg.startsWith('cancel ')) {
      const id = arg.replace('cancel ', '').trim()
      const agent = getSubagentInfo(id)
      if (!agent || agent.chat_id !== chatId) {
        await ctx.reply(`No running agent found with ID ${id}.`)
        return
      }
      const cancelled = cancelSubagent(id)
      if (cancelled) {
        await ctx.reply(`Agent ${id} cancelled.`)
      } else {
        await ctx.reply(`No running agent found with ID ${id}.`)
      }
      return
    }

    // /agents <id> -- show detail for a specific agent
    if (arg && !arg.includes(' ')) {
      const agent = getSubagentInfo(arg)
      if (!agent || agent.chat_id !== chatId) {
        await ctx.reply(`No agent found with ID ${arg}.`)
        return
      }
      const elapsed = agent.finished_at
        ? `${agent.finished_at - agent.started_at}s`
        : `${Math.floor(Date.now() / 1000) - agent.started_at}s (running)`

      let msg = `Agent ${agent.id}\n`
      msg += `Status: ${agent.status}\n`
      msg += `Description: ${agent.description}\n`
      msg += `Duration: ${elapsed}\n`
      if (agent.result) {
        const preview = agent.result.length > 2000
          ? agent.result.slice(0, 2000) + '\n...(truncated)'
          : agent.result
        msg += `\nResult:\n${preview}`
      }
      await ctx.reply(msg)
      return
    }

    // /agents -- list recent agents
    const recent = listRecent(chatId, 10)
    if (recent.length === 0) {
      await ctx.reply('No background agents yet.')
      return
    }

    const STATUS_ICONS: Record<string, string> = {
      running: '...',
      completed: 'ok',
      failed: 'ERR',
      cancelled: 'X',
      orphaned: '!',
    }

    let msg = 'Background agents:\n\n'
    for (const a of recent) {
      const icon = STATUS_ICONS[a.status] ?? a.status
      const desc = a.description.slice(0, 60)
      msg += `[${icon}] ${a.id} - ${desc}\n`
    }
    msg += '\nUse /agents <id> for details, /agents cancel <id> to cancel.'
    await ctx.reply(msg)
  })

  // Text messages
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    if (text.startsWith('/')) return // Skip unhandled commands
    await handleMessage(ctx, text)
  })

  // Voice notes
  bot.on('message:voice', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!(await ensureAccess(ctx))) return

    const { stt } = voiceCapabilities()
    if (!stt) {
      await ctx.reply('Voice transcription not configured. Set GROQ_API_KEY in .env')
      return
    }

    try {
      await ctx.api.sendChatAction(ctx.chat.id, 'typing')

      const file = await ctx.getFile()
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, file.file_id, 'voice.oga')

      const transcript = await transcribeAudio(localPath)
      logger.info({ chatId, transcript: transcript.slice(0, 100) }, 'Voice transcribed')

      await handleMessage(ctx, `[Voice transcribed]: ${transcript}`)
    } catch (err) {
      logger.error({ err }, 'Voice handling failed')
      await ctx.reply('Failed to transcribe voice note.')
    }
  })

  // Photos
  bot.on('message:photo', async (ctx) => {
    if (!(await ensureAccess(ctx))) return

    try {
      await ctx.api.sendChatAction(ctx.chat.id, 'typing')
      // Get highest resolution photo
      const photos = ctx.message.photo
      const largest = photos[photos.length - 1]
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, largest.file_id, 'photo.jpg')
      const msg = buildPhotoMessage(localPath, ctx.message.caption)
      await handleMessage(ctx, msg)
    } catch (err) {
      logger.error({ err }, 'Photo handling failed')
      await ctx.reply('Failed to process photo.')
    }
  })

  // Documents
  bot.on('message:document', async (ctx) => {
    if (!(await ensureAccess(ctx))) return
    const doc = ctx.message.document
    if (!doc) return

    try {
      await ctx.api.sendChatAction(ctx.chat.id, 'typing')
      const localPath = await downloadMedia(
        TELEGRAM_BOT_TOKEN,
        doc.file_id,
        doc.file_name ?? 'document'
      )
      const msg = buildDocumentMessage(localPath, doc.file_name ?? 'document', ctx.message.caption)
      await handleMessage(ctx, msg)
    } catch (err) {
      logger.error({ err }, 'Document handling failed')
      await ctx.reply('Failed to process document.')
    }
  })

  // Videos
  bot.on('message:video', async (ctx) => {
    if (!(await ensureAccess(ctx))) return
    const video = ctx.message.video
    if (!video) return

    try {
      await ctx.api.sendChatAction(ctx.chat.id, 'typing')
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, video.file_id, 'video.mp4')
      const msg = buildVideoMessage(localPath, ctx.message.caption)
      await handleMessage(ctx, msg)
    } catch (err) {
      logger.error({ err }, 'Video handling failed')
      await ctx.reply('Failed to process video.')
    }
  })

  // Error handler
  bot.catch((err) => {
    logger.error({ err: err.error }, 'Bot error')
  })

  return bot
}

/**
 * Create a send function for the scheduler to use.
 */
export function createSendFn(bot: Bot): (chatId: string, text: string) => Promise<void> {
  return async (chatId: string, text: string) => {
    await sendTelegramResponse(bot.api as TelegramApi, Number(chatId), text)
  }
}
