import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface LoadedTraceModule {
  writeAgentTrace: typeof import('../src/agent-trace.ts').writeAgentTrace
}

async function loadTraceModule(mode: string, traceDir: string, retentionDays = '14'): Promise<LoadedTraceModule> {
  vi.resetModules()
  process.env.AGENT_TRACE_MODE = mode
  process.env.AGENT_TRACE_DIR = traceDir
  process.env.AGENT_TRACE_RETENTION_DAYS = retentionDays
  const mod = await import('../src/agent-trace.ts')
  return { writeAgentTrace: mod.writeAgentTrace }
}

afterEach(() => {
  delete process.env.AGENT_TRACE_MODE
  delete process.env.AGENT_TRACE_DIR
  delete process.env.AGENT_TRACE_RETENTION_DAYS
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('agent trace logging', () => {
  it('does not write files when mode is off', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'kipowerclaw-trace-off-'))
    const { writeAgentTrace } = await loadTraceModule('off', traceDir)

    await writeAgentTrace({
      prompt: 'hello',
      resultText: 'world',
      status: 'success',
      durationMs: 10,
      context: { source: 'message', chatId: '1' },
    })

    expect(readdirSync(traceDir)).toEqual([])
    rmSync(traceDir, { recursive: true, force: true })
  })

  it('writes full payload in full mode', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'kipowerclaw-trace-full-'))
    const { writeAgentTrace } = await loadTraceModule('full', traceDir)

    await writeAgentTrace({
      prompt: 'hello world',
      resultText: 'response text',
      model: 'claude-sonnet-4-6',
      sessionId: 's-1',
      newSessionId: 's-2',
      status: 'success',
      durationMs: 42,
      context: { source: 'message', chatId: '99' },
    })

    const files = readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBe(1)

    const line = readFileSync(resolve(traceDir, files[0]), 'utf-8').trim()
    const record = JSON.parse(line) as Record<string, unknown>
    expect(record['source']).toBe('message')
    expect(record['chatId']).toBe('99')
    expect(record['status']).toBe('success')
    expect(record['prompt']).toBe('hello world')
    expect(record['result']).toBe('response text')

    rmSync(traceDir, { recursive: true, force: true })
  })

  it('logs only failed runs in errors mode', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'kipowerclaw-trace-errors-'))
    const { writeAgentTrace } = await loadTraceModule('errors', traceDir)

    await writeAgentTrace({
      prompt: 'success input',
      resultText: 'ok',
      status: 'success',
      durationMs: 5,
      context: { source: 'scheduler', taskId: 't1' },
    })
    await writeAgentTrace({
      prompt: 'failing input',
      resultText: 'Error: boom',
      status: 'error',
      error: 'boom',
      durationMs: 8,
      context: { source: 'scheduler', taskId: 't2' },
    })

    const files = readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBe(1)
    const lines = readFileSync(resolve(traceDir, files[0]), 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(lines.length).toBe(1)
    const record = JSON.parse(lines[0]) as Record<string, unknown>
    expect(record['status']).toBe('error')
    expect(record['taskId']).toBe('t2')

    rmSync(traceDir, { recursive: true, force: true })
  })

  it('removes trace files older than retention window', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'kipowerclaw-trace-retention-'))
    const { writeAgentTrace } = await loadTraceModule('full', traceDir, '1')

    const stalePath = resolve(traceDir, '2000-01-01.jsonl')
    writeFileSync(stalePath, '{"stale":true}\n')
    expect(existsSync(stalePath)).toBe(true)

    await writeAgentTrace({
      prompt: 'run',
      resultText: 'done',
      status: 'success',
      durationMs: 12,
      context: { source: 'unknown' },
    })

    expect(existsSync(stalePath)).toBe(false)

    rmSync(traceDir, { recursive: true, force: true })
  })
})

