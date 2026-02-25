import path from 'node:path'
import { readFile } from 'node:fs/promises'
import fg from 'fast-glob'

import type { Tool, ToolResult } from './types.ts'
import { capOutput, getWorkspaceRoot, resolveWorkspacePath } from './common.ts'

const MAX_MATCHES = 1_000

export const grepTool: Tool = {
  name: 'grep',
  description: 'Search file contents with a regular expression pattern.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for.',
      },
      include: {
        type: 'string',
        description: 'Optional file glob include filter (default: **/*).',
      },
      path: {
        type: 'string',
        description: 'Optional search root path.',
      },
    },
    required: ['pattern'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = args.pattern as string | undefined
    const include = (args.include as string | undefined) ?? '**/*'
    const rootPath = args.path as string | undefined

    if (!pattern) {
      return {
        content: '',
        error: 'Missing required parameter: pattern',
      }
    }

    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (error) {
      return {
        content: '',
        error: `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
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

    try {
      const files = await fg(include, {
        cwd: searchRoot,
        absolute: true,
        onlyFiles: true,
        dot: false,
        unique: true,
      })

      const matches: string[] = []
      for (const file of files) {
        if (matches.length >= MAX_MATCHES) {
          break
        }

        let content: string
        try {
          content = await readFile(file, 'utf-8')
        } catch {
          continue
        }

        const lines = content.split('\n')
        for (let index = 0; index < lines.length; index++) {
          if (matches.length >= MAX_MATCHES) {
            break
          }

          const line = lines[index]
          if (!regex.test(line)) {
            continue
          }

          const relativePath = path.relative(getWorkspaceRoot(), file)
          matches.push(`${relativePath}:${index + 1}: ${line}`)
        }
      }

      if (matches.length >= MAX_MATCHES) {
        matches.push('... [matches truncated]')
      }

      return {
        content: capOutput(matches.join('\n') || '(no matches)'),
      }
    } catch (error) {
      return {
        content: '',
        error: `Grep failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
}
