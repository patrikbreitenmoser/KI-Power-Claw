import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

/**
 * Tests for swarm-related DB functions.
 * Uses an in-memory SQLite database to avoid touching the real store.
 */

// We test the raw SQL logic by creating a minimal DB and running queries directly
// rather than importing from db.ts (which has side effects).

function createTestDb() {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  db.exec(`
    CREATE TABLE subagents (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      description TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      result TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      type TEXT NOT NULL DEFAULT 'sdk',
      agent_type TEXT,
      model TEXT,
      repo_id TEXT,
      branch TEXT,
      worktree_path TEXT,
      tmux_session TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      ci_status TEXT NOT NULL DEFAULT 'none',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      parent_agent_id TEXT,
      depends_on TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_estimate_usd REAL NOT NULL DEFAULT 0.0
    )
  `)

  return db
}

function insertAgent(db: Database.Database, overrides: Record<string, unknown> = {}) {
  const defaults = {
    id: 'agent-1',
    chat_id: 'chat-100',
    description: 'Test agent',
    prompt: 'do something',
    status: 'running',
    started_at: Math.floor(Date.now() / 1000),
    type: 'swarm',
    agent_type: 'claude-code',
    tmux_session: 'swarm-agent-1',
    depends_on: null,
  }
  const merged = { ...defaults, ...overrides }
  db.prepare(`
    INSERT INTO subagents (id, chat_id, description, prompt, status, started_at, type, agent_type, tmux_session, depends_on)
    VALUES (@id, @chat_id, @description, @prompt, @status, @started_at, @type, @agent_type, @tmux_session, @depends_on)
  `).run(merged)
}

describe('getSwarmAgents with chatId filter', () => {
  it('returns all swarm agents when no filters', () => {
    const db = createTestDb()
    insertAgent(db, { id: 'a1', chat_id: 'chat-1' })
    insertAgent(db, { id: 'a2', chat_id: 'chat-2' })
    insertAgent(db, { id: 'a3', chat_id: 'chat-1', type: 'sdk' }) // not swarm

    const rows = db.prepare("SELECT * FROM subagents WHERE type = 'swarm' ORDER BY started_at DESC").all()
    expect(rows).toHaveLength(2)
  })

  it('filters by chatId', () => {
    const db = createTestDb()
    insertAgent(db, { id: 'a1', chat_id: 'chat-1' })
    insertAgent(db, { id: 'a2', chat_id: 'chat-2' })
    insertAgent(db, { id: 'a3', chat_id: 'chat-1' })

    const rows = db.prepare("SELECT * FROM subagents WHERE type = 'swarm' AND chat_id = ?").all('chat-1')
    expect(rows).toHaveLength(2)
  })

  it('filters by status and chatId', () => {
    const db = createTestDb()
    insertAgent(db, { id: 'a1', chat_id: 'chat-1', status: 'running' })
    insertAgent(db, { id: 'a2', chat_id: 'chat-1', status: 'completed' })
    insertAgent(db, { id: 'a3', chat_id: 'chat-2', status: 'running' })

    const rows = db.prepare(
      "SELECT * FROM subagents WHERE type = 'swarm' AND status = ? AND chat_id = ?"
    ).all('running', 'chat-1')
    expect(rows).toHaveLength(1)
    expect((rows[0] as any).id).toBe('a1')
  })
})

describe('getSwarmAgent with chat ownership', () => {
  it('returns agent when chatId matches', () => {
    const db = createTestDb()
    insertAgent(db, { id: 'a1', chat_id: 'chat-1' })

    const row = db.prepare("SELECT * FROM subagents WHERE id = ? AND type = 'swarm'").get('a1') as any
    expect(row).toBeTruthy()
    expect(row.chat_id).toBe('chat-1')
  })

  it('enforces chat ownership (simulated)', () => {
    const db = createTestDb()
    insertAgent(db, { id: 'a1', chat_id: 'chat-1' })

    const row = db.prepare("SELECT * FROM subagents WHERE id = ? AND type = 'swarm'").get('a1') as any
    // Simulate the getSwarmAgent logic: reject if chatId doesn't match
    const requestingChatId = 'chat-999'
    const result = row && row.chat_id !== requestingChatId ? null : row
    expect(result).toBeNull()
  })

  it('returns null for non-existent agent', () => {
    const db = createTestDb()
    const row = db.prepare("SELECT * FROM subagents WHERE id = ? AND type = 'swarm'").get('nonexistent')
    expect(row).toBeUndefined()
  })
})

describe('depends_on empty array handling', () => {
  it('stores null for empty depends_on array', () => {
    const dependsOn: string[] = []
    const value = dependsOn?.length ? JSON.stringify(dependsOn) : null
    expect(value).toBeNull()
  })

  it('stores JSON for non-empty depends_on array', () => {
    const dependsOn = ['agent-1', 'agent-2']
    const value = dependsOn?.length ? JSON.stringify(dependsOn) : null
    expect(value).toBe('["agent-1","agent-2"]')
  })

  it('stores null for undefined depends_on', () => {
    const dependsOn: string[] | undefined = undefined
    const value = dependsOn?.length ? JSON.stringify(dependsOn) : null
    expect(value).toBeNull()
  })

  it('getBlockedAgents query skips null depends_on', () => {
    const db = createTestDb()
    insertAgent(db, { id: 'a1', depends_on: null })
    insertAgent(db, { id: 'a2', depends_on: '["agent-0"]' })

    const blocked = db.prepare(
      "SELECT * FROM subagents WHERE type = 'swarm' AND status = 'running' AND depends_on IS NOT NULL"
    ).all()
    expect(blocked).toHaveLength(1)
    expect((blocked[0] as any).id).toBe('a2')
  })
})
