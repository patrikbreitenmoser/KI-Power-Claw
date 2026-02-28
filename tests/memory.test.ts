import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type MemoryModule = typeof import('../src/memory.ts')

interface LoadedMemory {
  memory: MemoryModule
  memoryDir: string
  searchMemoryMock: ReturnType<typeof vi.fn>
  scheduleReindexMock: ReturnType<typeof vi.fn>
}

async function loadMemoryModule(searchResults: unknown[] = [], searchReject?: Error): Promise<LoadedMemory> {
  const memoryDir = mkdtempSync(join(tmpdir(), 'kipowerclaw-memory-test-'))
  const searchMemoryMock = vi.fn()
  if (searchReject) {
    searchMemoryMock.mockRejectedValue(searchReject)
  } else {
    searchMemoryMock.mockResolvedValue(searchResults)
  }
  const scheduleReindexMock = vi.fn()

  vi.resetModules()
  vi.doMock('../src/config.js', () => ({ MEMORY_DIR: memoryDir }))
  vi.doMock('../src/qmd.js', () => ({
    searchMemory: searchMemoryMock,
    scheduleReindex: scheduleReindexMock,
  }))

  const memory = await import('../src/memory.ts')
  return { memory, memoryDir, searchMemoryMock, scheduleReindexMock }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
})

describe('queryMemory', () => {
  it('combines MEMORY.md and QMD search hits', async () => {
    const { memory, memoryDir } = await loadMemoryModule([
      {
        docid: '1',
        score: 0.9,
        file: '2026-02-28.md',
        title: '',
        snippet: 'You prefer concise answers.',
      },
    ])
    try {
      writeFileSync(resolve(memoryDir, 'MEMORY.md'), '# Long-Term Memory\n- Loves automation\n')

      const result = await memory.queryMemory('preferences')

      expect(result).toContain('[Long-term memory]')
      expect(result).toContain('Loves automation')
      expect(result).toContain('[Relevant past context]')
      expect(result).toContain('You prefer concise answers.')
    } finally {
      rmSync(memoryDir, { recursive: true, force: true })
    }
  })

  it('returns long-term memory when qmd search fails', async () => {
    const { memory, memoryDir } = await loadMemoryModule([], new Error('qmd unavailable'))
    try {
      writeFileSync(resolve(memoryDir, 'MEMORY.md'), '- Stable fact\n')
      const result = await memory.queryMemory('anything')
      expect(result).toContain('Stable fact')
    } finally {
      rmSync(memoryDir, { recursive: true, force: true })
    }
  })

  it('returns empty string when no memory content is available', async () => {
    const { memory, memoryDir } = await loadMemoryModule([])
    try {
      const result = await memory.queryMemory('anything')
      expect(result).toBe('')
    } finally {
      rmSync(memoryDir, { recursive: true, force: true })
    }
  })
})

describe('appendToDailyLog', () => {
  it('writes daily entries, truncates assistant output, and schedules reindex', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-28T10:07:00.000Z'))

    const { memory, memoryDir, scheduleReindexMock } = await loadMemoryModule()
    try {
      const date = memory.todayZurich()
      await memory.appendToDailyLog(
        'This is a long enough user message to be persisted to the daily log.',
        'A'.repeat(2_500)
      )

      const logPath = resolve(memoryDir, `${date}.md`)
      expect(existsSync(logPath)).toBe(true)

      const content = readFileSync(logPath, 'utf-8')
      expect(content).toContain(`# ${date}`)
      expect(content).toContain('## 11:07')
      expect(content).toContain('**User**: This is a long enough user message')

      const match = content.match(/\*\*Assistant\*\*: ([\s\S]*?)\n\n---/)
      expect(match).not.toBeNull()
      expect(match?.[1].length).toBe(2_000)
      expect(scheduleReindexMock).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(memoryDir, { recursive: true, force: true })
    }
  })

  it('ignores short and command-like user messages', async () => {
    const { memory, memoryDir, scheduleReindexMock } = await loadMemoryModule()
    try {
      await memory.appendToDailyLog('/help', 'response')
      await memory.appendToDailyLog('too short', 'response')
      await memory.appendToDailyLog('x'.repeat(20), 'response')

      const files = readdirSync(memoryDir).filter((f) => f.endsWith('.md'))
      expect(files).toEqual([])
      expect(scheduleReindexMock).not.toHaveBeenCalled()
    } finally {
      rmSync(memoryDir, { recursive: true, force: true })
    }
  })
})
