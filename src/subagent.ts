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
import { queryMemory } from './memory.js'
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

  // Track in memory for cancellation
  const abortController = new AbortController()
  runningAgents.set(id, { id, chatId, description, abortController })

  // Build full context async, then run
  const personaContext = getPersonaContext()
  queryMemory(prompt).then(memoryPrefix => {
    const fullPrompt = personaContext + (memoryPrefix || '') +
      `[Background task: ${description}]\n\n${prompt}`
    return executeBackground(id, chatId, description, fullPrompt, abortController, model)
  }).catch((err) => {
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

const BACKGROUND_PHRASES = [
  'in the background',
  'im hintergrund',
  'in einem subagent',
  'in einem sub-agent',
  'als subagent',
  'als sub-agent',
  'in a subagent',
  'in a sub-agent',
  'work on this separately',
  'run this in background',
  'background task',
  'do this async',
  'handle this separately',
]

const BACKGROUND_PATTERNS = [
  /\b(?:spawn|start|launch|run|use)\s+(?:a\s+|an\s+)?sub-?agent\b/i,
  /\b(?:starte|start|nutze|verwende)\s+(?:einen\s+|einem\s+)?sub-?agent\b/i,
  /\b(?:do|handle|work on|run)\b[\s\S]{0,40}\b(?:async|asynchronously|separately)\b/i,
  /\b(?:mach|bearbeite|erledige)\b[\s\S]{0,40}\b(?:asynchron|separat)\b/i,
  /\b(?:async|asynchronously|separately)\b[\s\S]{0,40}\b(?:do|handle|work on|run)\b/i,
  /\b(?:asynchron|separat)\b[\s\S]{0,40}\b(?:erledigen|machen|bearbeiten)\b/i,
]

/**
 * Check if a user message indicates they want background processing.
 */
export function detectBackgroundIntent(message: string): boolean {
  const lower = message.toLowerCase()
  if (BACKGROUND_PHRASES.some((kw) => lower.includes(kw))) {
    return true
  }
  return BACKGROUND_PATTERNS.some((pattern) => pattern.test(message))
}

function buildCompletionMessage(description: string, result: string): string {
  const mediaLines = result.match(/^MEDIA:\s*.+$/gm) ?? []
  const textWithoutMedia = result.replace(/^MEDIA:\s*.+$/gm, '').trim()
  const summary = textWithoutMedia.length > 3000
    ? `${textWithoutMedia.slice(0, 3000)}\n\n...(truncated, use /agents <id> to see full result)`
    : textWithoutMedia

  let message = `Background task done: ${description}`
  if (mediaLines.length > 0) {
    message += `\n\n${mediaLines.join('\n')}`
  }
  if (summary) {
    message += `\n\n${summary}`
  }
  return message
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
  abortController: AbortController,
  model?: string
): Promise<void> {
  try {
    // Run agent without session resume (fresh context)
    const { text } = await runAgent(
      fullPrompt,
      undefined,
      undefined,
      model,
      abortController,
      { source: 'subagent', chatId, agentId: id, description }
    )
    const result = text ?? '(no response)'

    // Update DB
    completeSubagent(id, result)

    // Notify user
    if (sendFn) {
      const completionMessage = buildCompletionMessage(description, result)
      try {
        await sendFn(chatId, completionMessage)
      } catch (notifyErr) {
        logger.error({ err: notifyErr, agentId: id }, 'Failed to notify user about completed subagent')
      }
    }

    logger.info({ agentId: id, chatId }, 'Subagent completed')
  } catch (err) {
    if (abortController.signal.aborted) {
      logger.info({ agentId: id }, 'Subagent aborted')
      return
    }

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
