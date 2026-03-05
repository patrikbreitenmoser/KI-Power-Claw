import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

let cached: Record<string, string> | null = null

export function readEnvFile(keys?: string[]): Record<string, string> {
  if (cached) {
    if (!keys) return { ...cached }
    const filtered: Record<string, string> = {}
    for (const k of keys) {
      if (k in cached) filtered[k] = cached[k]
    }
    return filtered
  }

  const envPath = resolve(PROJECT_ROOT, '.env')
  let raw: string
  try {
    raw = readFileSync(envPath, 'utf-8')
  } catch {
    cached = {}
    return {}
  }

  const result: Record<string, string> = {}

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue

    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    result[key] = value
  }

  cached = result

  if (!keys) return { ...result }
  const filtered: Record<string, string> = {}
  for (const k of keys) {
    if (k in result) filtered[k] = result[k]
  }
  return filtered
}

export function clearEnvCache(): void {
  cached = null
}

export async function upsertEnvValue(key: string, value: string): Promise<void> {
  const envPath = resolve(PROJECT_ROOT, '.env')
  let raw = ''

  try {
    raw = await readFile(envPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const lines = raw.length > 0 ? raw.split(/\r?\n/) : []
  let found = false
  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true
      return `${key}=${value}`
    }
    return line
  })

  if (!found) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== '') {
      nextLines.push('')
    }
    nextLines.push(`${key}=${value}`)
  }

  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
    nextLines.pop()
  }

  await writeFile(envPath, nextLines.join('\n') + '\n', 'utf-8')

  cached = null
}
