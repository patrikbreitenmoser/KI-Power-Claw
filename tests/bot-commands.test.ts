import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from 'grammy'

interface BotHarness {
  memoryDir: string
  createBot: typeof import('../src/bot.ts').createBot
  clearSessionMock: ReturnType<typeof vi.fn>
  listRecentMock: ReturnType<typeof vi.fn>
  getSubagentInfoMock: ReturnType<typeof vi.fn>
  cancelSubagentMock: ReturnType<typeof vi.fn>
}

const tempDirs: string[] = []

async function loadBotHarness(): Promise<BotHarness> {
  const memoryDir = mkdtempSync(join(tmpdir(), 'kipowerclaw-bot-test-'))
  tempDirs.push(memoryDir)
  const clearSessionMock = vi.fn()
  const listRecentMock = vi.fn().mockReturnValue([])
  const getSubagentInfoMock = vi.fn().mockReturnValue(null)
  const cancelSubagentMock = vi.fn().mockReturnValue(false)

  vi.resetModules()
  vi.doMock('grammy', () => {
    class InputFile {
      constructor(public path: string) {}
    }

    class Bot {
      public commandHandlers = new Map<string, (ctx: any) => Promise<void> | void>()
      public textHandlers: Array<(ctx: any) => Promise<void> | void> = []
      public catchHandler: ((err: any) => Promise<void> | void) | null = null
      public api = {
        sendMessage: vi.fn(
          async (chatId: number | string, text: string) =>
            ({
              message_id: 1,
              date: Math.floor(Date.now() / 1000),
              chat: { id: Number(chatId), type: 'private' },
              text,
            }) as any
        ),
        sendPhoto: vi.fn(
          async (chatId: number | string) =>
            ({
              message_id: 1,
              date: Math.floor(Date.now() / 1000),
              chat: { id: Number(chatId), type: 'private' },
            }) as any
        ),
        sendChatAction: vi.fn(async () => true as any),
        setMyCommands: vi.fn(async () => true as any),
      }

      constructor(public token: string) {}

      command(name: string, handler: (ctx: any) => Promise<void> | void) {
        this.commandHandlers.set(name, handler)
      }

      on(event: string, handler: (ctx: any) => Promise<void> | void) {
        if (event === 'message:text') {
          this.textHandlers.push(handler)
        }
      }

      catch(handler: (err: any) => Promise<void> | void) {
        this.catchHandler = handler
      }

      async handleUpdate(update: any) {
        const msg = update?.message
        const ctx = {
          chat: msg?.chat,
          from: msg?.from,
          message: msg,
          api: this.api,
          reply: (text: string, other?: any) => this.api.sendMessage(msg.chat.id, text, other),
          replyWithPhoto: (photo: unknown, other?: any) =>
            this.api.sendPhoto(msg.chat.id, photo, other),
          getFile: async () => ({ file_id: 'file-id' }),
        }

        try {
          const text = msg?.text ?? ''
          if (text.startsWith('/')) {
            const command = text.slice(1).split(/\s+/)[0]
            const handler = this.commandHandlers.get(command)
            if (handler) {
              await handler(ctx)
              return
            }
          }

          for (const handler of this.textHandlers) {
            await handler(ctx)
          }
        } catch (error) {
          if (this.catchHandler) {
            await this.catchHandler({ error })
            return
          }
          throw error
        }
      }

      async start() {}

      stop() {}
    }

    return {
      Bot,
      Context: class Context {},
      InputFile,
    }
  })
  vi.doMock('../src/config.js', () => ({
    TELEGRAM_BOT_TOKEN: 'test-token',
    ALLOWED_USER_IDS: new Set<string>(),
    MAX_MESSAGE_LENGTH: 4096,
    TYPING_REFRESH_MS: 4000,
    DEFAULT_MODEL: 'claude-sonnet-4-6',
    MEMORY_DIR: memoryDir,
  }))
  vi.doMock('../src/db.js', () => ({
    getSession: vi.fn().mockReturnValue(null),
    setSession: vi.fn(),
    clearSession: clearSessionMock,
  }))
  vi.doMock('../src/agent.js', () => ({
    runAgent: vi.fn().mockResolvedValue({ text: 'ok', newSessionId: undefined }),
  }))
  vi.doMock('../src/memory.js', () => ({
    queryMemory: vi.fn().mockResolvedValue(''),
    appendToDailyLog: vi.fn().mockResolvedValue(undefined),
  }))
  vi.doMock('../src/consolidation.js', () => ({
    consolidateDailyLogs: vi.fn().mockResolvedValue({ processed: 0, facts: 0 }),
  }))
  vi.doMock('../src/persona.js', () => ({
    getPersonaContext: vi.fn().mockReturnValue(''),
    reloadPersona: vi.fn(),
  }))
  vi.doMock('../src/voice.js', () => ({
    transcribeAudio: vi.fn(),
    voiceCapabilities: vi.fn().mockReturnValue({ stt: false, tts: false }),
  }))
  vi.doMock('../src/media.js', () => ({
    downloadMedia: vi.fn(),
    buildPhotoMessage: vi.fn(),
    buildDocumentMessage: vi.fn(),
    buildVideoMessage: vi.fn(),
  }))
  vi.doMock('../src/subagent.js', () => ({
    spawnSubagent: vi.fn(),
    cancelSubagent: cancelSubagentMock,
    listRunning: vi.fn().mockReturnValue([]),
    listRecent: listRecentMock,
    getSubagentInfo: getSubagentInfoMock,
    runningCount: vi.fn().mockReturnValue(0),
    detectBackgroundIntent: vi.fn().mockReturnValue(false),
    parseSubagentBlocks: vi
      .fn()
      .mockImplementation((text: string) => ({ cleaned: text, subagents: [] })),
  }))
  vi.doMock('../src/logger.js', () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
    },
  }))

  const { createBot } = await import('../src/bot.ts')
  return {
    memoryDir,
    createBot,
    clearSessionMock,
    listRecentMock,
    getSubagentInfoMock,
    cancelSubagentMock,
  }
}

async function dispatchCommand(
  bot: Bot,
  text: string,
  chatId = 1,
  userId = 1,
  updateId = 1,
  messageId = 1
): Promise<void> {
  const commandToken = text.split(' ')[0]
  await bot.handleUpdate({
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      from: {
        id: userId,
        is_bot: false,
        first_name: 'Tester',
      },
      text,
      entities: [{ offset: 0, length: commandToken.length, type: 'bot_command' }],
    },
  } as any)
}

function sentTexts(bot: Bot): string[] {
  const calls = (bot.api.sendMessage as unknown as { mock: { calls: any[][] } }).mock.calls
  return calls.map(([, text]) => String(text ?? ''))
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
})

describe('/model command flow', () => {
  it('supports inspect, set alias, and reset', async () => {
    const harness = await loadBotHarness()
    const bot = harness.createBot()

    await dispatchCommand(bot, '/model', 1, 1, 1, 1)
    await dispatchCommand(bot, '/model sonnet', 1, 1, 2, 2)
    await dispatchCommand(bot, '/model', 1, 1, 3, 3)
    await dispatchCommand(bot, '/model reset', 1, 1, 4, 4)

    const texts = sentTexts(bot)
    expect(texts[0]).toContain('Current model: claude-sonnet-4-6 (default)')
    expect(texts[1]).toContain('Model set to: claude-sonnet-4-6')
    expect(texts[2]).toContain('(override)')
    expect(texts[3]).toContain('Model reset to default: claude-sonnet-4-6')
    expect(harness.clearSessionMock).toHaveBeenCalledTimes(2)
    expect(harness.clearSessionMock).toHaveBeenCalledWith('1')
  })
})

describe('/agents command flow', () => {
  it('returns empty state when there are no agents', async () => {
    const harness = await loadBotHarness()
    const bot = harness.createBot()

    await dispatchCommand(bot, '/agents', 1, 1, 1, 1)

    expect(sentTexts(bot)).toEqual(['No background agents yet.'])
  })

  it('shows details and truncates long result in /agents <id>', async () => {
    const harness = await loadBotHarness()
    harness.getSubagentInfoMock.mockImplementation((id: string) => {
      if (id !== 'abc123') return null
      return {
        id: 'abc123',
        chat_id: '1',
        description: 'Generate release notes',
        prompt: '...',
        status: 'completed',
        result: 'R'.repeat(2_500),
        started_at: 100,
        finished_at: 140,
      }
    })
    const bot = harness.createBot()

    await dispatchCommand(bot, '/agents abc123', 1, 1, 1, 1)

    const [text] = sentTexts(bot)
    expect(text).toContain('Agent abc123')
    expect(text).toContain('Status: completed')
    expect(text).toContain('Duration: 40s')
    expect(text).toContain('...(truncated)')
  })

  it('cancels running agent with /agents cancel <id>', async () => {
    const harness = await loadBotHarness()
    harness.getSubagentInfoMock.mockImplementation((id: string) => {
      if (id !== 'abc123') return null
      return {
        id: 'abc123',
        chat_id: '1',
        description: 'Long running',
        prompt: '...',
        status: 'running',
        result: null,
        started_at: 100,
        finished_at: null,
      }
    })
    harness.cancelSubagentMock.mockReturnValue(true)

    const bot = harness.createBot()

    await dispatchCommand(bot, '/agents cancel abc123', 1, 1, 1, 1)

    expect(harness.cancelSubagentMock).toHaveBeenCalledWith('abc123')
    expect(sentTexts(bot)).toEqual(['Agent abc123 cancelled.'])
  })
})

describe('/memory command flow', () => {
  it('returns empty state when no memory files exist', async () => {
    const harness = await loadBotHarness()
    const bot = harness.createBot()

    await dispatchCommand(bot, '/memory', 1, 1, 1, 1)

    expect(sentTexts(bot)).toEqual(['No memories stored yet.'])
  })

  it('reports fact count, daily log count, and recent entries', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-28T12:00:00.000Z'))

    const harness = await loadBotHarness()
    writeFileSync(
      resolve(harness.memoryDir, 'MEMORY.md'),
      '# Long-Term Memory\n- fact one\n- fact two\n'
    )
    writeFileSync(resolve(harness.memoryDir, '2026-02-27.md'), '# 2026-02-27\n')
    writeFileSync(
      resolve(harness.memoryDir, '2026-02-28.md'),
      [
        '# 2026-02-28',
        '',
        '## 10:00',
        '',
        '**User**: First request today',
        '',
        '**Assistant**: one',
        '',
        '---',
        '',
        '## 11:30',
        '',
        '**User**: Second request today',
        '',
        '**Assistant**: two',
        '',
        '---',
      ].join('\n')
    )

    const bot = harness.createBot()

    await dispatchCommand(bot, '/memory', 1, 1, 1, 1)

    const [text] = sentTexts(bot)
    expect(text).toContain('Memory: 2 daily logs, 2 long-term facts')
    expect(text).toContain('Recent today:')
    expect(text).toContain('**User**: First request today')
    expect(text).toContain('**User**: Second request today')
  })
})
