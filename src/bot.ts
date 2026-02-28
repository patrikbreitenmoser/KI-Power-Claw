import { Bot, Context, InputFile } from 'grammy'
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_ID,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
  DEFAULT_MODEL,
} from './config.js'
import { getSession, setSession, clearSession, getMemoryCount, getRecentMemoriesSummary } from './db.js'
import { runAgent } from './agent.js'
import { buildMemoryContext, saveConversationTurn } from './memory.js'
import { getPersonaContext, getBotEmoji, reloadPersona } from './persona.js'
import { transcribeAudio, voiceCapabilities } from './voice.js'
import { downloadMedia, buildPhotoMessage, buildDocumentMessage, buildVideoMessage } from './media.js'
import { logger } from './logger.js'

export const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'start', description: 'Show welcome message' },
  { command: 'chatid', description: 'Show your chat ID' },
  { command: 'newchat', description: 'Start a fresh session' },
  { command: 'forget', description: 'Clear session (alias for /newchat)' },
  { command: 'memory', description: 'Show recent memories' },
  { command: 'model', description: 'Switch Claude model' },
  { command: 'voice', description: 'Toggle voice reply mode' },
  { command: 'schedule', description: 'Manage scheduled tasks' },
]

// Track which chats have voice reply mode enabled
const voiceEnabledChats = new Set<string>()

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

function isAuthorised(chatId: number): boolean {
  if (!ALLOWED_CHAT_ID) return true // First-run mode: allow anyone until configured
  return String(chatId) === ALLOWED_CHAT_ID
}

// --- Message handler ---

async function handleMessage(
  ctx: Context,
  rawText: string,
  forceVoiceReply = false
): Promise<void> {
  const chatId = String(ctx.chat?.id)
  if (!chatId || !ctx.chat) return

  if (!isAuthorised(ctx.chat.id)) {
    await ctx.reply('Unauthorized. Your chat ID: ' + chatId)
    return
  }

  // Build persona + memory context
  const personaContext = getPersonaContext()
  const memoryPrefix = buildMemoryContext(chatId, rawText)
  const fullMessage = personaContext + (memoryPrefix ? memoryPrefix : '') + rawText

  // Get existing session
  const sessionId = getSession(chatId) ?? undefined

  // Start typing indicator refresh
  const refreshTyping = () => {
    ctx.api.sendChatAction(ctx.chat!.id, 'typing').catch(() => {})
  }

  try {
    const model = resolveModel(chatId)
    const { text, newSessionId } = await runAgent(fullMessage, sessionId, refreshTyping, model)

    // Persist session
    if (newSessionId) {
      setSession(chatId, newSessionId)
    }

    // Reload persona in case bot updated files during this turn
    reloadPersona()

    if (!text) {
      await ctx.reply('(no response from Claude)')
      return
    }

    // Save to memory
    saveConversationTurn(chatId, rawText, text)

    // Send response
    const formatted = formatForTelegram(text)
    const chunks = splitMessage(formatted)

    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: 'HTML' })
      } catch {
        // Fallback to plain text if HTML parsing fails
        await ctx.reply(chunk.replace(/<[^>]+>/g, ''))
      }
    }
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
    const commandList = BOT_COMMANDS
      .filter(c => c.command !== 'start')
      .map(c => `/${c.command} - ${c.description}`)
      .join('\n')
    await ctx.reply(
      'ClaudeClaw is online. Send me a message and I\'ll route it to Claude Code on your machine.\n\n' +
        'Commands:\n' + commandList
    )
  })

  // /chatid
  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Your chat ID: ${ctx.chat.id}`)
  })

  // /newchat
  bot.command('newchat', async (ctx) => {
    clearSession(String(ctx.chat.id))
    await ctx.reply('Session cleared. Next message starts a fresh conversation.')
  })

  // /forget (alias)
  bot.command('forget', async (ctx) => {
    clearSession(String(ctx.chat.id))
    await ctx.reply('Session cleared.')
  })

  // /memory
  bot.command('memory', async (ctx) => {
    const chatId = String(ctx.chat.id)
    const count = getMemoryCount(chatId)
    const recent = getRecentMemoriesSummary(chatId, 5)

    if (count === 0) {
      await ctx.reply('No memories stored yet.')
      return
    }

    let msg = `Memories: ${count} total\n\nRecent:\n`
    for (const m of recent) {
      const sector = m.sector === 'semantic' ? '🧠' : '💬'
      msg += `${sector} ${m.content.slice(0, 80)}...\n`
    }
    await ctx.reply(msg)
  })

  // /voice
  bot.command('voice', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (voiceEnabledChats.has(chatId)) {
      voiceEnabledChats.delete(chatId)
      await ctx.reply('Voice reply mode: OFF')
    } else {
      await ctx.reply('Voice reply requires TTS (not enabled in this build). STT for your voice notes still works.')
    }
  })

  // /model
  bot.command('model', async (ctx) => {
    const chatId = String(ctx.chat.id)
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

  // Text messages
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    if (text.startsWith('/')) return // Skip unhandled commands
    await handleMessage(ctx, text)
  })

  // Voice notes
  bot.on('message:voice', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(ctx.chat.id)) {
      await ctx.reply('Unauthorized.')
      return
    }

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

      await handleMessage(ctx, `[Voice transcribed]: ${transcript}`, true)
    } catch (err) {
      logger.error({ err }, 'Voice handling failed')
      await ctx.reply('Failed to transcribe voice note.')
    }
  })

  // Photos
  bot.on('message:photo', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return

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
    if (!isAuthorised(ctx.chat.id)) return
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
    if (!isAuthorised(ctx.chat.id)) return
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
    const formatted = formatForTelegram(text)
    const chunks = splitMessage(formatted)
    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(Number(chatId), chunk, { parse_mode: 'HTML' })
      } catch {
        await bot.api.sendMessage(Number(chatId), chunk.replace(/<[^>]+>/g, ''))
      }
    }
  }
}
