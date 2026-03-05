import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSendFn } from '../src/bot.ts'

const tempDirs: string[] = []

function createTempMediaFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kipowerclaw-send-test-'))
  tempDirs.push(dir)
  const path = resolve(dir, name)
  writeFileSync(path, 'image-bytes')
  return path
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('createSendFn', () => {
  it('sends media first and formatted text afterwards', async () => {
    const fileA = createTempMediaFile('a.png')
    const fileB = createTempMediaFile('b.png')
    const sendPhoto = vi.fn().mockResolvedValue(undefined)
    const sendDocument = vi.fn().mockResolvedValue(undefined)
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const bot = { api: { sendPhoto, sendDocument, sendMessage } } as any
    const sendFn = createSendFn(bot)

    await sendFn(
      '123',
      `MEDIA: ${fileA}\nMEDIA: ${fileB}\n\nHello **World** from scheduler output`
    )

    expect(sendPhoto).toHaveBeenCalledTimes(2)
    expect(sendPhoto.mock.calls[0][0]).toBe(123)
    expect(sendPhoto.mock.calls[1][0]).toBe(123)
    expect(sendDocument).not.toHaveBeenCalled()

    expect(sendMessage).toHaveBeenCalled()
    expect(sendMessage.mock.calls[0][0]).toBe(123)
    expect(String(sendMessage.mock.calls[0][1])).toContain('<b>World</b>')
    expect(sendMessage.mock.calls[0][2]).toEqual({ parse_mode: 'HTML' })
  })

  it('falls back to plain text when html send fails', async () => {
    const sendPhoto = vi.fn().mockResolvedValue(undefined)
    const sendDocument = vi.fn().mockResolvedValue(undefined)
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('html parse error'))
      .mockResolvedValue(undefined)
    const bot = { api: { sendPhoto, sendDocument, sendMessage } } as any
    const sendFn = createSendFn(bot)

    await sendFn('321', 'Hello **World**')

    expect(sendPhoto).not.toHaveBeenCalled()
    expect(sendDocument).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(String(sendMessage.mock.calls[0][1])).toContain('<b>World</b>')
    expect(String(sendMessage.mock.calls[1][1])).toBe('Hello World')
  })

  it('does not send text when payload contains only media lines', async () => {
    const filePath = createTempMediaFile('image-only.png')
    const sendPhoto = vi.fn().mockResolvedValue(undefined)
    const sendDocument = vi.fn().mockResolvedValue(undefined)
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const bot = { api: { sendPhoto, sendDocument, sendMessage } } as any
    const sendFn = createSendFn(bot)

    await sendFn('999', `MEDIA: ${filePath}`)

    expect(sendPhoto).toHaveBeenCalledTimes(1)
    expect(sendDocument).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('falls back to sending the media as a document when photo upload fails', async () => {
    const filePath = createTempMediaFile('document-fallback.png')
    const sendPhoto = vi.fn().mockRejectedValue(new Error('unsupported photo'))
    const sendDocument = vi.fn().mockResolvedValue(undefined)
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const bot = { api: { sendPhoto, sendDocument, sendMessage } } as any
    const sendFn = createSendFn(bot)

    await sendFn('777', `MEDIA: ${filePath}`)

    expect(sendPhoto).toHaveBeenCalledTimes(1)
    expect(sendDocument).toHaveBeenCalledTimes(1)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('sends a fallback message when media delivery fails completely', async () => {
    const filePath = createTempMediaFile('broken.png')
    const sendPhoto = vi.fn().mockRejectedValue(new Error('photo failed'))
    const sendDocument = vi.fn().mockRejectedValue(new Error('document failed'))
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const bot = { api: { sendPhoto, sendDocument, sendMessage } } as any
    const sendFn = createSendFn(bot)

    await sendFn('777', `MEDIA: ${filePath}`)

    expect(sendPhoto).toHaveBeenCalledTimes(1)
    expect(sendDocument).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String(sendMessage.mock.calls[0][1])).toContain('Could not send generated media file')
    expect(String(sendMessage.mock.calls[0][1])).toContain(filePath)
  })

  it('normalizes quoted relative media paths', async () => {
    const sendPhoto = vi.fn().mockResolvedValue(undefined)
    const sendDocument = vi.fn().mockResolvedValue(undefined)
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const bot = { api: { sendPhoto, sendDocument, sendMessage } } as any
    const sendFn = createSendFn(bot)

    const relativePath = 'workspace/generated.png'
    const absolutePath = resolve(process.cwd(), relativePath)
    writeFileSync(absolutePath, 'image-bytes')

    try {
      await sendFn('888', `MEDIA: "${relativePath}"`)
    } finally {
      rmSync(absolutePath, { force: true })
    }

    expect(sendPhoto).toHaveBeenCalledTimes(1)
    expect(sendPhoto.mock.calls[0][1].fileData).toBe(absolutePath)
    expect(sendDocument).not.toHaveBeenCalled()
  })
})
