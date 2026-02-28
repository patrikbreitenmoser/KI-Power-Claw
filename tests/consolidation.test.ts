import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type ConsolidationModule = typeof import('../src/consolidation.ts')

interface LoadedConsolidation {
  memoryDir: string
  consolidateDailyLogs: ConsolidationModule['consolidateDailyLogs']
  queryMock: ReturnType<typeof vi.fn>
  scheduleReindexMock: ReturnType<typeof vi.fn>
}

function makeEvents(events: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
    },
  }
}

async function loadConsolidation(today = '2026-03-01'): Promise<LoadedConsolidation> {
  const memoryDir = mkdtempSync(join(tmpdir(), 'kipowerclaw-consolidation-test-'))
  const queryMock = vi.fn()
  const scheduleReindexMock = vi.fn()

  vi.resetModules()
  vi.doMock('../src/config.js', () => ({
    ANTHROPIC_API_KEY: '',
    MEMORY_DIR: memoryDir,
    PROJECT_ROOT: memoryDir,
  }))
  vi.doMock('../src/memory.js', () => ({
    todayZurich: vi.fn().mockReturnValue(today),
  }))
  vi.doMock('../src/qmd.js', () => ({
    scheduleReindex: scheduleReindexMock,
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
  vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
    query: queryMock,
  }))
  vi.doMock('@anthropic-ai/sdk', () => ({
    default: class MockAnthropic {},
  }))

  const { consolidateDailyLogs } = await import('../src/consolidation.ts')
  return { memoryDir, consolidateDailyLogs, queryMock, scheduleReindexMock }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('consolidateDailyLogs', () => {
  it('processes eligible logs, deduplicates facts, archives files, and skips today', async () => {
    const { memoryDir, consolidateDailyLogs, queryMock, scheduleReindexMock } =
      await loadConsolidation('2026-03-01')
    try {
      writeFileSync(
        resolve(memoryDir, 'MEMORY.md'),
        [
          '# Long-Term Memory',
          '',
          '## Preferences',
          '- prefers coffee',
          '',
          '## Projects',
          '- project alpha',
          '',
          '## Misc',
          '',
        ].join('\n')
      )
      writeFileSync(resolve(memoryDir, '2026-02-28.md'), '# 2026-02-28\n\nConversation log')
      writeFileSync(resolve(memoryDir, '2026-03-01.md'), '# 2026-03-01\n\nToday log')

      queryMock.mockImplementation(({ prompt }: { prompt: string }) => {
        expect(prompt).toContain('Date: 2026-02-28')
        return makeEvents([
          {
            type: 'result',
            subtype: 'success',
            result: '- project alpha\n- prefers tea\nthis line should be ignored',
          },
        ])
      })

      const result = await consolidateDailyLogs()
      expect(result).toEqual({ processed: 1, facts: 1 })

      const memoryAfter = readFileSync(resolve(memoryDir, 'MEMORY.md'), 'utf-8')
      expect(memoryAfter).toContain('- prefers tea')
      expect(memoryAfter.match(/- project alpha/g)?.length).toBe(1)

      expect(existsSync(resolve(memoryDir, 'archive', '2026-02-28.md'))).toBe(true)
      expect(existsSync(resolve(memoryDir, '2026-02-28.md'))).toBe(false)
      expect(existsSync(resolve(memoryDir, '2026-03-01.md'))).toBe(true)
      expect(scheduleReindexMock).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(memoryDir, { recursive: true, force: true })
    }
  })

  it('continues processing if one log fails and handles remaining logs', async () => {
    const { memoryDir, consolidateDailyLogs, queryMock, scheduleReindexMock } =
      await loadConsolidation('2026-03-01')
    try {
      writeFileSync(resolve(memoryDir, 'MEMORY.md'), '# Long-Term Memory\n\n## Preferences\n')
      writeFileSync(resolve(memoryDir, '2026-02-27.md'), '# 2026-02-27\n\nBroken source')
      writeFileSync(resolve(memoryDir, '2026-02-28.md'), '# 2026-02-28\n\nHealthy source')

      queryMock.mockImplementation(({ prompt }: { prompt: string }) => {
        if (prompt.includes('Date: 2026-02-27')) {
          return makeEvents([{ type: 'result', subtype: 'error_max_turns' }])
        }
        if (prompt.includes('Date: 2026-02-28')) {
          return makeEvents([{ type: 'result', subtype: 'success', result: '- prefers cats' }])
        }
        return makeEvents([{ type: 'result', subtype: 'success', result: 'nothing notable' }])
      })

      const result = await consolidateDailyLogs()
      expect(result).toEqual({ processed: 1, facts: 1 })

      expect(existsSync(resolve(memoryDir, '2026-02-27.md'))).toBe(true)
      expect(existsSync(resolve(memoryDir, 'archive', '2026-02-27.md'))).toBe(false)
      expect(existsSync(resolve(memoryDir, 'archive', '2026-02-28.md'))).toBe(true)
      expect(readFileSync(resolve(memoryDir, 'MEMORY.md'), 'utf-8')).toContain('- prefers cats')
      expect(scheduleReindexMock).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(memoryDir, { recursive: true, force: true })
    }
  })
})
