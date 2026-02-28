import type { MemoryService } from '../memory/index.ts'
import type { Tool, ToolResult } from './types.ts'

export function createMemoryDeleteTool(memoryService: MemoryService): Tool {
  return {
    name: 'memory_delete',
    description: 'Delete an outdated or incorrect memory by ID. Use when the user corrects previously stored information.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The memory ID to delete',
        },
      },
      required: ['id'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const id = args.id
      if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) {
        return { content: '', error: 'id must be a positive number' }
      }

      try {
        const archived = await memoryService.deleteById(id)
        if (!archived) {
          return { content: '', error: `No memory found with ID ${id}` }
        }

        return { content: `Memory #${id} archived.` }
      } catch (error) {
        return {
          content: '',
          error: `memory_delete failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}
