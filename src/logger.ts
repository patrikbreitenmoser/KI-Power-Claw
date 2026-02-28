import pino from 'pino'
import { readEnvFile } from './env.js'

const VALID_LEVELS = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
])

const envFileLogLevel = readEnvFile(['LOG_LEVEL'])['LOG_LEVEL']
const rawLogLevel = (process.env.LOG_LEVEL ?? envFileLogLevel ?? 'info').toLowerCase()
const resolvedLogLevel = VALID_LEVELS.has(rawLogLevel) ? rawLogLevel : 'info'

export const logger = pino({
  level: resolvedLogLevel,
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})
