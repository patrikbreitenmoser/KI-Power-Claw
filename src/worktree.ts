import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { getWorkspaceRoot } from './repo.js'
import { logger } from './logger.js'

export interface WorktreeInfo {
  path: string
  branch: string
  repoId: string
}

/**
 * Create a git worktree for an agent. Returns the worktree path.
 *
 * Worktrees are created at: {workspace_root}/{repoId}/worktrees/{agentId}
 * with a new branch: agent/{agentId}
 */
export function createWorktree(
  repoPath: string,
  repoId: string,
  agentId: string,
  baseBranch = 'main'
): WorktreeInfo {
  const workspaceRoot = getWorkspaceRoot()
  const worktreeDir = resolve(workspaceRoot, repoId, 'worktrees')
  const worktreePath = resolve(worktreeDir, agentId)
  const branch = `agent/${agentId}`

  mkdirSync(worktreeDir, { recursive: true })

  if (existsSync(worktreePath)) {
    logger.warn({ worktreePath }, 'Worktree already exists, removing first')
    removeWorktree(repoPath, worktreePath)
  }

  // Fetch latest from remote to ensure base branch is up-to-date
  try {
    execSync(`git fetch origin ${baseBranch}`, {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 30000,
    })
  } catch {
    logger.warn('Failed to fetch from remote, using local base branch')
  }

  // Create worktree with new branch based on origin/baseBranch or local baseBranch
  const baseRef = branchExistsRemote(repoPath, baseBranch)
    ? `origin/${baseBranch}`
    : baseBranch

  execSync(`git worktree add "${worktreePath}" -b "${branch}" "${baseRef}"`, {
    cwd: repoPath,
    stdio: 'pipe',
    timeout: 30000,
  })

  // Symlink gitignored env files so the agent has access to secrets
  symlinkEnvFiles(repoPath, worktreePath)

  logger.info({ worktreePath, branch, repoId }, 'Created worktree')
  return { path: worktreePath, branch, repoId }
}

/**
 * Remove a git worktree and its branch.
 */
export function removeWorktree(repoPath: string, worktreePath: string): void {
  try {
    // Get branch name before removing
    let branch: string | null = null
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: worktreePath,
        stdio: 'pipe',
        timeout: 5000,
      }).toString().trim()
    } catch {
      // Worktree might already be broken
    }

    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 15000,
    })

    // Clean up the branch if it was an agent branch
    if (branch && branch.startsWith('agent/')) {
      try {
        execSync(`git branch -D "${branch}"`, {
          cwd: repoPath,
          stdio: 'pipe',
          timeout: 5000,
        })
      } catch {
        // Branch might already be gone
      }
    }

    logger.info({ worktreePath }, 'Removed worktree')
  } catch (err) {
    // Force cleanup if git worktree remove fails
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true })
      // Prune stale worktree references
      try {
        execSync('git worktree prune', { cwd: repoPath, stdio: 'pipe', timeout: 5000 })
      } catch {
        // Best effort
      }
    }
    logger.warn({ err, worktreePath }, 'Force-removed worktree')
  }
}

/**
 * List all active worktrees for a repo.
 */
export function listWorktrees(repoPath: string): Array<{ path: string; branch: string }> {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 5000,
    }).toString()

    const worktrees: Array<{ path: string; branch: string }> = []
    let currentPath = ''

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice(9)
      } else if (line.startsWith('branch ') && currentPath) {
        const branch = line.slice(7).replace('refs/heads/', '')
        worktrees.push({ path: currentPath, branch })
        currentPath = ''
      }
    }

    return worktrees
  } catch {
    return []
  }
}

/**
 * Clean up orphaned worktrees (agent worktrees with no matching running agent).
 */
export function cleanupOrphanedWorktrees(repoPath: string, repoId: string, runningAgentIds: Set<string>): number {
  const workspaceRoot = getWorkspaceRoot()
  const worktreeDir = resolve(workspaceRoot, repoId, 'worktrees')

  if (!existsSync(worktreeDir)) return 0

  let cleaned = 0
  const worktrees = listWorktrees(repoPath)

  for (const wt of worktrees) {
    // Only clean agent worktrees
    if (!wt.branch.startsWith('agent/')) continue
    const agentId = wt.branch.replace('agent/', '')

    if (!runningAgentIds.has(agentId)) {
      removeWorktree(repoPath, wt.path)
      cleaned++
    }
  }

  if (cleaned > 0) {
    logger.info({ repoId, cleaned }, 'Cleaned up orphaned worktrees')
  }
  return cleaned
}

/**
 * Install dependencies in a worktree.
 */
export function installDependencies(worktreePath: string, setupCommand?: string): void {
  const command = setupCommand ?? detectSetupCommand(worktreePath)
  if (!command) {
    logger.debug({ worktreePath }, 'No setup command detected, skipping install')
    return
  }

  logger.info({ worktreePath, command }, 'Installing dependencies')
  execSync(command, {
    cwd: worktreePath,
    stdio: 'pipe',
    timeout: 120000, // 2 minutes
    env: { ...process.env, CI: '1' },
  })
}

function detectSetupCommand(path: string): string | null {
  if (existsSync(resolve(path, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile'
  if (existsSync(resolve(path, 'package-lock.json'))) return 'npm ci'
  if (existsSync(resolve(path, 'yarn.lock'))) return 'yarn install --frozen-lockfile'
  if (existsSync(resolve(path, 'bun.lockb'))) return 'bun install'
  if (existsSync(resolve(path, 'pyproject.toml'))) return 'uv sync'
  if (existsSync(resolve(path, 'requirements.txt'))) return 'pip install -r requirements.txt'
  if (existsSync(resolve(path, 'go.mod'))) return 'go mod download'
  if (existsSync(resolve(path, 'Gemfile.lock'))) return 'bundle install'
  return null
}

/**
 * Symlink .env files from the source repo into the worktree.
 * Agents need API keys/secrets but .env is gitignored so worktrees don't get it.
 * Symlinks keep things in sync without duplication.
 */
const ENV_FILE_PATTERNS = ['.env', '.env.local', '.env.development', '.env.development.local']

function symlinkEnvFiles(repoPath: string, worktreePath: string): void {
  for (const name of ENV_FILE_PATTERNS) {
    const source = resolve(repoPath, name)
    const target = resolve(worktreePath, name)

    if (existsSync(source) && !existsSync(target)) {
      try {
        symlinkSync(source, target)
        logger.debug({ file: name }, 'Symlinked env file into worktree')
      } catch (err) {
        logger.warn({ err, file: name }, 'Failed to symlink env file')
      }
    }
  }
}

function branchExistsRemote(repoPath: string, branch: string): boolean {
  try {
    execSync(`git rev-parse --verify origin/${branch}`, {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 5000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Get disk usage for all worktrees of a repo, in bytes.
 */
export function getWorktreeDiskUsage(repoId: string): number {
  const workspaceRoot = getWorkspaceRoot()
  const worktreeDir = resolve(workspaceRoot, repoId, 'worktrees')

  if (!existsSync(worktreeDir)) return 0

  try {
    const output = execSync(`du -sb "${worktreeDir}"`, {
      stdio: 'pipe',
      timeout: 10000,
    }).toString()
    return parseInt(output.split('\t')[0], 10) || 0
  } catch {
    return 0
  }
}
