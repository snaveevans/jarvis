import { MEMORY_TYPES } from '../memory/index.ts'

import type { Memory, MemorySearchResult, MemoryService, MemoryType } from '../memory/index.ts'
import type { Tool, ToolResult } from './types.ts'

function isMemoryType(value: unknown): value is MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType)
}

function formatMemoryLine(memory: Memory | MemorySearchResult): string {
  const createdAt = memory.createdAt.slice(0, 10)
  const rank = 'rank' in memory ? ` | rank=${memory.rank.toFixed(3)}` : ''
  const tags = memory.tags.length > 0 ? ` | tags=${memory.tags.join(',')}` : ''
  return `- [${memory.type} | ${createdAt}${rank}${tags}] ${memory.content}`
}

export function createMemorySearchTool(memoryService: MemoryService): Tool {
  return {
    name: 'memory_search',
    description: 'Search stored memories by keyword with optional type and result limit',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Empty string returns recent memories.',
        },
        type: {
          type: 'string',
          enum: MEMORY_TYPES,
          description: 'Optional memory type filter.',
        },
        limit: {
          type: 'number',
          description: 'Optional result limit. Default 5, max 20.',
        },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = args.query
      if (typeof query !== 'string') {
        return { content: '', error: 'query is required and must be a string' }
      }

      const typeArg = args.type
      if (typeArg !== undefined && !isMemoryType(typeArg)) {
        return { content: '', error: `type must be one of: ${MEMORY_TYPES.join(', ')}` }
      }

      const limitArg = args.limit
      if (limitArg !== undefined && (typeof limitArg !== 'number' || !Number.isFinite(limitArg))) {
        return { content: '', error: 'limit must be a number when provided' }
      }

      try {
        const results = memoryService.search({
          query,
          type: typeArg,
          limit: limitArg as number | undefined,
        })

        if (results.length === 0) {
          return { content: 'No memories found.' }
        }

        return {
          content: results.map(formatMemoryLine).join('\n'),
        }
      } catch (error) {
        return {
          content: '',
          error: `memory_search failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}
