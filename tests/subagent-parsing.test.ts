import { describe, expect, it } from 'vitest'
import { detectBackgroundIntent, parseSubagentBlocks } from '../src/subagent.ts'

describe('detectBackgroundIntent', () => {
  it('detects english and german background keywords case-insensitive', () => {
    expect(detectBackgroundIntent('Please do this in the BACKGROUND')).toBe(true)
    expect(detectBackgroundIntent('Kannst du das im hintergrund machen?')).toBe(true)
    expect(detectBackgroundIntent('Kannst du das in einem subagent machen?')).toBe(true)
    expect(detectBackgroundIntent('Can you use a sub-agent for this?')).toBe(true)
    expect(detectBackgroundIntent('Please run this asynchronously.')).toBe(true)
    expect(detectBackgroundIntent('Bitte starte einen Sub-Agent dafuer.')).toBe(true)
    expect(detectBackgroundIntent('Kannst du das asynchron erledigen?')).toBe(true)
  })

  it('returns false for normal messages', () => {
    expect(detectBackgroundIntent('What is on my schedule today?')).toBe(false)
    expect(detectBackgroundIntent('Can you explain what a subagent is?')).toBe(false)
  })
})

describe('parseSubagentBlocks', () => {
  it('extracts multiple blocks and returns cleaned text', () => {
    const input = [
      'Main response intro.',
      '',
      'SUBAGENT: Deep research',
      '---',
      'Collect latest docs and summarize.',
      '---',
      '',
      'Main response outro.',
      '',
      'SUBAGENT: Refactor task',
      '---',
      'Refactor module X and add tests.',
      '---',
    ].join('\n')

    const parsed = parseSubagentBlocks(input)

    expect(parsed.subagents).toHaveLength(2)
    expect(parsed.subagents[0]).toEqual({
      description: 'Deep research',
      prompt: 'Collect latest docs and summarize.',
    })
    expect(parsed.subagents[1]).toEqual({
      description: 'Refactor task',
      prompt: 'Refactor module X and add tests.',
    })
    expect(parsed.cleaned).toContain('Main response intro.')
    expect(parsed.cleaned).toContain('Main response outro.')
    expect(parsed.cleaned).not.toContain('SUBAGENT:')
  })

  it('returns original text unchanged when no valid block is present', () => {
    const input = 'SUBAGENT missing separators'
    const parsed = parseSubagentBlocks(input)

    expect(parsed.subagents).toEqual([])
    expect(parsed.cleaned).toBe(input)
  })

  it('trims description and prompt content in parsed blocks', () => {
    const input = [
      'SUBAGENT:   Data cleanup   ',
      '---',
      '   remove duplicates and normalize names   ',
      '---',
    ].join('\n')

    const parsed = parseSubagentBlocks(input)

    expect(parsed.subagents).toEqual([
      {
        description: 'Data cleanup',
        prompt: 'remove duplicates and normalize names',
      },
    ])
    expect(parsed.cleaned).toBe('')
  })
})
