import { readFile } from 'node:fs/promises'
import type { Tool, ToolResult } from './types.ts'

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file at the specified path. Returns the file content as a string.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The absolute or relative path to the file to read',
      },
    },
    required: ['path'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const path = args.path as string

    if (!path) {
      return {
        content: '',
        error: 'Missing required parameter: path',
      }
    }

    try {
      const content = await readFile(path, 'utf-8')
      return {
        content,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          content: '',
          error: `File not found: ${path}`,
        }
      }
      if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        return {
          content: '',
          error: `Permission denied: ${path}`,
        }
      }
      return {
        content: '',
        error: `Error reading file: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
}
