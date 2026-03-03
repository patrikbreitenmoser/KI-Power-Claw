import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(STORE_DIR, { recursive: true })
    db = new Database(resolve(STORE_DIR, 'kipowerclaw.db'))
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
  }
  return db
}

export function initDatabase(): void {
  const d = getDb()

  // Sessions table -- maps chat_id to Claude Code session ID
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Scheduled tasks table
  d.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status_next
    ON scheduled_tasks(status, next_run)
  `)

  // Subagents table -- tracks background agent runs
  d.exec(`
    CREATE TABLE IF NOT EXISTS subagents (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      description TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled')),
      result TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    )
  `)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_subagents_chat_status
    ON subagents(chat_id, status)
  `)

  // Swarm agent columns (migrate existing subagents table)
  migrateSubagentsForSwarm(d)

  // Chat-to-repo mapping for multi-repo support
  d.exec(`
    CREATE TABLE IF NOT EXISTS chat_repos (
      chat_id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  logger.info('Database initialized')
}

function migrateSubagentsForSwarm(d: Database.Database): void {
  // Check which columns exist
  const cols = d.prepare("PRAGMA table_info(subagents)").all() as Array<{ name: string }>
  const existing = new Set(cols.map(c => c.name))

  const migrations: Array<[string, string]> = [
    ['type', "ALTER TABLE subagents ADD COLUMN type TEXT NOT NULL DEFAULT 'sdk'"],
    ['agent_type', "ALTER TABLE subagents ADD COLUMN agent_type TEXT"],
    ['model', "ALTER TABLE subagents ADD COLUMN model TEXT"],
    ['repo_id', "ALTER TABLE subagents ADD COLUMN repo_id TEXT"],
    ['branch', "ALTER TABLE subagents ADD COLUMN branch TEXT"],
    ['worktree_path', "ALTER TABLE subagents ADD COLUMN worktree_path TEXT"],
    ['tmux_session', "ALTER TABLE subagents ADD COLUMN tmux_session TEXT"],
    ['pr_number', "ALTER TABLE subagents ADD COLUMN pr_number INTEGER"],
    ['pr_url', "ALTER TABLE subagents ADD COLUMN pr_url TEXT"],
    ['ci_status', "ALTER TABLE subagents ADD COLUMN ci_status TEXT NOT NULL DEFAULT 'none'"],
    ['retry_count', "ALTER TABLE subagents ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0"],
    ['max_retries', "ALTER TABLE subagents ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3"],
    ['parent_agent_id', "ALTER TABLE subagents ADD COLUMN parent_agent_id TEXT"],
    ['depends_on', "ALTER TABLE subagents ADD COLUMN depends_on TEXT"],
    ['input_tokens', "ALTER TABLE subagents ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0"],
    ['output_tokens', "ALTER TABLE subagents ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0"],
    ['cost_estimate_usd', "ALTER TABLE subagents ADD COLUMN cost_estimate_usd REAL NOT NULL DEFAULT 0.0"],
  ]

  for (const [col, sql] of migrations) {
    if (!existing.has(col)) {
      d.exec(sql)
      logger.debug({ column: col }, 'Migrated subagents table')
    }
  }
}

// --- Session CRUD ---

export function getSession(chatId: string): string | null {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string } | undefined
  return row?.session_id ?? null
}

export function setSession(chatId: string, sessionId: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (chat_id, session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`
    )
    .run(chatId, sessionId, nowSeconds())
}

export function clearSession(chatId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

// --- Scheduler CRUD ---

interface TaskRow {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: string
  created_at: number
}

export function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number
): void {
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    )
    .run(id, chatId, prompt, schedule, nextRun, nowSeconds())
}

export function getDueTasks(): TaskRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run <= ?`
    )
    .all(nowSeconds()) as TaskRow[]
}

export function getAllTasks(): TaskRow[] {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as TaskRow[]
}

export function getTask(id: string): TaskRow | null {
  return (
    (getDb().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as TaskRow | undefined) ??
    null
  )
}

export function updateTaskAfterRun(id: string, result: string, nextRun: number): void {
  getDb()
    .prepare(
      `UPDATE scheduled_tasks SET last_run = ?, last_result = ?, next_run = ? WHERE id = ?`
    )
    .run(nowSeconds(), result, nextRun, id)
}

export function setTaskStatus(id: string, status: 'active' | 'paused'): void {
  getDb().prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?').run(status, id)
}

export function deleteTask(id: string): void {
  getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
}

// --- Subagent CRUD ---

export interface SubagentRow {
  id: string
  chat_id: string
  description: string
  prompt: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  result: string | null
  started_at: number
  finished_at: number | null
  // Swarm fields
  type: 'sdk' | 'swarm'
  agent_type: string | null
  model: string | null
  repo_id: string | null
  branch: string | null
  worktree_path: string | null
  tmux_session: string | null
  pr_number: number | null
  pr_url: string | null
  ci_status: string
  retry_count: number
  max_retries: number
  parent_agent_id: string | null
  depends_on: string | null
  input_tokens: number
  output_tokens: number
  cost_estimate_usd: number
}

export function insertSubagent(
  id: string,
  chatId: string,
  description: string,
  prompt: string
): void {
  getDb()
    .prepare(
      `INSERT INTO subagents (id, chat_id, description, prompt, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`
    )
    .run(id, chatId, description, prompt, nowSeconds())
}

export function completeSubagent(id: string, result: string): void {
  getDb()
    .prepare(
      `UPDATE subagents SET status = 'completed', result = ?, finished_at = ? WHERE id = ?`
    )
    .run(result.slice(0, 10000), nowSeconds(), id)
}

export function failSubagent(id: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE subagents SET status = 'failed', result = ?, finished_at = ? WHERE id = ?`
    )
    .run(error.slice(0, 2000), nowSeconds(), id)
}

export function cancelSubagent(id: string): void {
  getDb()
    .prepare(
      `UPDATE subagents SET status = 'cancelled', finished_at = ? WHERE id = ?`
    )
    .run(nowSeconds(), id)
}

export function getRunningSubagents(chatId: string): SubagentRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM subagents WHERE chat_id = ? AND status = 'running' ORDER BY started_at DESC`
    )
    .all(chatId) as SubagentRow[]
}

export function getRecentSubagents(chatId: string, limit = 10): SubagentRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM subagents WHERE chat_id = ? ORDER BY started_at DESC LIMIT ?`
    )
    .all(chatId, limit) as SubagentRow[]
}

export function getSubagent(id: string): SubagentRow | null {
  return (
    (getDb().prepare('SELECT * FROM subagents WHERE id = ?').get(id) as SubagentRow | undefined) ??
    null
  )
}

export function cleanupOldSubagents(maxAgeSeconds = 7 * 86400): void {
  const cutoff = nowSeconds() - maxAgeSeconds
  const deleted = getDb()
    .prepare('DELETE FROM subagents WHERE finished_at IS NOT NULL AND finished_at < ?')
    .run(cutoff)
  if (deleted.changes > 0) {
    logger.info({ deleted: deleted.changes }, 'Cleaned up old subagent records')
  }
}

// --- Swarm agent CRUD ---

export interface SwarmInsertParams {
  id: string
  chatId: string
  description: string
  prompt: string
  agentType: 'claude-code' | 'codex' | 'gemini'
  model?: string
  repoId?: string
  branch?: string
  worktreePath?: string
  tmuxSession?: string
  dependsOn?: string[]
  parentAgentId?: string
}

export function insertSwarmAgent(params: SwarmInsertParams): void {
  getDb()
    .prepare(
      `INSERT INTO subagents (
        id, chat_id, description, prompt, status, started_at,
        type, agent_type, model, repo_id, branch, worktree_path,
        tmux_session, depends_on, parent_agent_id
      ) VALUES (?, ?, ?, ?, 'running', ?, 'swarm', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.id, params.chatId, params.description, params.prompt, nowSeconds(),
      params.agentType, params.model ?? null, params.repoId ?? null,
      params.branch ?? null, params.worktreePath ?? null,
      params.tmuxSession ?? null,
      params.dependsOn ? JSON.stringify(params.dependsOn) : null,
      params.parentAgentId ?? null
    )
}

export function updateSwarmAgentPr(id: string, prNumber: number, prUrl: string): void {
  getDb()
    .prepare('UPDATE subagents SET pr_number = ?, pr_url = ? WHERE id = ?')
    .run(prNumber, prUrl, id)
}

export function updateSwarmAgentCi(id: string, ciStatus: string): void {
  getDb()
    .prepare('UPDATE subagents SET ci_status = ? WHERE id = ?')
    .run(ciStatus, id)
}

export function updateSwarmAgentCost(id: string, inputTokens: number, outputTokens: number, costUsd: number): void {
  getDb()
    .prepare(
      `UPDATE subagents SET
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        cost_estimate_usd = cost_estimate_usd + ?
       WHERE id = ?`
    )
    .run(inputTokens, outputTokens, costUsd, id)
}

export function incrementRetryCount(id: string): number {
  getDb().prepare('UPDATE subagents SET retry_count = retry_count + 1 WHERE id = ?').run(id)
  const row = getDb().prepare('SELECT retry_count FROM subagents WHERE id = ?').get(id) as { retry_count: number } | undefined
  return row?.retry_count ?? 0
}

export function getSwarmAgents(status?: string, chatId?: string): SubagentRow[] {
  if (status && chatId) {
    return getDb()
      .prepare("SELECT * FROM subagents WHERE type = 'swarm' AND status = ? AND chat_id = ? ORDER BY started_at DESC")
      .all(status, chatId) as SubagentRow[]
  }
  if (status) {
    return getDb()
      .prepare("SELECT * FROM subagents WHERE type = 'swarm' AND status = ? ORDER BY started_at DESC")
      .all(status) as SubagentRow[]
  }
  if (chatId) {
    return getDb()
      .prepare("SELECT * FROM subagents WHERE type = 'swarm' AND chat_id = ? ORDER BY started_at DESC")
      .all(chatId) as SubagentRow[]
  }
  return getDb()
    .prepare("SELECT * FROM subagents WHERE type = 'swarm' ORDER BY started_at DESC")
    .all() as SubagentRow[]
}

/**
 * Get a single swarm agent by ID, optionally enforcing chat ownership.
 * Returns null if not found or if chatId doesn't match.
 */
export function getSwarmAgent(id: string, chatId?: string): SubagentRow | null {
  const row = getDb()
    .prepare("SELECT * FROM subagents WHERE id = ? AND type = 'swarm'")
    .get(id) as SubagentRow | undefined
  if (!row) return null
  if (chatId && row.chat_id !== chatId) return null
  return row
}

export function getBlockedAgents(): SubagentRow[] {
  return getDb()
    .prepare("SELECT * FROM subagents WHERE type = 'swarm' AND status = 'running' AND depends_on IS NOT NULL")
    .all() as SubagentRow[]
}

export function getDailySwarmCost(): number {
  const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(cost_estimate_usd), 0) as total FROM subagents WHERE type = 'swarm' AND started_at >= ?")
    .get(startOfDay) as { total: number }
  return row.total
}

// --- Chat repos CRUD ---

export function getActiveRepo(chatId: string): string | null {
  const row = getDb()
    .prepare('SELECT repo_id FROM chat_repos WHERE chat_id = ?')
    .get(chatId) as { repo_id: string } | undefined
  return row?.repo_id ?? null
}

export function setActiveRepo(chatId: string, repoId: string): void {
  getDb()
    .prepare(
      `INSERT INTO chat_repos (chat_id, repo_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET repo_id = excluded.repo_id, updated_at = excluded.updated_at`
    )
    .run(chatId, repoId, nowSeconds())
}

// --- Helpers ---

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
