import { describe, expect, it } from 'vitest'
import { formatForTelegram, splitMessage } from '../src/bot.ts'

describe('formatForTelegram', () => {
  it('converts markdown formatting and escapes html', () => {
    const input = [
      '# Title',
      '**bold** _italic_ ~~strike~~',
      '[link](https://example.com)',
      '<script>alert(1)</script>',
    ].join('\n')

    const result = formatForTelegram(input)

    expect(result).toContain('<b>Title</b>')
    expect(result).toContain('<b>bold</b>')
    expect(result).toContain('<i>italic</i>')
    expect(result).toContain('<s>strike</s>')
    expect(result).toContain('<a href="https://example.com">link</a>')
    expect(result).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('preserves code blocks and inline code without markdown mangling', () => {
    const input = [
      '```ts',
      'const answer = 1 < 2 // **not-bold**',
      '```',
      'Use `x<y and **no-bold**` safely.',
    ].join('\n')

    const result = formatForTelegram(input)

    expect(result).toContain(
      '<pre><code class="language-ts">const answer = 1 &lt; 2 // **not-bold**</code></pre>'
    )
    expect(result).toContain('<code>x&lt;y and **no-bold**</code>')
    expect(result).not.toContain('<b>not-bold</b>')
  })
})

describe('splitMessage', () => {
  it('returns one chunk when text is below limit', () => {
    expect(splitMessage('hello', 10)).toEqual(['hello'])
  })

  it('splits on newline boundaries when possible', () => {
    const text = 'alpha\nbeta\ngamma'
    const chunks = splitMessage(text, 9)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toBe('alpha')
    expect(chunks.every((c) => c.length <= 9)).toBe(true)
    expect(chunks.join('\n')).toContain('beta')
    expect(chunks.join('\n')).toContain('gamma')
  })

  it('falls back to hard split for long single tokens', () => {
    const text = 'x'.repeat(25)
    const chunks = splitMessage(text, 10)

    expect(chunks).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  })
})
