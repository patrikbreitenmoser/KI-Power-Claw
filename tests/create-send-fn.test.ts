import { describe, expect, it, vi } from 'vitest'
import { createSendFn } from '../src/bot.ts'

describe('createSendFn', () => {
  it('sends media first and formatted text afterwards', async () => {
    const sendPhoto = vi.fn().mockResolvedValue(undefined)
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const bot = { api: { sendPhoto, sendMessage } } as any
    const sendFn = createSendFn(bot)

    await sendFn(
      '123',
      'MEDIA: /tmp/a.png\nMEDIA: /tmp/b.png\n\nHello **World** from scheduler output'
    )

    expect(sendPhoto).toHaveBeenCalledTimes(2)
    expect(sendPhoto.mock.calls[0][0]).toBe(123)
    expect(sendPhoto.mock.calls[1][0]).toBe(123)

    expect(sendMessage).toHaveBeenCalled()
    expect(sendMessage.mock.calls[0][0]).toBe(123)
    expect(String(sendMessage.mock.calls[0][1])).toContain('<b>World</b>')
    expect(sendMessage.mock.calls[0][2]).toEqual({ parse_mode: 'HTML' })
  })

  it('falls back to plain text when html send fails', async () => {
    const sendPhoto = vi.fn().mockResolvedValue(undefined)
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('html parse error'))
      .mockResolvedValue(undefined)
    const bot = { api: { sendPhoto, sendMessage } } as any
    const sendFn = createSendFn(bot)

    await sendFn('321', 'Hello **World**')

    expect(sendPhoto).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(String(sendMessage.mock.calls[0][1])).toContain('<b>World</b>')
    expect(String(sendMessage.mock.calls[1][1])).toBe('Hello World')
  })

  it('does not send text when payload contains only media lines', async () => {
    const sendPhoto = vi.fn().mockResolvedValue(undefined)
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const bot = { api: { sendPhoto, sendMessage } } as any
    const sendFn = createSendFn(bot)

    await sendFn('999', 'MEDIA: /tmp/image-only.png')

    expect(sendPhoto).toHaveBeenCalledTimes(1)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('sends a fallback message when media-only payload cannot be delivered', async () => {
    const sendPhoto = vi.fn().mockRejectedValue(new Error('file missing'))
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const bot = { api: { sendPhoto, sendMessage } } as any
    const sendFn = createSendFn(bot)

    await sendFn('777', 'MEDIA: /tmp/image-only.png')

    expect(sendPhoto).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String(sendMessage.mock.calls[0][1])).toContain('Could not send generated media file')
    expect(String(sendMessage.mock.calls[0][1])).toContain('/tmp/image-only.png')
  })
})
