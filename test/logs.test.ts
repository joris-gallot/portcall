import type { LogLine } from '../src/logs.ts'
import { describe, expect, it } from 'vitest'
import { filterLines, formatLine, parseLine, parseSince } from '../src/logs.ts'
import { cleanLine } from '../src/supervise.ts'

function lines(...raw: string[]): LogLine[] {
  return raw.map(r => parseLine(r, 'server'))
}

describe('parseSince', () => {
  it('reads relative durations and dates', () => {
    expect(parseSince('5m', 1_000_000)).toBe(1_000_000 - 300_000)
    expect(parseSince('2h', 10_000_000)).toBe(10_000_000 - 7_200_000)
    expect(parseSince('2026-11-15T10:00:00Z')).toBe(Date.parse('2026-11-15T10:00:00Z'))
    expect(() => parseSince('soon')).toThrow(/can't read/)
  })
})

describe('filterLines', () => {
  const log = lines(
    '2026-11-15T10:00:00.000Z [out] listening on 3000',
    '2026-11-15T10:00:05.000Z [err] TypeError: cannot read properties of undefined',
    '2026-11-15T10:00:05.001Z [err]     at handler (src/index.ts:12:3)',
    '2026-11-15T10:00:05.002Z [err]     at next (hono.js:1:1)',
    '2026-11-15T10:00:06.000Z [out] GET /health 200',
    '2026-11-15T10:00:07.000Z [portcall] exited with code 1',
  )

  it('keeps error lines with their stack trace', () => {
    expect(filterLines(log, { errors: true }).map(l => l.text)).toEqual([
      'TypeError: cannot read properties of undefined',
      '    at handler (src/index.ts:12:3)',
      '    at next (hono.js:1:1)',
      'exited with code 1',
    ])
  })

  it('filters by time, regex and count', () => {
    expect(filterLines(log, { since: Date.parse('2026-11-15T10:00:06Z') })).toHaveLength(2)
    expect(filterLines(log, { grep: /get \/health/i }).map(l => l.text)).toEqual(['GET /health 200'])
    expect(filterLines(log, { limit: 1 }).map(l => l.text)).toEqual(['exited with code 1'])
  })

  it('formats stderr with a tag and stdout without', () => {
    expect(formatLine(log[0]!)).toMatch(/^\d\d:\d\d:\d\d\.000 listening on 3000$/)
    expect(formatLine(log[1]!, 7)).toMatch(/ server {2}\[err\] TypeError/)
  })
})

describe('cleanLine', () => {
  it('drops escape codes and keeps the last state of a progress line', () => {
    expect(cleanLine('\x1B[32m✓\x1B[39m ready in \x1B[1m120\x1B[22m ms')).toBe('✓ ready in 120 ms')
    expect(cleanLine('building 10%\rbuilding 50%\rbuilding 100%')).toBe('building 100%')
  })
})
