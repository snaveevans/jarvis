import path from 'node:path'
import { stat } from 'node:fs/promises'
import fg from 'fast-glob'

import type { Tool, ToolResult, ToolExecutionContext } from './types.ts'
import { capOutput, getWorkspaceRoot, resolveWorkspacePath } from './common.ts'

const MAX_RESULTS = 1_000

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files by glob pattern.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match against files.',
      },
      path: {
        type: 'string',
        description: 'Optional search root directory path.',
      },
    },
    required: ['pattern'],
  },
  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const pattern = args.pattern as string | undefined
    const rootPath = args.path as string | undefined

    if (!pattern) {
      return {
        content: '',
        error: 'Missing required parameter: pattern',
      }
    }

    let searchRoot = getWorkspaceRoot()
    if (rootPath) {
      try {
        searchRoot = resolveWorkspacePath(rootPath)
      } catch (error) {
        return {
          content: '',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    // Delegate to search pool if available
    if (context?.searchPool) {
      try {
        const content = await context.searchPool.glob({
          pattern,
          searchRoot,
          workspaceRoot: getWorkspaceRoot(),
        })
        return { content }
      } catch (error) {
        return {
          content: '',
          error: `Glob failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    // In-process fallback
    try {
      const matches = await fg(pattern, {
        cwd: searchRoot,
        absolute: true,
        dot: false,
        onlyFiles: false,
        unique: true,
      })

      const matchesWithMtime = await Promise.all(
        matches.map(async match => {
          try {
            const fileStats = await stat(match)
            return {
              match,
              mtimeMs: fileStats.mtimeMs,
            }
          } catch {
            return {
              match,
              mtimeMs: 0,
            }
          }
        })
      )

      matchesWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)

      const limited = matchesWithMtime.slice(0, MAX_RESULTS)
      const outputLines = limited.map(entry => {
        return path.relative(getWorkspaceRoot(), entry.match)
      })

      if (matchesWithMtime.length > MAX_RESULTS) {
        outputLines.push('... [results truncated]')
      }

      return {
        content: capOutput(outputLines.join('\n') || '(no matches)'),
      }
    } catch (error) {
      return {
        content: '',
        error: `Glob failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
}
