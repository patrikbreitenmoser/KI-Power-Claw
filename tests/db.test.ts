import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type DbModule = typeof import('../src/db.ts')

interface LoadedDb {
  db: DbModule
  storeDir: string
}

async function loadDbModule(): Promise<LoadedDb> {
  const storeDir = mkdtempSync(join(tmpdir(), 'kipowerclaw-db-test-'))
  vi.resetModules()
  vi.doMock('../src/config.js', () => ({ STORE_DIR: storeDir }))
  const db = await import('../src/db.ts')
  db.initDatabase()
  return { db, storeDir }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
})

describe('db session and task operations', () => {
  it('supports session CRUD', async () => {
    const { db, storeDir } = await loadDbModule()
    try {
      expect(db.getSession('chat-1')).toBeNull()

      db.setSession('chat-1', 'session-a')
      expect(db.getSession('chat-1')).toBe('session-a')

      db.setSession('chat-1', 'session-b')
      expect(db.getSession('chat-1')).toBe('session-b')

      db.clearSession('chat-1')
      expect(db.getSession('chat-1')).toBeNull()
    } finally {
      db.getDb().close()
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('supports due-task filtering and task updates', async () => {
    const { db, storeDir } = await loadDbModule()
    const now = Math.floor(Date.now() / 1000)
    try {
      db.createTask('due-1', 'chat-1', 'Run now', '*/5 * * * *', now - 5)
      db.createTask('future-1', 'chat-1', 'Run later', '*/5 * * * *', now + 3600)
      db.setTaskStatus('future-1', 'paused')

      const due = db.getDueTasks()
      expect(due.map((t) => t.id)).toEqual(['due-1'])

      db.updateTaskAfterRun('due-1', 'result text', now + 120)
      const updated = db.getTask('due-1')
      expect(updated).not.toBeNull()
      expect(updated!.last_result).toBe('result text')
      expect(updated!.next_run).toBe(now + 120)

      db.deleteTask('future-1')
      expect(db.getTask('future-1')).toBeNull()
    } finally {
      db.getDb().close()
      rmSync(storeDir, { recursive: true, force: true })
    }
  })
})

describe('db subagent operations', () => {
  it('tracks subagent status transitions, orphaning, and retention cleanup', async () => {
    const { db, storeDir } = await loadDbModule()
    try {
      db.insertSubagent('sub-complete', 'chat-a', 'desc', 'prompt')
      db.insertSubagent('sub-running', 'chat-a', 'desc', 'prompt')
      db.insertSubagent('sub-fail', 'chat-a', 'desc', 'prompt')
      db.insertSubagent('sub-cancel', 'chat-a', 'desc', 'prompt')

      db.completeSubagent('sub-complete', 'x'.repeat(12_000))
      db.failSubagent('sub-fail', 'e'.repeat(3_000))
      db.cancelSubagent('sub-cancel')

      const completed = db.getSubagent('sub-complete')
      const failed = db.getSubagent('sub-fail')
      expect(completed?.status).toBe('completed')
      expect(completed?.result?.length).toBe(10_000)
      expect(failed?.status).toBe('failed')
      expect(failed?.result?.length).toBe(2_000)

      expect(db.getRunningSubagents('chat-a').map((r) => r.id)).toEqual(['sub-running'])

      expect(db.orphanRunningSubagents('restart')).toBe(1)
      expect(db.getSubagent('sub-running')?.status).toBe('orphaned')
      expect(db.getSubagent('sub-running')?.result).toBe('restart')

      expect(
        db.cleanupSubagentsRetention({
          completed: -1,
          cancelled: -1,
          failed: -1,
          orphaned: -1,
        })
      ).toBe(4)

      expect(db.getSubagent('sub-complete')).toBeNull()
      expect(db.getSubagent('sub-fail')).toBeNull()
      expect(db.getSubagent('sub-cancel')).toBeNull()
      expect(db.getSubagent('sub-running')).toBeNull()
    } finally {
      db.getDb().close()
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('returns recent subagents ordered by started_at desc with limit', async () => {
    vi.useFakeTimers()
    const { db, storeDir } = await loadDbModule()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      db.insertSubagent('sub-a', 'chat-z', 'desc a', 'prompt a')
      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
      db.insertSubagent('sub-b', 'chat-z', 'desc b', 'prompt b')
      vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'))
      db.insertSubagent('sub-c', 'chat-z', 'desc c', 'prompt c')

      const recent = db.getRecentSubagents('chat-z', 2)
      expect(recent.map((r) => r.id)).toEqual(['sub-c', 'sub-b'])
    } finally {
      db.getDb().close()
      rmSync(storeDir, { recursive: true, force: true })
    }
  })
})
