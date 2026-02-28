import { CronExpressionParser } from 'cron-parser'
import { randomUUID } from 'node:crypto'
import { initDatabase, createTask, getAllTasks, deleteTask, setTaskStatus, getTask } from './db.js'
import { computeNextRun } from './scheduler.js'

const [, , command, ...args] = process.argv

function usage(): void {
  console.log(`
Usage: node dist/schedule-cli.js <command> [args]

Commands:
  create "<prompt>" "<cron>" <chat_id>   Create a scheduled task
  list                                    List all tasks
  delete <id>                             Delete a task
  pause <id>                              Pause a task
  resume <id>                             Resume a paused task

Examples:
  node dist/schedule-cli.js create "Summarize my emails" "0 9 * * *" 12345678
  node dist/schedule-cli.js list
  node dist/schedule-cli.js pause abc-123
`)
}

function main(): void {
  initDatabase()

  switch (command) {
    case 'create': {
      const [prompt, cron, chatId] = args
      if (!prompt || !cron || !chatId) {
        console.error('Error: create requires <prompt> <cron> <chat_id>')
        usage()
        process.exit(1)
      }

      // Validate cron expression
      try {
        CronExpressionParser.parse(cron)
      } catch {
        console.error(`Error: Invalid cron expression "${cron}"`)
        process.exit(1)
      }

      const id = randomUUID().slice(0, 8)
      const nextRun = computeNextRun(cron)
      createTask(id, chatId, prompt, cron, nextRun)

      console.log(`Task created:`)
      console.log(`  ID:       ${id}`)
      console.log(`  Prompt:   ${prompt}`)
      console.log(`  Schedule: ${cron}`)
      console.log(`  Next run: ${new Date(nextRun * 1000).toLocaleString()}`)
      break
    }

    case 'list': {
      const tasks = getAllTasks()
      if (tasks.length === 0) {
        console.log('No scheduled tasks.')
        break
      }

      console.log(
        `${'ID'.padEnd(10)} ${'Status'.padEnd(8)} ${'Schedule'.padEnd(16)} ${'Next Run'.padEnd(22)} Prompt`
      )
      console.log('-'.repeat(90))
      for (const t of tasks) {
        const nextStr = new Date(t.next_run * 1000).toLocaleString()
        console.log(
          `${t.id.padEnd(10)} ${t.status.padEnd(8)} ${t.schedule.padEnd(16)} ${nextStr.padEnd(22)} ${t.prompt.slice(0, 40)}`
        )
      }
      break
    }

    case 'delete': {
      const [id] = args
      if (!id) {
        console.error('Error: delete requires <id>')
        process.exit(1)
      }
      const task = getTask(id)
      if (!task) {
        console.error(`Task ${id} not found`)
        process.exit(1)
      }
      deleteTask(id)
      console.log(`Task ${id} deleted.`)
      break
    }

    case 'pause': {
      const [id] = args
      if (!id) {
        console.error('Error: pause requires <id>')
        process.exit(1)
      }
      const task = getTask(id)
      if (!task) {
        console.error(`Task ${id} not found`)
        process.exit(1)
      }
      setTaskStatus(id, 'paused')
      console.log(`Task ${id} paused.`)
      break
    }

    case 'resume': {
      const [id] = args
      if (!id) {
        console.error('Error: resume requires <id>')
        process.exit(1)
      }
      const task = getTask(id)
      if (!task) {
        console.error(`Task ${id} not found`)
        process.exit(1)
      }
      setTaskStatus(id, 'active')
      console.log(`Task ${id} resumed.`)
      break
    }

    default:
      if (command) console.error(`Unknown command: ${command}`)
      usage()
      process.exit(command ? 1 : 0)
  }
}

main()
