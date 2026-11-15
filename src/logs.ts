import { Buffer } from 'node:buffer'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

export interface LogLine {
  time?: Date
  /** `out`, `err` or `portcall` (portcall's own notes: command, exit). */
  tag: string
  text: string
  service: string
}

export interface LogFilter {
  since?: number
  grep?: RegExp
  errors?: boolean
  limit?: number
}

const LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) \[(\w+)\] (.*)$/
const ERROR = /(?:error|exception)\b|\b(?:fatal|panic|unhandled|traceback|failed)\b|ERR!/i
const CONTINUATION = /^\s|^(?:caused by|\} )/i
const MAX_CONTINUATION = 40
const MAX_READ = 8 * 1024 * 1024

export function parseLine(raw: string, service: string): LogLine {
  const match = LINE.exec(raw)
  if (!match)
    return { tag: 'out', text: raw, service }
  return { time: new Date(match[1]!), tag: match[2]!, text: match[3]!, service }
}

/** `30s`, `5m`, `2h`, `1d`, or anything `Date.parse` reads. Returns epoch ms. */
export function parseSince(value: string, now = Date.now()): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim())
  if (match) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd']
    return now - Number(match[1]) * unit
  }
  const time = Date.parse(value)
  if (Number.isNaN(time))
    throw new Error(`--since: can't read "${value}" (try 30s, 5m, 2h or a date)`)
  return time
}

function isError(line: LogLine): boolean {
  if (line.tag === 'portcall')
    return /^exited with|^failed to start/.test(line.text)
  return ERROR.test(line.text)
}

export function filterLines(lines: LogLine[], filter: LogFilter): LogLine[] {
  let out = lines
  if (filter.since !== undefined)
    out = out.filter(line => !line.time || line.time.getTime() >= filter.since!)
  if (filter.errors) {
    // An error line brings its stack trace (the indented lines after it).
    const kept: LogLine[] = []
    for (let i = 0; i < out.length; i++) {
      if (!isError(out[i]!))
        continue
      kept.push(out[i]!)
      let j = i + 1
      while (j < out.length && j - i <= MAX_CONTINUATION && CONTINUATION.test(out[j]!.text) && !isError(out[j]!))
        kept.push(out[j++]!)
      i = j - 1
    }
    out = kept
  }
  if (filter.grep)
    out = out.filter(line => filter.grep!.test(line.text))
  if (filter.limit !== undefined)
    out = out.slice(-filter.limit)
  return out
}

function readTail(file: string, maxBytes: number): string {
  const size = statSync(file).size
  const start = Math.max(0, size - maxBytes)
  const buffer = Buffer.alloc(size - start)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, buffer.length, start)
  }
  finally {
    closeSync(fd)
  }
  const text = buffer.toString('utf8')
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
}

export function readLog(file: string, service: string): LogLine[] {
  if (!existsSync(file))
    return []
  return readTail(file, MAX_READ).split('\n').filter(Boolean).map(raw => parseLine(raw, service))
}

/** Several services' logs as one, in time order. */
export function mergeLogs(logs: LogLine[][]): LogLine[] {
  return logs.flat().sort((a, b) => (a.time?.getTime() ?? 0) - (b.time?.getTime() ?? 0))
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

export function formatLine(line: LogLine, serviceWidth = 0): string {
  const time = line.time
    ? `${pad(line.time.getHours())}:${pad(line.time.getMinutes())}:${pad(line.time.getSeconds())}.${pad(line.time.getMilliseconds(), 3)} `
    : ''
  const service = serviceWidth ? `${line.service.padEnd(serviceWidth)} ` : ''
  const tag = line.tag === 'out' ? '' : `[${line.tag}] `
  return `${time}${service}${tag}${line.text}`
}

/** `tail -f` over several logs; a log that shrinks was rotated by a restart and is read again from its start. */
export async function followLogs(files: { file: string, service: string }[], onLine: (line: LogLine) => void, filter: LogFilter): Promise<never> {
  const offsets = files.map(({ file }) => (existsSync(file) ? statSync(file).size : 0))
  const partial = files.map(() => '')
  for (;;) {
    for (const [i, { file, service }] of files.entries()) {
      if (!existsSync(file))
        continue
      const size = statSync(file).size
      if (size < offsets[i]!) {
        offsets[i] = 0
        partial[i] = ''
      }
      if (size === offsets[i])
        continue
      const buffer = Buffer.alloc(size - offsets[i]!)
      const fd = openSync(file, 'r')
      try {
        readSync(fd, buffer, 0, buffer.length, offsets[i]!)
      }
      finally {
        closeSync(fd)
      }
      offsets[i] = size
      const chunks = (partial[i] + buffer.toString('utf8')).split('\n')
      partial[i] = chunks.pop()!
      const lines = chunks.filter(Boolean).map(raw => parseLine(raw, service))
      for (const line of filterLines(lines, { ...filter, limit: undefined, since: undefined }))
        onLine(line)
    }
    await sleep(250)
  }
}
