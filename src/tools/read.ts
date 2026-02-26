import { readdir, readFile, stat } from 'node:fs/promises'

import type { Tool, ToolResult } from './types.ts'
import { capOutput, markFileAsRead, resolveWorkspacePath, parsePositiveEnvInt } from './common.ts'

const DEFAULT_LIMIT = parsePositiveEnvInt('JARVIS_TOOLS_MAX_READ_LINES', 2_000)

function parsePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }

  return Math.floor(value)
}

function formatNumberedLines(lines: string[], startLine: number): string {
  return lines
    .map((line, index) => {
      const lineNumber = startLine + index
      return `${lineNumber}. ${line}`
    })
    .join('\n')
}

export const readTool: Tool = {
  name: 'read',
  description: 'Read a file (with line numbers) or list a directory.',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the file or directory to read.',
      },
      offset: {
        type: 'number',
        description: 'Optional starting line number (1-based) for file reads.',
      },
      limit: {
        type: 'number',
        description: 'Optional max number of lines to return (default: 2000).',
      },
    },
    required: ['filePath'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = args.filePath as string | undefined
    if (!filePath) {
      return {
        content: '',
        error: 'Missing required parameter: filePath',
      }
    }

    let resolvedPath: string
    try {
      resolvedPath = resolveWorkspacePath(filePath)
    } catch (error) {
      return {
        content: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }

    let fileStats
    try {
      fileStats = await stat(resolvedPath)
    } catch (error) {
      return {
        content: '',
        error: `Unable to read path: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    if (fileStats.isDirectory()) {
      try {
        const entries = await readdir(resolvedPath, { withFileTypes: true })
        const listing = entries
          .map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
          .sort((a, b) => a.localeCompare(b))
          .join('\n')

        return {
          content: capOutput(listing || '(empty directory)'),
        }
      } catch (error) {
        return {
          content: '',
          error: `Unable to list directory: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    try {
      const fileContents = await readFile(resolvedPath, 'utf-8')
      const allLines = fileContents.split('\n')
      const offset = parsePositiveInteger(args.offset, 1)
      const limit = parsePositiveInteger(args.limit, DEFAULT_LIMIT)
      const startIndex = Math.max(0, offset - 1)
      const selectedLines = allLines.slice(startIndex, startIndex + limit)
      const numbered = formatNumberedLines(selectedLines, startIndex + 1)

      markFileAsRead(resolvedPath)

      return {
        content: capOutput(numbered),
      }
    } catch (error) {
      return {
        content: '',
        error: `Unable to read file: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
}
