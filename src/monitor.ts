import { execSync } from 'node:child_process'
import {
  getSwarmAgents,
  completeSubagent,
  failSubagent,
  updateSwarmAgentPr,
  updateSwarmAgentCi,
  getDailySwarmCost,
} from './db.js'
import { getRepoById } from './repo.js'
import * as tmux from './tmux.js'
import { SWARM_MONITOR_INTERVAL_MS, SWARM_DAILY_BUDGET_USD } from './config.js'
import { logger } from './logger.js'

type SendFn = (chatId: string, text: string) => Promise<void>

let sendFn: SendFn | null = null
let monitorInterval: ReturnType<typeof setInterval> | null = null
let lastFullCheck = 0
let lastCostCheck = 0
let lastDiskCheck = 0

const FULL_CHECK_INTERVAL = 600000   // 10 min -- PR + CI checks
const COST_CHECK_INTERVAL = 300000   // 5 min
const DISK_CHECK_INTERVAL = 1800000  // 30 min
const STALE_THRESHOLD_S = 2700       // 45 min without commits = stale

export function startMonitor(send: SendFn): void {
  sendFn = send

  if (monitorInterval) {
    clearInterval(monitorInterval)
  }

  // Run immediately on startup
  runMonitorCycle().catch(err => logger.error({ err }, 'Initial monitor cycle failed'))

  monitorInterval = setInterval(() => {
    runMonitorCycle().catch(err => logger.error({ err }, 'Monitor cycle failed'))
  }, SWARM_MONITOR_INTERVAL_MS)

  logger.info({ intervalMs: SWARM_MONITOR_INTERVAL_MS }, 'Swarm monitor started')
}

export function stopMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval)
    monitorInterval = null
  }
  logger.info('Swarm monitor stopped')
}

async function runMonitorCycle(): Promise<void> {
  const now = Date.now()
  const agents = getSwarmAgents('running')

  if (agents.length === 0) return

  for (const agent of agents) {
    // Always check: is tmux session alive?
    await checkSessionAlive(agent.id, agent.tmux_session, agent.chat_id, agent.description)
  }

  // Periodic: PR + CI status (every 10 min)
  if (now - lastFullCheck >= FULL_CHECK_INTERVAL) {
    lastFullCheck = now
    for (const agent of getSwarmAgents('running')) {
      await checkPrAndCi(agent.id, agent.branch, agent.repo_id, agent.chat_id, agent.description)
      await checkStaleAgent(agent.id, agent.branch, agent.repo_id, agent.started_at, agent.chat_id, agent.description)
    }
  }

  // Periodic: cost check (every 5 min)
  if (now - lastCostCheck >= COST_CHECK_INTERVAL) {
    lastCostCheck = now
    await checkDailyBudget()
  }
}

async function checkSessionAlive(
  agentId: string,
  tmuxSession: string | null,
  chatId: string,
  description: string
): Promise<void> {
  if (!tmuxSession) return

  if (!tmux.isAlive(tmuxSession)) {
    // Session died -- check if it completed successfully
    const agents = getSwarmAgents()
    const agent = agents.find(a => a.id === agentId)
    if (!agent || agent.status !== 'running') return

    // Check if a PR was created (success indicator)
    if (agent.branch && agent.repo_id) {
      const pr = findPrForBranch(agent.branch, agent.repo_id)
      if (pr) {
        updateSwarmAgentPr(agentId, pr.number, pr.url)
        completeSubagent(agentId, `PR #${pr.number} created: ${pr.url}`)
        await notify(chatId, `Swarm agent done: ${description}\nPR #${pr.number}: ${pr.url}`)
        return
      }
    }

    // Check if branch has commits (partial success)
    if (agent.branch && agent.repo_id) {
      const hasCommits = branchHasCommits(agent.branch, agent.repo_id)
      if (hasCommits) {
        completeSubagent(agentId, 'Agent completed with commits but no PR created')
        await notify(chatId, `Swarm agent done (no PR): ${description}\nBranch: ${agent.branch}`)
        return
      }
    }

    // No PR, no commits -- agent failed
    const lastOutput = tmux.getOutput(tmuxSession, 20)
    failSubagent(agentId, `Session ended without output.\nLast output:\n${lastOutput}`)
    await notify(chatId, `Swarm agent failed: ${description}\nSession ended unexpectedly.`)
  }
}

async function checkPrAndCi(
  agentId: string,
  branch: string | null,
  repoId: string | null,
  chatId: string,
  description: string
): Promise<void> {
  if (!branch || !repoId) return

  const agent = getSwarmAgents().find(a => a.id === agentId)
  if (!agent || agent.status !== 'running') return

  // Check for PR
  if (!agent.pr_number) {
    const pr = findPrForBranch(branch, repoId)
    if (pr) {
      updateSwarmAgentPr(agentId, pr.number, pr.url)
      logger.info({ agentId, prNumber: pr.number }, 'Found PR for swarm agent')
    }
  }

  // Check CI status if PR exists
  if (agent.pr_number) {
    const ci = checkCiStatus(agent.pr_number, repoId)
    if (ci !== agent.ci_status) {
      updateSwarmAgentCi(agentId, ci)

      if (ci === 'passing') {
        // Definition of Done: PR + CI passing + session ended
        if (!tmux.isAlive(agent.tmux_session ?? '')) {
          completeSubagent(agentId, `PR #${agent.pr_number} ready -- CI passing`)
          await notify(chatId, `PR #${agent.pr_number} ready for review: ${description}\nCI: passing`)
        }
      } else if (ci === 'failing') {
        logger.warn({ agentId, prNumber: agent.pr_number }, 'CI failing for swarm agent PR')
      }
    }
  }
}

async function checkStaleAgent(
  agentId: string,
  branch: string | null,
  repoId: string | null,
  startedAt: number,
  chatId: string,
  description: string
): Promise<void> {
  if (!branch || !repoId) return

  const nowS = Math.floor(Date.now() / 1000)
  const runningFor = nowS - startedAt

  if (runningFor < STALE_THRESHOLD_S) return

  // Check for recent commits
  const repo = getRepoById(repoId)
  if (!repo) return

  try {
    const output = execSync(
      `git log --oneline --since="30 minutes ago" "${branch}" 2>/dev/null || true`,
      { cwd: repo.path, stdio: 'pipe', timeout: 5000 }
    ).toString().trim()

    if (!output) {
      await notify(chatId,
        `Swarm agent possibly stale: ${description}\n` +
        `Running for ${Math.floor(runningFor / 60)}min with no recent commits.\n` +
        `Use /swarm output ${agentId} to check or /swarm kill ${agentId} to stop.`
      )
    }
  } catch {
    // git command failed, skip this check
  }
}

async function checkDailyBudget(): Promise<void> {
  const cost = getDailySwarmCost()
  const pct = (cost / SWARM_DAILY_BUDGET_USD) * 100

  if (pct >= 80 && pct < 100) {
    logger.warn({ cost, budget: SWARM_DAILY_BUDGET_USD }, 'Swarm daily budget at 80%+')
  }
}

// --- Git/GitHub helpers ---

function findPrForBranch(branch: string, repoId: string): { number: number; url: string } | null {
  const repo = getRepoById(repoId)
  if (!repo) return null

  try {
    const output = execSync(
      `gh pr list --head "${branch}" --json number,url --limit 1`,
      { cwd: repo.path, stdio: 'pipe', timeout: 15000 }
    ).toString().trim()

    const prs = JSON.parse(output)
    if (prs.length > 0) {
      return { number: prs[0].number, url: prs[0].url }
    }
  } catch {
    // gh CLI not available or failed
  }
  return null
}

function checkCiStatus(prNumber: number, repoId: string): string {
  const repo = getRepoById(repoId)
  if (!repo) return 'none'

  try {
    const output = execSync(
      `gh pr checks ${prNumber} --json name,state 2>/dev/null || echo "[]"`,
      { cwd: repo.path, stdio: 'pipe', timeout: 15000 }
    ).toString().trim()

    const checks = JSON.parse(output)
    if (!Array.isArray(checks) || checks.length === 0) return 'pending'

    const states = checks.map((c: { state: string }) => c.state)
    if (states.every((s: string) => s === 'SUCCESS' || s === 'SKIPPED')) return 'passing'
    if (states.some((s: string) => s === 'FAILURE' || s === 'ERROR')) return 'failing'
    return 'pending'
  } catch {
    return 'none'
  }
}

function branchHasCommits(branch: string, repoId: string): boolean {
  const repo = getRepoById(repoId)
  if (!repo) return false

  try {
    const output = execSync(
      `git log --oneline "${repo.default_branch}..${branch}" 2>/dev/null | head -1`,
      { cwd: repo.path, stdio: 'pipe', timeout: 5000 }
    ).toString().trim()
    return output.length > 0
  } catch {
    return false
  }
}

/**
 * Reconcile swarm agents after a bot restart.
 * Checks for orphaned tmux sessions and updates DB accordingly.
 */
export async function reconcileOnStartup(): Promise<void> {
  const running = getSwarmAgents('running')
  if (running.length === 0) return

  logger.info({ count: running.length }, 'Reconciling swarm agents after restart')

  for (const agent of running) {
    if (!agent.tmux_session) {
      failSubagent(agent.id, 'No tmux session recorded (orphaned)')
      continue
    }

    if (tmux.isAlive(agent.tmux_session)) {
      logger.info({ agentId: agent.id, tmux: agent.tmux_session }, 'Reconnected to running swarm agent')
    } else {
      // Session is dead -- check if it completed
      if (agent.branch && agent.repo_id) {
        const pr = findPrForBranch(agent.branch, agent.repo_id)
        if (pr) {
          updateSwarmAgentPr(agent.id, pr.number, pr.url)
          completeSubagent(agent.id, `PR #${pr.number} (found after restart)`)
          await notify(agent.chat_id, `Swarm agent from before restart completed: ${agent.description}\nPR #${pr.number}: ${pr.url}`)
          continue
        }
      }

      failSubagent(agent.id, 'Session ended while bot was offline')
      await notify(agent.chat_id, `Swarm agent lost during restart: ${agent.description}`)
    }
  }
}

async function notify(chatId: string, message: string): Promise<void> {
  if (!sendFn) return
  try {
    await sendFn(chatId, message)
  } catch (err) {
    logger.error({ err }, 'Failed to send monitor notification')
  }
}
