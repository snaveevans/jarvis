import { MEMORY_TYPES } from '../memory/index.ts'

import type { MemoryService, MemoryType } from '../memory/index.ts'
import type { Tool, ToolResult } from './types.ts'

function isMemoryType(value: unknown): value is MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType)
}

export function createMemoryStoreTool(memoryService: MemoryService): Tool {
  return {
    name: 'memory_store',
    description: 'Store a structured memory for future recall',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The memory content to store',
        },
        type: {
          type: 'string',
          enum: MEMORY_TYPES,
          description: 'Memory type',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization',
        },
      },
      required: ['content', 'type'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const content = args.content
      if (typeof content !== 'string' || !content.trim()) {
        return { content: '', error: 'content is required and must be a non-empty string' }
      }

      const typeArg = args.type
      if (!isMemoryType(typeArg)) {
        return { content: '', error: `type must be one of: ${MEMORY_TYPES.join(', ')}` }
      }

      const tags = args.tags
      if (tags !== undefined && !Array.isArray(tags)) {
        return { content: '', error: 'tags must be an array of strings when provided' }
      }
      if (Array.isArray(tags) && tags.some(tag => typeof tag !== 'string' || !tag.trim())) {
        return { content: '', error: 'tags must contain only non-empty strings' }
      }

      try {
        const result = await memoryService.store({
          content,
          type: typeArg,
          tags: tags as string[] | undefined,
        })

        if (result.deduplicated) {
          return {
            content: `Memory already exists (ID: ${result.memory.id}, type: ${result.memory.type}).`,
          }
        }

        return {
          content: `Memory stored (ID: ${result.memory.id}, type: ${result.memory.type}, tokens: ${result.memory.tokenCount}).`,
        }
      } catch (error) {
        return {
          content: '',
          error: `memory_store failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}
