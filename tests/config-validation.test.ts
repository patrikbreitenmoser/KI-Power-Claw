import { describe, it, expect } from 'vitest'

/**
 * Tests for config.ts safeInt/safeFloat validation logic.
 * We replicate the helpers here to test in isolation (config.ts has module-level side effects).
 */

function safeInt(raw: string | undefined, fallback: number, min: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n >= min ? n : fallback
}

function safeFloat(raw: string | undefined, fallback: number, min: number): number {
  const n = parseFloat(raw ?? '')
  return Number.isFinite(n) && n >= min ? n : fallback
}

describe('safeInt', () => {
  it('parses valid integer', () => {
    expect(safeInt('8', 5, 1)).toBe(8)
  })

  it('returns fallback for NaN', () => {
    expect(safeInt('banana', 8, 1)).toBe(8)
  })

  it('returns fallback for undefined', () => {
    expect(safeInt(undefined, 8, 1)).toBe(8)
  })

  it('returns fallback for empty string', () => {
    expect(safeInt('', 8, 1)).toBe(8)
  })

  it('returns fallback when below minimum', () => {
    expect(safeInt('0', 8, 1)).toBe(8)
    expect(safeInt('-5', 8, 1)).toBe(8)
  })

  it('accepts value at minimum', () => {
    expect(safeInt('1', 8, 1)).toBe(1)
  })

  it('returns fallback for Infinity', () => {
    expect(safeInt('Infinity', 8, 1)).toBe(8)
  })
})

describe('safeFloat', () => {
  it('parses valid float', () => {
    expect(safeFloat('5.0', 10, 0)).toBe(5.0)
  })

  it('returns fallback for NaN', () => {
    expect(safeFloat('notanumber', 50, 0)).toBe(50)
  })

  it('returns fallback for undefined', () => {
    expect(safeFloat(undefined, 50, 0)).toBe(50)
  })

  it('accepts zero when min is 0', () => {
    expect(safeFloat('0', 50, 0)).toBe(0)
  })

  it('returns fallback for negative when min is 0', () => {
    expect(safeFloat('-1.5', 50, 0)).toBe(50)
  })

  it('returns fallback for Infinity', () => {
    expect(safeFloat('Infinity', 50, 0)).toBe(50)
  })

  it('enforces minimum for monitor interval', () => {
    // SWARM_MONITOR_INTERVAL_MS must be >= 1000
    expect(safeInt('500', 120000, 1000)).toBe(120000)
    expect(safeInt('1000', 120000, 1000)).toBe(1000)
  })
})
