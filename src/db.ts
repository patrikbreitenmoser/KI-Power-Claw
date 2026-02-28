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

  logger.info('Database initialized')
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

// --- Helpers ---

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
