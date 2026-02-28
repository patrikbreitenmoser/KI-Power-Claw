import { randomBytes } from 'node:crypto'
import { runAgent } from './agent.js'
import {
  insertSubagent,
  completeSubagent,
  failSubagent,
  cancelSubagent as dbCancelSubagent,
  getRunningSubagents,
  getRecentSubagents,
  getSubagent,
  cleanupOldSubagents,
  type SubagentRow,
} from './db.js'
import { getPersonaContext } from './persona.js'
import { buildMemoryContext } from './memory.js'
import { logger } from './logger.js'

// --- Types ---

type SendFn = (chatId: string, text: string) => Promise<void>

interface RunningAgent {
  id: string
  chatId: string
  description: string
  abortController: AbortController
}

// --- State ---

let sendFn: SendFn | null = null
const runningAgents = new Map<string, RunningAgent>()

// --- Init ---

export function initSubagentSystem(send: SendFn): void {
  sendFn = send
  cleanupOldSubagents()
  logger.info('Subagent system initialized')
}

// --- Public API ---

/**
 * Spawn a background agent. Returns immediately with the agent ID.
 * The agent runs asynchronously and sends results via Telegram when done.
 */
export function spawnSubagent(
  chatId: string,
  description: string,
  prompt: string,
  model?: string
): string {
  const id = generateId()

  // Persist to DB
  insertSubagent(id, chatId, description, prompt)

  // Build full context (persona + memory, same as main agent)
  const personaContext = getPersonaContext()
  const memoryPrefix = buildMemoryContext(chatId, prompt)
  const fullPrompt = personaContext + (memoryPrefix || '') +
    `[Background task: ${description}]\n\n${prompt}`

  // Track in memory for cancellation
  const abortController = new AbortController()
  runningAgents.set(id, { id, chatId, description, abortController })

  // Fire and forget -- don't await
  executeBackground(id, chatId, description, fullPrompt, model).catch((err) => {
    logger.error({ err, agentId: id }, 'Background agent execution error (unhandled)')
  })

  logger.info({ agentId: id, chatId, description }, 'Subagent spawned')
  return id
}

/**
 * Cancel a running subagent.
 */
export function cancelSubagent(id: string): boolean {
  const running = runningAgents.get(id)
  if (!running) return false

  running.abortController.abort()
  runningAgents.delete(id)
  dbCancelSubagent(id)
  logger.info({ agentId: id }, 'Subagent cancelled')
  return true
}

/**
 * List running subagents for a chat.
 */
export function listRunning(chatId: string): SubagentRow[] {
  return getRunningSubagents(chatId)
}

/**
 * List recent subagents (all statuses) for a chat.
 */
export function listRecent(chatId: string, limit = 10): SubagentRow[] {
  return getRecentSubagents(chatId, limit)
}

/**
 * Get a single subagent by ID.
 */
export function getSubagentInfo(id: string): SubagentRow | null {
  return getSubagent(id)
}

/**
 * Get count of currently running agents for a chat.
 */
export function runningCount(chatId: string): number {
  let count = 0
  for (const agent of runningAgents.values()) {
    if (agent.chatId === chatId) count++
  }
  return count
}

// --- Background detection ---

const BACKGROUND_KEYWORDS = [
  'in the background',
  'im hintergrund',
  'work on this separately',
  'run this in background',
  'background task',
  'do this async',
  'handle this separately',
]

/**
 * Check if a user message indicates they want background processing.
 */
export function detectBackgroundIntent(message: string): boolean {
  const lower = message.toLowerCase()
  return BACKGROUND_KEYWORDS.some((kw) => lower.includes(kw))
}

/**
 * Extract SUBAGENT blocks from an agent response.
 * Protocol:
 *   SUBAGENT: <description>
 *   ---
 *   <prompt for the background agent>
 *   ---
 *
 * Returns extracted subagent requests and the cleaned response text.
 */
export function parseSubagentBlocks(
  text: string
): { cleaned: string; subagents: Array<{ description: string; prompt: string }> } {
  const subagents: Array<{ description: string; prompt: string }> = []
  const subagentRegex = /^SUBAGENT:\s*(.+)\n---\n([\s\S]*?)\n---$/gm

  let match
  while ((match = subagentRegex.exec(text)) !== null) {
    subagents.push({
      description: match[1].trim(),
      prompt: match[2].trim(),
    })
  }

  const cleaned = text.replace(/^SUBAGENT:\s*.+\n---\n[\s\S]*?\n---$/gm, '').trim()

  return { cleaned, subagents }
}

// --- Internal ---

async function executeBackground(
  id: string,
  chatId: string,
  description: string,
  fullPrompt: string,
  model?: string
): Promise<void> {
  try {
    // Run agent without session resume (fresh context)
    const { text } = await runAgent(fullPrompt, undefined, undefined, model)
    const result = text ?? '(no response)'

    // Update DB
    completeSubagent(id, result)

    // Notify user
    if (sendFn) {
      const summary = result.length > 3000
        ? result.slice(0, 3000) + '\n\n...(truncated, use /agents <id> to see full result)'
        : result
      await sendFn(chatId, `Background task done: ${description}\n\n${summary}`)
    }

    logger.info({ agentId: id, chatId }, 'Subagent completed')
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    // Update DB
    failSubagent(id, errorMsg)

    // Notify user
    if (sendFn) {
      await sendFn(chatId, `Background task failed: ${description}\n\nError: ${errorMsg}`)
    }

    logger.error({ err, agentId: id }, 'Subagent failed')
  } finally {
    runningAgents.delete(id)
  }
}

function generateId(): string {
  return randomBytes(4).toString('hex')
}
