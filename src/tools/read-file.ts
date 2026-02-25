import type { Tool, ToolResult } from './types.ts'
import { readTool } from './read.ts'

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Backward-compatible alias of read(filePath).',
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

    return await readTool.execute({ filePath: path })
  },
}
