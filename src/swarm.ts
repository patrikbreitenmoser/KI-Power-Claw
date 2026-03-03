import { randomBytes } from 'node:crypto'
import { writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  insertSwarmAgent,
  completeSubagent,
  failSubagent,
  getSwarmAgents,
  getSwarmAgent,
  getDailySwarmCost,
  type SwarmInsertParams,
} from './db.js'
import { getRepoById, getSelfRepo, getWorkspaceRoot, type RepoConfig } from './repo.js'
import { createWorktree, removeWorktree, installDependencies, type WorktreeInfo } from './worktree.js'
import * as tmux from './tmux.js'
import { getPersonaContext } from './persona.js'
import { queryMemory } from './memory.js'
import {
  MAX_CONCURRENT_SWARM_AGENTS,
  SWARM_AGENT_BUDGET_USD,
  SWARM_DAILY_BUDGET_USD,
  PROJECT_ROOT,
} from './config.js'
import { logger } from './logger.js'

// --- Types ---

export type SwarmAgentType = 'claude-code' | 'codex' | 'gemini'

export interface SpawnSwarmParams {
  chatId: string
  description: string
  prompt: string
  agentType?: SwarmAgentType
  model?: string
  repoId?: string
  dependsOn?: string[]
  parentAgentId?: string
  skipInstall?: boolean
}

export interface SpawnResult {
  id: string
  branch: string
  tmuxSession: string
  worktreePath: string
}

type SendFn = (chatId: string, text: string) => Promise<void>

// --- State ---

let sendFn: SendFn | null = null

// --- Init ---

export function initSwarmSystem(send: SendFn): void {
  sendFn = send

  if (!tmux.isTmuxAvailable()) {
    logger.warn('tmux is not available -- swarm agents will not work')
    return
  }

  logger.info('Swarm system initialized')
}

// --- Public API ---

/**
 * Spawn a swarm agent in its own worktree with a tmux session.
 * Returns immediately with agent metadata.
 */
export async function spawnSwarmAgent(params: SpawnSwarmParams): Promise<SpawnResult> {
  const agentType = params.agentType ?? 'claude-code'
  const id = generateId()
  const tmuxSession = `swarm-${id}`

  // Pre-flight checks
  preflight(params.chatId)

  // Resolve repo
  const repo = params.repoId ? getRepoById(params.repoId) : getSelfRepo()
  if (!repo) throw new Error(`Repo not found: ${params.repoId}`)

  let worktree: WorktreeInfo | null = null

  try {
    // 1. Create worktree
    worktree = createWorktree(repo.path, repo.id, id, repo.default_branch)

    // 2. Install dependencies
    if (!params.skipInstall) {
      try {
        installDependencies(worktree.path, repo.setup_command)
      } catch (err) {
        logger.warn({ err, worktreePath: worktree.path }, 'Dependency install failed, continuing anyway')
      }
    }

    // 3. Write AGENTS.md with task context
    writeAgentsMd(worktree.path, params, repo)

    // 4. Build prompt with full context
    const fullPrompt = await buildSwarmPrompt(params, repo)

    // 5. Build CLI command
    const command = buildCommand(agentType, fullPrompt, params.model)

    // 6. Register in DB
    const dbParams: SwarmInsertParams = {
      id,
      chatId: params.chatId,
      description: params.description,
      prompt: params.prompt,
      agentType,
      model: params.model,
      repoId: repo.id,
      branch: worktree.branch,
      worktreePath: worktree.path,
      tmuxSession,
      dependsOn: params.dependsOn,
      parentAgentId: params.parentAgentId,
    }
    insertSwarmAgent(dbParams)

    // 7. Launch tmux session
    tmux.createSession(tmuxSession, worktree.path, command)

    logger.info({ id, agentType, repo: repo.id, branch: worktree.branch }, 'Swarm agent spawned')

    return {
      id,
      branch: worktree.branch,
      tmuxSession,
      worktreePath: worktree.path,
    }
  } catch (err) {
    // Transactional rollback
    logger.error({ err, id }, 'Failed to spawn swarm agent, rolling back')

    if (tmux.isAlive(tmuxSession)) {
      tmux.killSession(tmuxSession)
    }
    if (worktree) {
      removeWorktree(repo.path, worktree.path)
    }

    throw err
  }
}

/**
 * Steer a running swarm agent by sending text to its tmux session.
 * Enforces chat ownership -- only the chat that spawned the agent can steer it.
 */
export function steerAgent(agentId: string, chatId: string, message: string): boolean {
  const agent = getSwarmAgent(agentId, chatId)
  if (!agent || agent.status !== 'running' || !agent.tmux_session) return false

  tmux.sendKeys(agent.tmux_session, message)
  return true
}

/**
 * Get recent output from a swarm agent's tmux session.
 * Enforces chat ownership -- only the chat that spawned the agent can read its output.
 */
export function getAgentOutput(agentId: string, chatId: string, lines = 50): string {
  const agent = getSwarmAgent(agentId, chatId)
  if (!agent?.tmux_session) return '(agent not found or access denied)'

  return tmux.getOutput(agent.tmux_session, lines)
}

/**
 * Kill a swarm agent and clean up its resources.
 * Enforces chat ownership -- only the chat that spawned the agent can kill it.
 */
export function killSwarmAgent(agentId: string, chatId: string): boolean {
  const agent = getSwarmAgent(agentId, chatId)
  if (!agent) return false

  if (agent.tmux_session && tmux.isAlive(agent.tmux_session)) {
    tmux.killSession(agent.tmux_session)
  }

  failSubagent(agentId, 'Killed by user')

  // Don't remove worktree immediately -- might want to inspect it
  logger.info({ agentId, chatId }, 'Swarm agent killed')
  return true
}

/**
 * Get count of currently running swarm agents.
 * Without chatId returns global count (used by preflight/monitor).
 * With chatId returns count scoped to that chat.
 */
export function runningSwarmCount(chatId?: string): number {
  return getSwarmAgents('running', chatId).length
}

/**
 * List swarm agents with their current status, scoped to a chat.
 */
export function listSwarmAgents(chatId: string, limit = 20): Array<{
  id: string
  status: string
  description: string
  agentType: string | null
  repoId: string | null
  branch: string | null
  prNumber: number | null
  ciStatus: string
  costUsd: number
  startedAt: number
}> {
  return getSwarmAgents(undefined, chatId)
    .slice(0, limit)
    .map(a => ({
      id: a.id,
      status: a.status,
      description: a.description,
      agentType: a.agent_type,
      repoId: a.repo_id,
      branch: a.branch,
      prNumber: a.pr_number,
      ciStatus: a.ci_status,
      costUsd: a.cost_estimate_usd,
      startedAt: a.started_at,
    }))
}

// --- Internal ---

function preflight(chatId: string): void {
  // Check concurrent limit
  const running = runningSwarmCount()
  if (running >= MAX_CONCURRENT_SWARM_AGENTS) {
    throw new Error(
      `Agent limit reached (${running}/${MAX_CONCURRENT_SWARM_AGENTS}). ` +
      `Wait for an agent to finish or increase MAX_CONCURRENT_SWARM_AGENTS.`
    )
  }

  // Check daily budget
  const dailyCost = getDailySwarmCost()
  if (dailyCost >= SWARM_DAILY_BUDGET_USD) {
    throw new Error(
      `Daily budget exhausted ($${dailyCost.toFixed(2)}/$${SWARM_DAILY_BUDGET_USD.toFixed(2)}). ` +
      `Increase SWARM_DAILY_BUDGET_USD to continue.`
    )
  }

  // Check tmux
  if (!tmux.isTmuxAvailable()) {
    throw new Error('tmux is not installed. Install it with: brew install tmux')
  }
}

async function buildSwarmPrompt(params: SpawnSwarmParams, repo: RepoConfig): Promise<string> {
  const parts: string[] = []

  // Persona context
  const persona = getPersonaContext()
  if (persona) parts.push(persona)

  // Memory context
  try {
    const memory = await queryMemory(params.prompt)
    if (memory) parts.push(memory)
  } catch {
    // Memory query failure is non-fatal
  }

  // Repo context
  if (repo.notes) {
    parts.push(`[Repository: ${repo.name}]\n${repo.notes}`)
  }

  // Task description
  parts.push(`[Swarm Task: ${params.description}]`)
  parts.push(params.prompt)

  // Agent instructions
  parts.push(buildAgentInstructions(params, repo))

  return parts.join('\n\n')
}

function buildAgentInstructions(params: SpawnSwarmParams, repo: RepoConfig): string {
  const lines = [
    '[Agent Instructions]',
    'You are a swarm agent working on an isolated git branch.',
    `Repository: ${repo.name} (${repo.id})`,
    `Branch: agent/${params.chatId ? 'swarm' : 'task'}`,
    '',
    'When you are done with your task:',
    '1. Commit all changes with a clear commit message',
    '2. Push your branch: git push -u origin HEAD',
    `3. Create a PR: gh pr create --base ${repo.default_branch} --fill`,
    '',
    'Rules:',
    '- NEVER force-push or delete branches',
    '- NEVER modify .env files or credentials',
    '- Run tests before creating the PR if a test command exists',
  ]

  if (repo.test_command) {
    lines.push(`- Test command: ${repo.test_command}`)
  }

  return lines.join('\n')
}

function writeAgentsMd(worktreePath: string, params: SpawnSwarmParams, repo: RepoConfig): void {
  const content = [
    '# Agent Context',
    '',
    `Task: ${params.description}`,
    `Agent Type: ${params.agentType ?? 'claude-code'}`,
    `Repository: ${repo.name}`,
    `Base Branch: ${repo.default_branch}`,
    '',
    '## Instructions',
    '',
    params.prompt,
    '',
    '## Constraints',
    '',
    '- Complete the task and create a PR when done',
    '- Do not modify files outside the scope of the task',
    '- Run tests before creating the PR',
    '- Never force-push or delete branches',
  ].join('\n')

  writeFileSync(resolve(worktreePath, 'AGENTS.md'), content)
}

function buildCommand(agentType: SwarmAgentType, prompt: string, model?: string): string {
  switch (agentType) {
    case 'claude-code':
      return tmux.buildClaudeCommand(prompt, model ?? 'claude-sonnet-4-6')
    case 'codex':
      return tmux.buildCodexCommand(prompt, model ?? 'codex-mini')
    case 'gemini':
      // Gemini doesn't have a CLI agent yet -- use Claude Code with Gemini API
      return tmux.buildClaudeCommand(
        `Use the Gemini API (GOOGLE_API_KEY is available in .env) for this task.\n\n${prompt}`,
        model ?? 'claude-sonnet-4-6'
      )
    default:
      return tmux.buildClaudeCommand(prompt)
  }
}

function generateId(): string {
  return randomBytes(4).toString('hex')
}
