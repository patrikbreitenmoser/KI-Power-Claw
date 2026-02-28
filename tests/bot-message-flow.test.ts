import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from 'grammy'

interface BotFlowHarness {
  createBot: typeof import('../src/bot.ts').createBot
  runAgentMock: ReturnType<typeof vi.fn>
  getSessionMock: ReturnType<typeof vi.fn>
  setSessionMock: ReturnType<typeof vi.fn>
  queryMemoryMock: ReturnType<typeof vi.fn>
  appendToDailyLogMock: ReturnType<typeof vi.fn>
  getPersonaContextMock: ReturnType<typeof vi.fn>
  reloadPersonaMock: ReturnType<typeof vi.fn>
  spawnSubagentMock: ReturnType<typeof vi.fn>
  runningCountMock: ReturnType<typeof vi.fn>
  detectBackgroundIntentMock: ReturnType<typeof vi.fn>
  parseSubagentBlocksMock: ReturnType<typeof vi.fn>
}

async function loadBotFlowHarness(): Promise<BotFlowHarness> {
  const runAgentMock = vi.fn()
  const getSessionMock = vi.fn().mockReturnValue(null)
  const setSessionMock = vi.fn()
  const queryMemoryMock = vi.fn().mockResolvedValue('')
  const appendToDailyLogMock = vi.fn().mockResolvedValue(undefined)
  const getPersonaContextMock = vi.fn().mockReturnValue('')
  const reloadPersonaMock = vi.fn()
  const spawnSubagentMock = vi.fn().mockReturnValue('sub-1')
  const runningCountMock = vi.fn().mockReturnValue(0)
  const detectBackgroundIntentMock = vi.fn().mockReturnValue(false)
  const parseSubagentBlocksMock = vi
    .fn()
    .mockImplementation((text: string) => ({ cleaned: text, subagents: [] }))

  vi.resetModules()
  vi.doMock('grammy', () => {
    class InputFile {
      constructor(public path: string) {}
    }

    class Bot {
      public commandHandlers = new Map<string, (ctx: any) => Promise<void> | void>()
      public handlers: Record<string, Array<(ctx: any) => Promise<void> | void>> = {}
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
        if (!this.handlers[event]) this.handlers[event] = []
        this.handlers[event].push(handler)
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
            const cmd = text.slice(1).split(/\s+/)[0]
            const handler = this.commandHandlers.get(cmd)
            if (handler) {
              await handler(ctx)
              return
            }
          }

          if (text && this.handlers['message:text']) {
            for (const handler of this.handlers['message:text']) {
              await handler(ctx)
            }
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
    MEMORY_DIR: '/tmp/not-used',
  }))
  vi.doMock('../src/db.js', () => ({
    getSession: getSessionMock,
    setSession: setSessionMock,
    clearSession: vi.fn(),
  }))
  vi.doMock('../src/agent.js', () => ({
    runAgent: runAgentMock,
  }))
  vi.doMock('../src/memory.js', () => ({
    queryMemory: queryMemoryMock,
    appendToDailyLog: appendToDailyLogMock,
  }))
  vi.doMock('../src/consolidation.js', () => ({
    consolidateDailyLogs: vi.fn().mockResolvedValue({ processed: 0, facts: 0 }),
  }))
  vi.doMock('../src/persona.js', () => ({
    getPersonaContext: getPersonaContextMock,
    reloadPersona: reloadPersonaMock,
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
    spawnSubagent: spawnSubagentMock,
    cancelSubagent: vi.fn(),
    listRunning: vi.fn().mockReturnValue([]),
    listRecent: vi.fn().mockReturnValue([]),
    getSubagentInfo: vi.fn().mockReturnValue(null),
    runningCount: runningCountMock,
    detectBackgroundIntent: detectBackgroundIntentMock,
    parseSubagentBlocks: parseSubagentBlocksMock,
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
    createBot,
    runAgentMock,
    getSessionMock,
    setSessionMock,
    queryMemoryMock,
    appendToDailyLogMock,
    getPersonaContextMock,
    reloadPersonaMock,
    spawnSubagentMock,
    runningCountMock,
    detectBackgroundIntentMock,
    parseSubagentBlocksMock,
  }
}

async function dispatchText(
  bot: Bot,
  text: string,
  chatId = 1,
  userId = 1,
  updateId = 1,
  messageId = 1
): Promise<void> {
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
    },
  } as any)
}

function sendMessageCalls(bot: Bot): any[][] {
  return (bot.api.sendMessage as any).mock.calls
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
})

describe('message handling flow', () => {
  it('spawns background subagent immediately when intent is detected', async () => {
    const harness = await loadBotFlowHarness()
    harness.detectBackgroundIntentMock.mockReturnValue(true)
    harness.runningCountMock.mockReturnValue(2)
    harness.spawnSubagentMock.mockReturnValue('bg-123')
    const bot = harness.createBot()

    await dispatchText(bot, 'Please do this in the background')

    expect(harness.spawnSubagentMock).toHaveBeenCalledWith(
      '1',
      'Please do this in the background',
      'Please do this in the background',
      'claude-sonnet-4-6'
    )
    expect(harness.runAgentMock).not.toHaveBeenCalled()
    const texts = sendMessageCalls(bot).map((call) => String(call[1]))
    expect(texts[0]).toContain('agent bg-123')
    expect(texts[0]).toContain('2 background agents running')
  })

  it('builds full context, updates session, handles subagents and media from result', async () => {
    const harness = await loadBotFlowHarness()
    harness.detectBackgroundIntentMock.mockReturnValue(false)
    harness.getPersonaContextMock.mockReturnValue('[Persona]\n')
    harness.queryMemoryMock.mockResolvedValue('[Memory]\n')
    harness.getSessionMock.mockReturnValue('sess-1')
    harness.runAgentMock.mockResolvedValue({
      text: 'Original response from model',
      newSessionId: 'sess-2',
    })
    harness.parseSubagentBlocksMock.mockReturnValue({
      cleaned: 'Hello **World**\nMEDIA: /tmp/graph.png',
      subagents: [{ description: 'Research topic', prompt: 'Do deep research' }],
    })
    harness.spawnSubagentMock.mockReturnValue('sub-42')
    const bot = harness.createBot()

    await dispatchText(bot, 'Summarize this project')

    expect(harness.runAgentMock).toHaveBeenCalledTimes(1)
    const [fullMessage, sessionId, refreshTyping, model] = harness.runAgentMock.mock.calls[0]
    expect(fullMessage).toBe('[Persona]\n[Memory]\nSummarize this project')
    expect(sessionId).toBe('sess-1')
    expect(typeof refreshTyping).toBe('function')
    expect(model).toBe('claude-sonnet-4-6')

    expect(harness.setSessionMock).toHaveBeenCalledWith('1', 'sess-2')
    expect(harness.reloadPersonaMock).toHaveBeenCalledTimes(1)
    expect(harness.appendToDailyLogMock).toHaveBeenCalledWith(
      'Summarize this project',
      'Original response from model'
    )
    expect(harness.spawnSubagentMock).toHaveBeenCalledWith(
      '1',
      'Research topic',
      'Do deep research',
      'claude-sonnet-4-6'
    )

    const sendTexts = sendMessageCalls(bot).map((call) => String(call[1]))
    expect(sendTexts.some((text) => text.includes('Spawned background agent (sub-42): Research topic'))).toBe(
      true
    )
    expect(sendTexts.some((text) => text.includes('<b>World</b>'))).toBe(true)
    expect((bot.api.sendPhoto as any).mock.calls).toHaveLength(1)
  })

  it('falls back to plain text when html send fails', async () => {
    const harness = await loadBotFlowHarness()
    harness.detectBackgroundIntentMock.mockReturnValue(false)
    harness.getPersonaContextMock.mockReturnValue('')
    harness.queryMemoryMock.mockResolvedValue('')
    harness.runAgentMock.mockResolvedValue({
      text: 'Hello **World**',
      newSessionId: undefined,
    })
    harness.parseSubagentBlocksMock.mockReturnValue({
      cleaned: 'Hello **World**',
      subagents: [],
    })
    const bot = harness.createBot()
    ;(bot.api.sendMessage as any)
      .mockImplementationOnce(async () => {
        throw new Error('HTML parse error')
      })
      .mockImplementation(async (chatId: number | string, text: string) => ({
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(chatId), type: 'private' },
        text,
      }))

    await dispatchText(bot, 'hello')

    const calls = sendMessageCalls(bot)
    expect(calls).toHaveLength(2)
    expect(String(calls[0][1])).toContain('<b>World</b>')
    expect(String(calls[1][1])).toBe('Hello World')
  })
})
