import { CronExpressionParser } from 'cron-parser'
import { getDueTasks, updateTaskAfterRun } from './db.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'

type Sender = (chatId: string, text: string) => Promise<void>

const POLL_INTERVAL_MS = 60_000

let pollTimer: ReturnType<typeof setInterval> | undefined
let sendFn: Sender

/**
 * Start the scheduler polling loop.
 */
export function initScheduler(send: Sender): void {
  sendFn = send
  pollTimer = setInterval(() => {
    runDueTasks().catch((err) => {
      logger.error({ err }, 'Scheduler tick failed')
    })
  }, POLL_INTERVAL_MS)
  logger.info('Scheduler started (polling every 60s)')
}

/**
 * Check for and execute all due tasks.
 */
export async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks()
  if (tasks.length === 0) return

  logger.info({ count: tasks.length }, 'Running due scheduled tasks')

  for (const task of tasks) {
    try {
      await sendFn(task.chat_id, `Running scheduled task: ${task.prompt.slice(0, 80)}...`)

      const { text } = await runAgent(task.prompt)
      const result = text ?? '(no response)'

      const nextRun = computeNextRun(task.schedule)
      updateTaskAfterRun(task.id, result.slice(0, 2000), nextRun)

      await sendFn(task.chat_id, `Scheduled task result:\n\n${result}`)
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Failed to run scheduled task')
      const nextRun = computeNextRun(task.schedule)
      updateTaskAfterRun(task.id, `Error: ${err}`, nextRun)
    }
  }
}

/**
 * Compute the next run timestamp from a cron expression.
 */
export function computeNextRun(cronExpression: string): number {
  const expr = CronExpressionParser.parse(cronExpression)
  return Math.floor(expr.next().getTime() / 1000)
}

/**
 * Stop the scheduler.
 */
export function stopScheduler(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = undefined
    logger.info('Scheduler stopped')
  }
}
