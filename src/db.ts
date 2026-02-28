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

// --- Helpers ---

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
