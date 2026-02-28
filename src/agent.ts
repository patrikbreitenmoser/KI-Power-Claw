import { query } from '@anthropic-ai/claude-agent-sdk'
import { PROJECT_ROOT, TYPING_REFRESH_MS } from './config.js'
import { logger } from './logger.js'

export interface AgentResult {
  text: string | null
  newSessionId?: string
}

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  model?: string
): Promise<AgentResult> {
  let newSessionId: string | undefined
  let resultText: string | null = null

  // Keep typing indicator alive while waiting
  let typingInterval: ReturnType<typeof setInterval> | undefined
  if (onTyping) {
    onTyping()
    typingInterval = setInterval(onTyping, TYPING_REFRESH_MS)
  }

  try {
    const response = query({
      prompt: message,
      options: {
        model,
        cwd: PROJECT_ROOT,
        resume: sessionId,
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })

    for await (const event of response) {
      if (event.type === 'system' && event.subtype === 'init') {
        newSessionId = event.session_id
        logger.debug({ sessionId: newSessionId }, 'Session initialized')
      }

      if (event.type === 'result') {
        if (event.subtype === 'success') {
          resultText = event.result
        } else {
          logger.error({ subtype: event.subtype }, 'Agent returned error result')
          resultText = `Error: Claude returned ${event.subtype}`
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Agent execution failed')
    resultText = `Error running Claude: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    if (typingInterval) clearInterval(typingInterval)
  }

  return { text: resultText, newSessionId }
}
