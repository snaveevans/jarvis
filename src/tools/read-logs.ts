import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

import type { Tool, ToolResult } from './types.ts'

interface LogLine {
  level: number
  time: number
  msg: string
  [key: string]: unknown
}

const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

const LEVEL_NUMS: Record<string, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
}

function formatLogLine(parsed: LogLine): string {
  const levelName = LEVEL_NAMES[parsed.level] ?? `level:${parsed.level}`
  const ts = new Date(parsed.time).toISOString()
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (!['level', 'time', 'pid', 'hostname', 'msg'].includes(k)) {
      extra[k] = v
    }
  }
  const extraStr = Object.keys(extra).length > 0
    ? ' ' + JSON.stringify(extra)
    : ''
  return `[${ts}] ${levelName.toUpperCase()} ${parsed.msg}${extraStr}`
}

export interface ReadLogsToolConfig {
  logFilePath: string
}

export function createReadLogsTool(config: ReadLogsToolConfig): Tool {
  return {
    name: 'read_logs',
    description: [
      'Read and search Jarvis log entries from the configured log file.',
      'Filter by log level (error/warn/info), time window (since: "1h"/"30m"/"2h"), or text pattern.',
      'Use tail to get the most recent N lines.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        tail: {
          type: 'number',
          description: 'Return last N log lines (default: 50).',
        },
        level: {
          type: 'string',
          enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
          description: 'Minimum log level to include.',
        },
        since: {
          type: 'string',
          description: 'Time window: "30m", "1h", "2h", "24h". Only return lines from this duration ago to now.',
        },
        grep: {
          type: 'string',
          description: 'Case-insensitive text to search for in log messages or fields.',
        },
      },
      required: [],
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      if (!existsSync(config.logFilePath)) {
        return {
          content: '',
          error: `Log file not found: ${config.logFilePath}. Ensure JARVIS_LOG_FILE is configured.`,
        }
      }

      const tail = typeof args.tail === 'number' && args.tail > 0 ? Math.min(args.tail, 500) : 50
      const minLevel = typeof args.level === 'string' ? (LEVEL_NUMS[args.level] ?? 30) : 0
      const grep = typeof args.grep === 'string' ? args.grep.toLowerCase() : undefined

      let sinceMs = 0
      if (typeof args.since === 'string') {
        const match = args.since.match(/^(\d+)(m|h|d)$/)
        if (match) {
          const n = parseInt(match[1], 10)
          const unit = match[2]
          const mult = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
          sinceMs = Date.now() - n * mult
        }
      }

      try {
        const lines = await readLogLines(config.logFilePath)
        let filtered = lines

        if (minLevel > 0) {
          filtered = filtered.filter(l => l.level >= minLevel)
        }
        if (sinceMs > 0) {
          filtered = filtered.filter(l => l.time >= sinceMs)
        }
        if (grep) {
          filtered = filtered.filter(l => JSON.stringify(l).toLowerCase().includes(grep))
        }

        const sliced = filtered.slice(-tail)
        if (sliced.length === 0) {
          return { content: 'No log entries matched the given filters.' }
        }

        const formatted = sliced.map(formatLogLine).join('\n')
        const header = `Showing ${sliced.length} of ${filtered.length} matching entries (from ${lines.length} total):\n\n`
        return { content: header + formatted }
      } catch (err) {
        return {
          content: '',
          error: `Failed to read log file: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  }
}

async function readLogLines(filePath: string): Promise<LogLine[]> {
  return new Promise((resolve, reject) => {
    const lines: LogLine[] = []
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })

    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const parsed = JSON.parse(trimmed) as LogLine
        if (typeof parsed.level === 'number' && typeof parsed.time === 'number') {
          lines.push(parsed)
        }
      } catch {
        // Skip non-JSON lines
      }
    })

    rl.on('close', () => resolve(lines))
    rl.on('error', reject)
  })
}
