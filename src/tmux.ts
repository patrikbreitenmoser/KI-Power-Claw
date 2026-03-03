import { execSync, exec } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { AGENT_LOG_DIR } from './config.js'
import { logger } from './logger.js'

// Ensure log directory exists
mkdirSync(AGENT_LOG_DIR, { recursive: true })

/**
 * Create a new tmux session and run a command in it.
 * Also pipes pane output to a log file.
 */
export function createSession(
  sessionName: string,
  cwd: string,
  command: string
): void {
  // Kill existing session with same name if it exists
  if (isAlive(sessionName)) {
    killSession(sessionName)
  }

  const logFile = getLogPath(sessionName)

  // Create detached session running the command
  execSync(
    `tmux new-session -d -s "${sessionName}" -c "${cwd}" "${command}"`,
    { stdio: 'pipe', timeout: 10000 }
  )

  // Pipe pane output to log file
  execSync(
    `tmux pipe-pane -t "${sessionName}" 'cat >> "${logFile}"'`,
    { stdio: 'pipe', timeout: 5000 }
  )

  logger.info({ sessionName, cwd, logFile }, 'Created tmux session')
}

/**
 * Send keystrokes to a tmux session (for mid-task steering).
 */
export function sendKeys(sessionName: string, text: string): void {
  if (!isAlive(sessionName)) {
    throw new Error(`tmux session '${sessionName}' is not alive`)
  }

  execSync(
    `tmux send-keys -t "${sessionName}" "${escapeForTmux(text)}" Enter`,
    { stdio: 'pipe', timeout: 5000 }
  )

  logger.info({ sessionName, text: text.slice(0, 80) }, 'Sent keys to tmux session')
}

/**
 * Check if a tmux session is alive.
 */
export function isAlive(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, {
      stdio: 'pipe',
      timeout: 3000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Get recent output from a tmux session.
 */
export function getOutput(sessionName: string, lines = 100): string {
  if (!isAlive(sessionName)) {
    return '(session not running)'
  }

  try {
    return execSync(
      `tmux capture-pane -t "${sessionName}" -p -S -${lines}`,
      { stdio: 'pipe', timeout: 5000 }
    ).toString()
  } catch {
    return '(failed to capture output)'
  }
}

/**
 * Kill a tmux session.
 */
export function killSession(sessionName: string): void {
  try {
    execSync(`tmux kill-session -t "${sessionName}"`, {
      stdio: 'pipe',
      timeout: 5000,
    })
    logger.info({ sessionName }, 'Killed tmux session')
  } catch {
    logger.debug({ sessionName }, 'tmux session already dead')
  }
}

/**
 * List all active tmux sessions.
 */
export function listSessions(): Array<{ name: string; created: string; attached: boolean }> {
  try {
    const output = execSync(
      'tmux list-sessions -F "#{session_name}|#{session_created}|#{session_attached}"',
      { stdio: 'pipe', timeout: 5000 }
    ).toString().trim()

    if (!output) return []

    return output.split('\n').map(line => {
      const [name, created, attached] = line.split('|')
      return {
        name,
        created: new Date(parseInt(created, 10) * 1000).toISOString(),
        attached: attached === '1',
      }
    })
  } catch {
    return []
  }
}

/**
 * Check if tmux is available on the system.
 */
export function isTmuxAvailable(): boolean {
  try {
    execSync('which tmux', { stdio: 'pipe', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

/**
 * Get the log file path for a session.
 */
export function getLogPath(sessionName: string): string {
  return `${AGENT_LOG_DIR}/${sessionName}.log`
}

/**
 * Wait for a tmux session to finish (polling).
 * Returns true if session ended, false if timeout.
 */
export function waitForSession(
  sessionName: string,
  timeoutMs = 600000,
  pollMs = 5000
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      if (!isAlive(sessionName)) {
        resolve(true)
        return
      }
      if (Date.now() - start > timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(check, pollMs)
    }
    check()
  })
}

/**
 * Build a claude code CLI command for a swarm agent.
 */
export function buildClaudeCommand(prompt: string, model = 'claude-sonnet-4-6'): string {
  // Escape single quotes in prompt for shell
  const escaped = prompt.replace(/'/g, "'\\''")
  return `claude --model ${model} --dangerously-skip-permissions -p '${escaped}'`
}

/**
 * Build a codex CLI command for a swarm agent.
 */
export function buildCodexCommand(prompt: string, model = 'codex-mini', effort = 'high'): string {
  const escaped = prompt.replace(/'/g, "'\\''")
  return `codex --model ${model} -c "model_reasoning_effort=${effort}" --dangerously-bypass-approvals-and-sandbox '${escaped}'`
}

function escapeForTmux(text: string): string {
  // Escape special characters for tmux send-keys
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
}
