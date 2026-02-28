import type { MemoryService } from '../memory/index.ts'
import type { Tool, ToolResult } from './types.ts'

export function createMemoryUpdateTool(memoryService: MemoryService): Tool {
  return {
    name: 'memory_update',
    description: 'Update an existing memory by ID with new content. Use when the user corrects previously stored information (e.g., changed preference, updated fact). Keeps the same ID.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The memory ID to update',
        },
        content: {
          type: 'string',
          description: 'The new memory content',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional updated tags (replaces existing tags if provided)',
        },
      },
      required: ['id', 'content'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const id = args.id
      if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) {
        return { content: '', error: 'id must be a positive number' }
      }

      const content = args.content
      if (typeof content !== 'string' || !content.trim()) {
        return { content: '', error: 'content is required and must be a non-empty string' }
      }

      const tags = args.tags
      if (tags !== undefined && !Array.isArray(tags)) {
        return { content: '', error: 'tags must be an array of strings when provided' }
      }
      if (Array.isArray(tags) && tags.some(tag => typeof tag !== 'string' || !tag.trim())) {
        return { content: '', error: 'tags must contain only non-empty strings' }
      }

      try {
        const updated = await memoryService.updateById(id, content, tags as string[] | undefined)
        if (!updated) {
          return { content: '', error: `No active memory found with ID ${id}` }
        }

        return {
          content: `Memory #${updated.id} updated (type: ${updated.type}, tokens: ${updated.tokenCount}).`,
        }
      } catch (error) {
        return {
          content: '',
          error: `memory_update failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}
