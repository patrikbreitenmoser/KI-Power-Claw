import { mkdirSync, readdirSync, statSync, unlinkSync, createWriteStream } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get } from 'node:https'
import { get as httpGet } from 'node:http'
import { logger } from './logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = resolve(__dirname, '..')
export const UPLOADS_DIR = resolve(PROJECT_ROOT, 'workspace', 'uploads')

/**
 * Download a file from Telegram's servers.
 * 1. Call getFile to get file_path
 * 2. Download from Telegram's file server
 * 3. Save with sanitized filename
 */
export async function downloadMedia(
  botToken: string,
  fileId: string,
  originalFilename?: string
): Promise<string> {
  mkdirSync(UPLOADS_DIR, { recursive: true })

  // Step 1: Get file path from Telegram
  const fileInfo = await fetchJson(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
  )

  if (!fileInfo.ok || !fileInfo.result?.file_path) {
    throw new Error(`Failed to get file info: ${JSON.stringify(fileInfo)}`)
  }

  const remotePath: string = fileInfo.result.file_path
  const ext = remotePath.includes('.') ? remotePath.slice(remotePath.lastIndexOf('.')) : ''
  const safeName = sanitizeFilename(originalFilename ?? `file${ext}`)
  const localPath = resolve(UPLOADS_DIR, `${Date.now()}_${safeName}`)

  // Step 2: Download the file
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${remotePath}`
  await downloadFile(downloadUrl, localPath)

  logger.debug({ localPath, fileId }, 'Downloaded media')
  return localPath
}

/**
 * Build a message for Claude to analyze a photo.
 */
export function buildPhotoMessage(localPath: string, caption?: string): string {
  const parts = [`Please analyze this image at: ${localPath}`]
  if (caption) parts.push(`Caption: ${caption}`)
  return parts.join('\n')
}

/**
 * Build a message for Claude to analyze a document.
 */
export function buildDocumentMessage(
  localPath: string,
  filename: string,
  caption?: string
): string {
  const parts = [`Please analyze this document "${filename}" at: ${localPath}`]
  if (caption) parts.push(`Caption: ${caption}`)
  return parts.join('\n')
}

/**
 * Build a message for Claude to analyze a video via Gemini.
 */
export function buildVideoMessage(localPath: string, caption?: string): string {
  const parts = [
    `A video file has been saved at: ${localPath}`,
    `Please analyze this video. Use GEMINI_API_KEY (or GOOGLE_API_KEY) from this project's .env file with the Gemini API to process the video content.`,
  ]
  if (caption) parts.push(`User's note: ${caption}`)
  return parts.join('\n')
}

/**
 * Delete files older than maxAgeMs (default 24h).
 */
export function cleanupOldUploads(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    mkdirSync(UPLOADS_DIR, { recursive: true })
    const now = Date.now()
    const files = readdirSync(UPLOADS_DIR)
    let cleaned = 0

    for (const file of files) {
      const filePath = resolve(UPLOADS_DIR, file)
      try {
        const stat = statSync(filePath)
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath)
          cleaned++
        }
      } catch {
        // Skip files we can't stat
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up old uploads')
    }
  } catch {
    // Uploads dir might not exist yet
  }
}

// --- Helpers ---

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-')
}

interface TelegramFileResponse {
  ok: boolean
  result?: { file_path?: string }
}

function fetchJson(url: string): Promise<TelegramFileResponse> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()))
        } catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https') ? get : httpGet
    getter(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, dest).then(resolve).catch(reject)
        return
      }
      const ws = createWriteStream(dest)
      res.pipe(ws)
      ws.on('finish', () => {
        ws.close()
        resolve()
      })
      ws.on('error', reject)
    }).on('error', reject)
  })
}
