import { afterEach, describe, expect, it, vi } from 'vitest'

type SubagentModule = typeof import('../src/subagent.ts')

interface LoadedSubagent {
  subagent: SubagentModule
  runAgentMock: ReturnType<typeof vi.fn>
  insertSubagentMock: ReturnType<typeof vi.fn>
  completeSubagentMock: ReturnType<typeof vi.fn>
  failSubagentMock: ReturnType<typeof vi.fn>
  dbCancelSubagentMock: ReturnType<typeof vi.fn>
  queryMemoryMock: ReturnType<typeof vi.fn>
  getPersonaContextMock: ReturnType<typeof vi.fn>
  cleanupOldSubagentsMock: ReturnType<typeof vi.fn>
}

async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

async function loadSubagentModule(): Promise<LoadedSubagent> {
  const runAgentMock = vi.fn()
  const insertSubagentMock = vi.fn()
  const completeSubagentMock = vi.fn()
  const failSubagentMock = vi.fn()
  const dbCancelSubagentMock = vi.fn()
  const queryMemoryMock = vi.fn()
  const getPersonaContextMock = vi.fn()
  const cleanupOldSubagentsMock = vi.fn()

  vi.resetModules()
  vi.doMock('node:crypto', () => ({
    randomBytes: vi.fn(() => Buffer.from([0, 1, 2, 3])),
  }))
  vi.doMock('../src/agent.js', () => ({
    runAgent: runAgentMock,
  }))
  vi.doMock('../src/db.js', () => ({
    insertSubagent: insertSubagentMock,
    completeSubagent: completeSubagentMock,
    failSubagent: failSubagentMock,
    cancelSubagent: dbCancelSubagentMock,
    getRunningSubagents: vi.fn().mockReturnValue([]),
    getRecentSubagents: vi.fn().mockReturnValue([]),
    getSubagent: vi.fn().mockReturnValue(null),
    cleanupOldSubagents: cleanupOldSubagentsMock,
  }))
  vi.doMock('../src/persona.js', () => ({
    getPersonaContext: getPersonaContextMock,
  }))
  vi.doMock('../src/memory.js', () => ({
    queryMemory: queryMemoryMock,
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

  const subagent = await import('../src/subagent.ts')
  return {
    subagent,
    runAgentMock,
    insertSubagentMock,
    completeSubagentMock,
    failSubagentMock,
    dbCancelSubagentMock,
    queryMemoryMock,
    getPersonaContextMock,
    cleanupOldSubagentsMock,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('subagent lifecycle', () => {
  it('spawns, runs with full prompt context, completes, and notifies user', async () => {
    const {
      subagent,
      runAgentMock,
      insertSubagentMock,
      completeSubagentMock,
      failSubagentMock,
      queryMemoryMock,
      getPersonaContextMock,
      cleanupOldSubagentsMock,
    } = await loadSubagentModule()
    const sendMock = vi.fn().mockResolvedValue(undefined)

    getPersonaContextMock.mockReturnValue('[Persona]\n')
    queryMemoryMock.mockResolvedValue('[Memory]\n')
    runAgentMock.mockResolvedValue({
      text: 'Background result',
      newSessionId: undefined,
    })

    subagent.initSubagentSystem(sendMock)
    expect(cleanupOldSubagentsMock).toHaveBeenCalledTimes(1)

    const id = subagent.spawnSubagent('chat-1', 'Analyze repo', 'Inspect architecture', 'model-x')
    expect(id).toBe('00010203')
    expect(insertSubagentMock).toHaveBeenCalledWith(
      '00010203',
      'chat-1',
      'Analyze repo',
      'Inspect architecture'
    )

    await waitFor(() => runAgentMock.mock.calls.length > 0)
    const [fullPrompt, sessionId, onTyping, model] = runAgentMock.mock.calls[0]
    expect(fullPrompt).toContain('[Persona]')
    expect(fullPrompt).toContain('[Memory]')
    expect(fullPrompt).toContain('[Background task: Analyze repo]')
    expect(fullPrompt).toContain('Inspect architecture')
    expect(sessionId).toBeUndefined()
    expect(onTyping).toBeUndefined()
    expect(model).toBe('model-x')

    await waitFor(() => completeSubagentMock.mock.calls.length > 0)
    expect(completeSubagentMock).toHaveBeenCalledWith('00010203', 'Background result')
    expect(failSubagentMock).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Background task done: Analyze repo')
    )
    expect(subagent.runningCount('chat-1')).toBe(0)
  })

  it('keeps MEDIA lines in completion notifications even when text is truncated', async () => {
    const {
      subagent,
      runAgentMock,
      queryMemoryMock,
      getPersonaContextMock,
    } = await loadSubagentModule()
    const sendMock = vi.fn().mockResolvedValue(undefined)

    getPersonaContextMock.mockReturnValue('[Persona]\n')
    queryMemoryMock.mockResolvedValue('')
    runAgentMock.mockResolvedValue({
      text: `${'A'.repeat(3500)}\nMEDIA: /tmp/generated.png`,
      newSessionId: undefined,
    })

    subagent.initSubagentSystem(sendMock)
    subagent.spawnSubagent('chat-1', 'Long image task', 'Generate and summarize')

    await waitFor(() => sendMock.mock.calls.length > 0)
    const payload = String(sendMock.mock.calls[0][1])
    expect(payload).toContain('Background task done: Long image task')
    expect(payload).toContain('MEDIA: /tmp/generated.png')
    expect(payload).toContain('...(truncated, use /agents <id> to see full result)')
  })

  it('marks subagent failed and notifies user on execution error', async () => {
    const {
      subagent,
      runAgentMock,
      completeSubagentMock,
      failSubagentMock,
      queryMemoryMock,
      getPersonaContextMock,
    } = await loadSubagentModule()
    const sendMock = vi.fn().mockResolvedValue(undefined)

    getPersonaContextMock.mockReturnValue('[Persona]\n')
    queryMemoryMock.mockResolvedValue('')
    runAgentMock.mockRejectedValue(new Error('execution boom'))

    subagent.initSubagentSystem(sendMock)
    const id = subagent.spawnSubagent('chat-1', 'Failing task', 'Do failing thing')
    expect(id).toBe('00010203')

    await waitFor(() => failSubagentMock.mock.calls.length > 0)
    expect(failSubagentMock).toHaveBeenCalledWith('00010203', 'execution boom')
    expect(completeSubagentMock).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Background task failed: Failing task')
    )
    expect(subagent.runningCount('chat-1')).toBe(0)
  })

  it('can cancel a running subagent and updates db status', async () => {
    const {
      subagent,
      runAgentMock,
      dbCancelSubagentMock,
      queryMemoryMock,
      getPersonaContextMock,
    } = await loadSubagentModule()
    const sendMock = vi.fn().mockResolvedValue(undefined)

    getPersonaContextMock.mockReturnValue('[Persona]\n')
    queryMemoryMock.mockResolvedValue('')
    runAgentMock.mockImplementation(
      (_prompt: string, _s: unknown, _t: unknown, _m: unknown, abortController?: AbortController) =>
        new Promise((_resolve, reject) => {
          abortController?.signal.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        })
    )

    subagent.initSubagentSystem(sendMock)
    const id = subagent.spawnSubagent('chat-1', 'Long task', 'Take your time')

    await waitFor(() => runAgentMock.mock.calls.length > 0)
    expect(subagent.runningCount('chat-1')).toBe(1)

    expect(subagent.cancelSubagent(id)).toBe(true)
    expect(dbCancelSubagentMock).toHaveBeenCalledWith(id)
    expect(subagent.runningCount('chat-1')).toBe(0)
    expect(subagent.cancelSubagent(id)).toBe(false)
  })
})
