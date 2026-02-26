import type { MemoryService } from '../memory/index.ts'
import type { Tool, ToolResult } from './types.ts'

export function createMemoryDeleteTool(memoryService: MemoryService): Tool {
  return {
    name: 'memory_delete',
    description: 'Delete a specific memory by its ID',
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
        const deleted = await memoryService.deleteById(id)
        if (!deleted) {
          return { content: '', error: `No memory found with ID ${id}` }
        }

        return { content: `Memory #${id} deleted.` }
      } catch (error) {
        return {
          content: '',
          error: `memory_delete failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}
