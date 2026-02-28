import { createMemorySearchTool } from './memory-search.ts'
import { createMemoryStoreTool } from './memory-store.ts'
import { createMemoryUpdateTool } from './memory-update.ts'
import { createMemoryDeleteTool } from './memory-delete.ts'

import type { MemoryService } from '../memory/index.ts'
import type { Tool } from './types.ts'

export function createMemoryTools(memoryService: MemoryService): Tool[] {
  return [
    createMemorySearchTool(memoryService),
    createMemoryStoreTool(memoryService),
    createMemoryUpdateTool(memoryService),
    createMemoryDeleteTool(memoryService),
  ]
}
