import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for repo.ts resolution logic.
 * We test the pure functions by mocking the config state.
 */

// Mock config and db before importing repo
vi.doMock('../src/config.js', () => ({
  PROJECT_ROOT: '/test/project',
}))

vi.doMock('../src/db.js', () => ({
  getActiveRepo: vi.fn().mockReturnValue(null),
  setActiveRepo: vi.fn(),
}))

vi.doMock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// Now import the module
const { resolveRepoFromMessage, getWorkspaceRoot, getReposConfig } = await import('../src/repo.js')

describe('resolveRepoFromMessage', () => {
  it('returns null when no repo is mentioned', () => {
    const result = resolveRepoFromMessage('fix the bug')
    expect(result).toBeNull()
  })

  // Note: resolveRepoFromMessage depends on loaded config state.
  // Since we can't easily inject test repos without the full loadRepos flow,
  // we test the pattern matching logic indirectly.
  it('does not match self repo by default without explicit mention', () => {
    // The self repo has is_self: true and should be skipped in alias scan
    const result = resolveRepoFromMessage('work on the bot')
    // With default config (self only, is_self=true), aliases are skipped
    expect(result).toBeNull()
  })
})

describe('getWorkspaceRoot', () => {
  it('returns workspace root from config', () => {
    // getWorkspaceRoot reads from the loaded config
    const root = getWorkspaceRoot()
    expect(typeof root).toBe('string')
    expect(root.length).toBeGreaterThan(0)
  })
})
