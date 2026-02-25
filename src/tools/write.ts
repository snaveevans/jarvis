import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

import type { Tool, ToolResult } from './types.ts'
import {
  hasFileBeenRead,
  markFileAsRead,
  pathExists,
  resolveWorkspacePath,
} from './common.ts'

export const writeTool: Tool = {
  name: 'write',
  description: 'Create a new file or overwrite an existing file.',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Absolute path to file.',
      },
      content: {
        type: 'string',
        description: 'Full file content to write.',
      },
    },
    required: ['filePath', 'content'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = args.filePath as string | undefined
    const content = args.content as string | undefined

    if (!filePath || content === undefined) {
      return {
        content: '',
        error: 'Missing required parameters: filePath, content',
      }
    }

    if (!path.isAbsolute(filePath)) {
      return {
        content: '',
        error: 'filePath must be absolute',
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

    const exists = await pathExists(resolvedPath)
    if (exists && !hasFileBeenRead(resolvedPath)) {
      return {
        content: '',
        error: `Write blocked: existing file must be read first in this session (${filePath})`,
      }
    }

    try {
      await mkdir(path.dirname(resolvedPath), { recursive: true })
      await writeFile(resolvedPath, content, 'utf-8')
      markFileAsRead(resolvedPath)

      return {
        content: `${exists ? 'Overwrote' : 'Created'} file: ${filePath}`,
      }
    } catch (error) {
      return {
        content: '',
        error: `Unable to write file: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
}
