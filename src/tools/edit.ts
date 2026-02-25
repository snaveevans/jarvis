import { readFile, writeFile } from 'node:fs/promises'

import type { Tool, ToolResult } from './types.ts'
import { hasFileBeenRead, markFileAsRead, resolveWorkspacePath } from './common.ts'

function countMatches(content: string, target: string): number {
  if (target.length === 0) {
    return 0
  }

  return content.split(target).length - 1
}

export const editTool: Tool = {
  name: 'edit',
  description: 'Edit a file using exact string replacement.',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to file to edit.',
      },
      oldString: {
        type: 'string',
        description: 'Exact string to replace.',
      },
      newString: {
        type: 'string',
        description: 'Replacement string.',
      },
      replaceAll: {
        type: 'boolean',
        description: 'Replace all matches. Defaults to false.',
      },
    },
    required: ['filePath', 'oldString', 'newString'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = args.filePath as string | undefined
    const oldString = args.oldString as string | undefined
    const newString = args.newString as string | undefined
    const replaceAll = args.replaceAll === true

    if (!filePath || oldString === undefined || newString === undefined) {
      return {
        content: '',
        error: 'Missing required parameters: filePath, oldString, newString',
      }
    }

    if (oldString.length === 0) {
      return {
        content: '',
        error: 'oldString must be non-empty',
      }
    }

    if (oldString === newString) {
      return {
        content: '',
        error: 'oldString and newString must differ',
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

    if (!hasFileBeenRead(resolvedPath)) {
      return {
        content: '',
        error: `Edit blocked: file must be read first in this session (${filePath})`,
      }
    }

    let content: string
    try {
      content = await readFile(resolvedPath, 'utf-8')
    } catch (error) {
      return {
        content: '',
        error: `Unable to read file for edit: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    const matchCount = countMatches(content, oldString)
    if (matchCount === 0) {
      return {
        content: '',
        error: 'Exact match not found: oldString',
      }
    }

    if (matchCount > 1 && !replaceAll) {
      return {
        content: '',
        error: 'oldString matched multiple locations; provide more context or set replaceAll=true',
      }
    }

    const updatedContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString)

    try {
      await writeFile(resolvedPath, updatedContent, 'utf-8')
      markFileAsRead(resolvedPath)
      return {
        content: `Edited ${filePath} (${replaceAll ? matchCount : 1} replacement${matchCount === 1 ? '' : 's'})`,
      }
    } catch (error) {
      return {
        content: '',
        error: `Unable to write edited file: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
}
