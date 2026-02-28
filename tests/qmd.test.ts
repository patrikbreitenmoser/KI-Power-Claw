import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type QmdModule = typeof import('../src/qmd.ts')

interface LoadedQmd {
  qmd: QmdModule
  binDir: string
  restorePath: () => void
}

async function loadQmdWithScript(script: string): Promise<LoadedQmd> {
  const binDir = mkdtempSync(join(tmpdir(), 'kipowerclaw-qmd-test-'))
  const binary = resolve(binDir, 'qmd')
  writeFileSync(binary, script, { mode: 0o755 })

  const oldPath = process.env.PATH ?? ''
  process.env.PATH = `${binDir}:${oldPath}`
  vi.resetModules()
  vi.doMock('../src/logger.js', () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
    },
  }))

  const qmd = await import('../src/qmd.ts')
  return {
    qmd,
    binDir,
    restorePath: () => {
      process.env.PATH = oldPath
    },
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for condition')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
})

describe('searchMemory', () => {
  it('returns only valid typed search results', async () => {
    const { qmd, binDir, restorePath } = await loadQmdWithScript(`#!/bin/sh
if [ "$1" = "search" ]; then
  echo '[{"docid":"d1","score":0.99,"file":"a.md","title":"A","snippet":"match"},{"docid":123}]'
  exit 0
fi
exit 0
`)
    try {
      const results = await qmd.searchMemory('test', 5)
      expect(results).toEqual([
        {
          docid: 'd1',
          score: 0.99,
          file: 'a.md',
          title: 'A',
          snippet: 'match',
        },
      ])
    } finally {
      restorePath()
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('returns [] when qmd outputs invalid json', async () => {
    const { qmd, binDir, restorePath } = await loadQmdWithScript(`#!/bin/sh
if [ "$1" = "search" ]; then
  echo 'not-json'
  exit 0
fi
exit 0
`)
    try {
      const results = await qmd.searchMemory('test', 5)
      expect(results).toEqual([])
    } finally {
      restorePath()
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('returns [] when qmd command fails', async () => {
    const { qmd, binDir, restorePath } = await loadQmdWithScript(`#!/bin/sh
if [ "$1" = "search" ]; then
  echo 'search failed' 1>&2
  exit 2
fi
exit 0
`)
    try {
      const results = await qmd.searchMemory('test', 5)
      expect(results).toEqual([])
    } finally {
      restorePath()
      rmSync(binDir, { recursive: true, force: true })
    }
  })
})

describe('scheduleReindex and checkQmdAvailable', () => {
  it('debounces reindex calls to a single update/embed run', async () => {
    const logPath = resolve(mkdtempSync(join(tmpdir(), 'kipowerclaw-qmd-log-')), 'qmd.log')
    const { qmd, binDir, restorePath } = await loadQmdWithScript(`#!/bin/sh
if [ "$1" = "update" ]; then
  echo update >> "${logPath}"
  exit 0
fi
if [ "$1" = "embed" ]; then
  echo embed >> "${logPath}"
  exit 0
fi
if [ "$1" = "status" ]; then
  exit 0
fi
exit 0
`)
    try {
      vi.useFakeTimers()
      qmd.scheduleReindex()
      qmd.scheduleReindex()
      qmd.scheduleReindex()

      expect(existsSync(logPath)).toBe(false)
      vi.advanceTimersByTime(5_000)
      vi.useRealTimers()

      await waitFor(() => {
        if (!existsSync(logPath)) return false
        const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
        return lines.length === 2
      })

      const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
      expect(lines).toEqual(['update', 'embed'])
    } finally {
      restorePath()
      rmSync(binDir, { recursive: true, force: true })
      rmSync(dirname(logPath), { recursive: true, force: true })
    }
  })

  it('reports status availability correctly', async () => {
    const { qmd: okQmd, binDir: okDir, restorePath: restoreOkPath } = await loadQmdWithScript(`#!/bin/sh
if [ "$1" = "status" ]; then
  exit 0
fi
exit 0
`)
    try {
      await expect(okQmd.checkQmdAvailable()).resolves.toBe(true)
    } finally {
      restoreOkPath()
      rmSync(okDir, { recursive: true, force: true })
    }

    const { qmd: failQmd, binDir: failDir, restorePath: restoreFailPath } = await loadQmdWithScript(`#!/bin/sh
if [ "$1" = "status" ]; then
  exit 1
fi
exit 0
`)
    try {
      await expect(failQmd.checkQmdAvailable()).resolves.toBe(false)
    } finally {
      restoreFailPath()
      rmSync(failDir, { recursive: true, force: true })
    }
  })
})
