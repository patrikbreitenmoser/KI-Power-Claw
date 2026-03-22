import { query } from '@anthropic-ai/claude-agent-sdk'
import { PROJECT_ROOT, TYPING_REFRESH_MS } from './config.js'
import { readEnvFile } from './env.js'
import { logger } from './logger.js'
import { writeAgentTrace, type AgentTraceContext } from './agent-trace.js'

export interface AgentResult {
  text: string | null
  newSessionId?: string
}

type AgentRunStatus = 'success' | 'error'

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  model?: string,
  abortController?: AbortController,
  traceContext?: AgentTraceContext,
  systemPrompt?: string
): Promise<AgentResult> {
  let newSessionId: string | undefined
  let resultText: string | null = null
  let status: AgentRunStatus = 'success'
  let errorText: string | undefined
  const startedAt = Date.now()

  // Keep typing indicator alive while waiting
  let typingInterval: ReturnType<typeof setInterval> | undefined
  if (onTyping) {
    onTyping()
    typingInterval = setInterval(onTyping, TYPING_REFRESH_MS)
  }

  try {
    const forwardedEnv = buildAgentEnv()
    const response = query({
      prompt: message,
      options: {
        model,
        cwd: PROJECT_ROOT,
        env: forwardedEnv,
        resume: sessionId,
        abortController,
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        ...(systemPrompt && !sessionId ? { systemPrompt } : {}),
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
          status = 'error'
          errorText = `Claude returned ${event.subtype}`
          logger.error({ subtype: event.subtype }, 'Agent returned error result')
          resultText = `Error: Claude returned ${event.subtype}`
        }
      }
    }
  } catch (err) {
    status = 'error'
    errorText = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'Agent execution failed')
    resultText = `Error running Claude: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    if (typingInterval) clearInterval(typingInterval)
    await writeAgentTrace({
      prompt: message,
      resultText,
      model,
      sessionId,
      newSessionId,
      status,
      error: errorText,
      durationMs: Date.now() - startedAt,
      context: traceContext,
    })
  }

  return { text: resultText, newSessionId }
}

function buildAgentEnv(): Record<string, string | undefined> {
  const envFromFile = readEnvFile()
  return {
    ...process.env,
    ...envFromFile,
  }
}
