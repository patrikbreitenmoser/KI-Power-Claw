import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agent from '../src/agent.ts'
import * as db from '../src/db.ts'
import { computeNextRun, initScheduler, runDueTasks, stopScheduler } from '../src/scheduler.ts'

describe('scheduler', () => {
  const sendMock = vi.fn<(_: string, __: string) => Promise<void>>()

  beforeEach(() => {
    sendMock.mockReset()
    sendMock.mockResolvedValue(undefined)
    initScheduler(sendMock)
  })

  afterEach(() => {
    stopScheduler()
    vi.restoreAllMocks()
  })

  it('does nothing when no task is due', async () => {
    vi.spyOn(db, 'getDueTasks').mockReturnValue([])
    const updateSpy = vi.spyOn(db, 'updateTaskAfterRun').mockImplementation(() => {})

    await runDueTasks()

    expect(sendMock).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('runs due tasks and updates next run on success', async () => {
    vi.spyOn(db, 'getDueTasks').mockReturnValue([
      {
        id: 'task-1',
        chat_id: '123',
        prompt: 'Summarize open pull requests',
        schedule: '*/5 * * * *',
        next_run: 0,
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: 0,
      },
    ])
    vi.spyOn(agent, 'runAgent').mockResolvedValue({
      text: 'Done summary',
      newSessionId: undefined,
    })
    const updateSpy = vi.spyOn(db, 'updateTaskAfterRun').mockImplementation(() => {})

    await runDueTasks()

    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(sendMock).toHaveBeenNthCalledWith(
      1,
      '123',
      expect.stringContaining('Running scheduled task:')
    )
    expect(sendMock).toHaveBeenNthCalledWith(
      2,
      '123',
      expect.stringContaining('Scheduled task result:')
    )
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [id, result, nextRun] = updateSpy.mock.calls[0]
    expect(id).toBe('task-1')
    expect(result).toBe('Done summary')
    expect(typeof nextRun).toBe('number')
    expect(nextRun).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('stores error result and continues when agent execution fails', async () => {
    vi.spyOn(db, 'getDueTasks').mockReturnValue([
      {
        id: 'task-2',
        chat_id: '987',
        prompt: 'Do failing task',
        schedule: '*/10 * * * *',
        next_run: 0,
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: 0,
      },
    ])
    vi.spyOn(agent, 'runAgent').mockRejectedValue(new Error('simulated failure'))
    const updateSpy = vi.spyOn(db, 'updateTaskAfterRun').mockImplementation(() => {})

    await runDueTasks()

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [id, result] = updateSpy.mock.calls[0]
    expect(id).toBe('task-2')
    expect(String(result)).toContain('Error:')
  })

  it('continues with next task if one task fails', async () => {
    vi.spyOn(db, 'getDueTasks').mockReturnValue([
      {
        id: 'task-fail',
        chat_id: '111',
        prompt: 'This fails',
        schedule: '*/5 * * * *',
        next_run: 0,
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: 0,
      },
      {
        id: 'task-ok',
        chat_id: '222',
        prompt: 'This succeeds',
        schedule: '*/5 * * * *',
        next_run: 0,
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: 0,
      },
    ])
    vi.spyOn(agent, 'runAgent')
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce({ text: 'second succeeded', newSessionId: undefined })
    const updateSpy = vi.spyOn(db, 'updateTaskAfterRun').mockImplementation(() => {})

    await runDueTasks()

    expect(updateSpy).toHaveBeenCalledTimes(2)
    expect(updateSpy.mock.calls[0][0]).toBe('task-fail')
    expect(String(updateSpy.mock.calls[0][1])).toContain('Error:')
    expect(updateSpy.mock.calls[1][0]).toBe('task-ok')
    expect(updateSpy.mock.calls[1][1]).toBe('second succeeded')
    expect(sendMock).toHaveBeenCalledWith('222', expect.stringContaining('Scheduled task result:'))
  })

  it('stores an error when initial send fails before agent call', async () => {
    vi.spyOn(db, 'getDueTasks').mockReturnValue([
      {
        id: 'task-send-fail',
        chat_id: '333',
        prompt: 'Will not reach agent',
        schedule: '*/5 * * * *',
        next_run: 0,
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: 0,
      },
    ])
    sendMock.mockRejectedValueOnce(new Error('telegram unavailable'))
    const runAgentSpy = vi.spyOn(agent, 'runAgent')
    const updateSpy = vi.spyOn(db, 'updateTaskAfterRun').mockImplementation(() => {})

    await runDueTasks()

    expect(runAgentSpy).not.toHaveBeenCalled()
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0][0]).toBe('task-send-fail')
    expect(String(updateSpy.mock.calls[0][1])).toContain('Error:')
  })
})

describe('computeNextRun', () => {
  it('returns a unix timestamp in the future', () => {
    const next = computeNextRun('0 * * * *')
    expect(next).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })
})
