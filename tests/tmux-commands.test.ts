import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for tmux.ts command building and escaping.
 * These test the pure functions (buildClaudeCommand, buildCodexCommand)
 * without needing actual tmux installed.
 */

// Mock config and logger before importing
vi.doMock('../src/config.js', () => ({
  AGENT_LOG_DIR: '/tmp/test-logs',
}))

vi.doMock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

const { buildClaudeCommand, buildCodexCommand } = await import('../src/tmux.js')

describe('buildClaudeCommand', () => {
  it('builds basic command with default model', () => {
    const cmd = buildClaudeCommand('fix the bug')
    expect(cmd).toContain('claude')
    expect(cmd).toContain('--model claude-sonnet-4-6')
    expect(cmd).toContain('--dangerously-skip-permissions')
    expect(cmd).toContain('fix the bug')
  })

  it('uses custom model', () => {
    const cmd = buildClaudeCommand('fix the bug', 'claude-opus-4')
    expect(cmd).toContain('--model claude-opus-4')
  })

  it('escapes single quotes in prompt', () => {
    const cmd = buildClaudeCommand("don't break things")
    // Uses standard shell quote escaping: 'don'\''t'
    expect(cmd).toContain("don'\\''t")
    // The raw unescaped quote should not appear
    expect(cmd).not.toContain("don't break")
  })
})

describe('buildCodexCommand', () => {
  it('builds basic command with default model', () => {
    const cmd = buildCodexCommand('implement feature')
    expect(cmd).toContain('codex')
    expect(cmd).toContain('--model codex-mini')
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(cmd).toContain('implement feature')
  })

  it('uses custom model and effort', () => {
    const cmd = buildCodexCommand('complex task', 'o4-mini', 'medium')
    expect(cmd).toContain('--model o4-mini')
    expect(cmd).toContain('model_reasoning_effort=medium')
  })

  it('escapes single quotes in prompt', () => {
    const cmd = buildCodexCommand("it's important")
    expect(cmd).toContain("it'\\''s")
  })
})
