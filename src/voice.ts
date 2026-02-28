import { readFileSync, renameSync } from 'node:fs'
import { request } from 'node:https'
import { basename, dirname, resolve } from 'node:path'
import { GROQ_API_KEY } from './config.js'
import { logger } from './logger.js'

/**
 * Transcribe an audio file using Groq Whisper API.
 * Handles the .oga -> .ogg rename (Groq doesn't accept .oga).
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured')
  }

  // Rename .oga to .ogg if needed (same format, Groq is picky about extension)
  let actualPath = filePath
  if (filePath.endsWith('.oga')) {
    actualPath = filePath.replace(/\.oga$/, '.ogg')
    renameSync(filePath, actualPath)
    logger.debug('Renamed .oga to .ogg for Groq compatibility')
  }

  const fileBuffer = readFileSync(actualPath)
  const filename = basename(actualPath)

  // Build multipart/form-data manually (no extra deps)
  const boundary = `----FormBoundary${Date.now()}`
  const parts: Buffer[] = []

  // File part
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`
    )
  )
  parts.push(fileBuffer)
  parts.push(Buffer.from('\r\n'))

  // Model part
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n`
    )
  )

  // Close boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`))

  const body = Buffer.concat(parts)

  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        hostname: 'api.groq.com',
        path: '/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString()
          try {
            const json = JSON.parse(raw)
            if (json.text) {
              resolve(json.text)
            } else if (json.error) {
              reject(new Error(`Groq API error: ${json.error.message ?? raw}`))
            } else {
              reject(new Error(`Unexpected Groq response: ${raw}`))
            }
          } catch {
            reject(new Error(`Failed to parse Groq response: ${raw}`))
          }
        })
      }
    )

    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * Check voice capabilities based on configured API keys.
 */
export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return {
    stt: !!GROQ_API_KEY,
    tts: false, // TTS not enabled in this build
  }
}
