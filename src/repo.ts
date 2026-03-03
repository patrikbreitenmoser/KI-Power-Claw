import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { getActiveRepo as dbGetActiveRepo, setActiveRepo as dbSetActiveRepo } from './db.js'
import { logger } from './logger.js'

// --- Types ---

export interface RepoConfig {
  id: string
  name: string
  path: string
  aliases: string[]
  default_branch: string
  is_self?: boolean
  language?: string
  setup_command?: string
  test_command?: string
  notes?: string
}

interface ReposFile {
  workspace_root: string
  repos: RepoConfig[]
}

// --- State ---

let reposConfig: ReposFile | null = null

// --- Loading ---

const REPOS_CONFIG_PATH = resolve(PROJECT_ROOT, 'config', 'repos.json')

export function loadRepos(): ReposFile {
  if (!existsSync(REPOS_CONFIG_PATH)) {
    // Default: just the bot's own repo
    reposConfig = {
      workspace_root: resolve(PROJECT_ROOT, '..', 'agent-workspaces'),
      repos: [
        {
          id: 'kipowerclaw',
          name: 'KI Power Claw',
          path: PROJECT_ROOT,
          aliases: ['bot', 'claw', 'kipowerclaw', 'this', 'self'],
          default_branch: 'main',
          is_self: true,
        },
      ],
    }
    logger.info('No config/repos.json found, using default (self only)')
    return reposConfig
  }

  try {
    const raw = readFileSync(REPOS_CONFIG_PATH, 'utf-8')
    reposConfig = JSON.parse(raw) as ReposFile
    logger.info({ repoCount: reposConfig.repos.length }, 'Loaded repos config')
    return reposConfig
  } catch (err) {
    logger.error({ err }, 'Failed to load repos config, using default')
    reposConfig = {
      workspace_root: resolve(PROJECT_ROOT, '..', 'agent-workspaces'),
      repos: [
        {
          id: 'kipowerclaw',
          name: 'KI Power Claw',
          path: PROJECT_ROOT,
          aliases: ['bot', 'claw', 'kipowerclaw', 'this', 'self'],
          default_branch: 'main',
          is_self: true,
        },
      ],
    }
    return reposConfig
  }
}

export function getReposConfig(): ReposFile {
  if (!reposConfig) return loadRepos()
  return reposConfig
}

// --- Resolution ---

/**
 * Resolve a repo from a user message by matching aliases.
 * Returns null if no repo is explicitly mentioned.
 */
export function resolveRepoFromMessage(message: string): RepoConfig | null {
  const config = getReposConfig()
  const lower = message.toLowerCase()

  // Check for explicit repo mentions: "in the X repo", "on X", "repo X"
  const repoPattern = /(?:in the|in|on|repo|repository|projekt)\s+(\S+)\s*(?:repo|repository|projekt)?/gi
  let match
  while ((match = repoPattern.exec(lower)) !== null) {
    const mentioned = match[1].replace(/['"]/g, '')
    const found = config.repos.find(r =>
      r.aliases.some(a => a.toLowerCase() === mentioned) ||
      r.id.toLowerCase() === mentioned ||
      r.name.toLowerCase() === mentioned
    )
    if (found) return found
  }

  // Check if any alias appears anywhere in the message
  for (const repo of config.repos) {
    if (repo.is_self) continue // Don't match self unless explicit
    for (const alias of repo.aliases) {
      if (lower.includes(alias.toLowerCase())) {
        return repo
      }
    }
  }

  return null
}

/**
 * Get the effective repo for a chat: explicit from message, or active per-chat, or self.
 */
export function getEffectiveRepo(message: string, chatId: string): RepoConfig {
  // 1. Explicit mention in message
  const fromMessage = resolveRepoFromMessage(message)
  if (fromMessage) return fromMessage

  // 2. Per-chat active repo
  const activeRepoId = dbGetActiveRepo(chatId)
  if (activeRepoId) {
    const found = getReposConfig().repos.find(r => r.id === activeRepoId)
    if (found) return found
  }

  // 3. Fall back to self
  return getSelfRepo()
}

export function getSelfRepo(): RepoConfig {
  const config = getReposConfig()
  return config.repos.find(r => r.is_self) ?? config.repos[0]
}

export function getRepoById(id: string): RepoConfig | null {
  return getReposConfig().repos.find(r => r.id === id) ?? null
}

export function listRepos(): RepoConfig[] {
  return getReposConfig().repos
}

export function getWorkspaceRoot(): string {
  const root = getReposConfig().workspace_root
  // Expand ~ to home directory
  if (root.startsWith('~')) {
    return resolve(process.env['HOME'] ?? '/tmp', root.slice(2))
  }
  return root
}

// --- Per-chat repo management ---

export function setActiveChatRepo(chatId: string, repoId: string): boolean {
  const repo = getRepoById(repoId)
  if (!repo) return false
  dbSetActiveRepo(chatId, repoId)
  return true
}

export function getActiveChatRepo(chatId: string): RepoConfig | null {
  const repoId = dbGetActiveRepo(chatId)
  if (!repoId) return null
  return getRepoById(repoId)
}
