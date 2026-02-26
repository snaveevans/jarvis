export const MEMORY_TYPES = ['preference', 'fact', 'conversation_summary'] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

export interface Memory {
  id: number
  content: string
  type: MemoryType
  tags: string[]
  source?: string
  createdAt: string
  tokenCount: number
  archivedAt?: string
  archiveReason?: string
}

export interface MemorySearchResult extends Memory {
  rank: number
}

export interface MemorySearchInput {
  query: string
  type?: MemoryType
  limit?: number
  includeArchived?: boolean
}

export interface MemoryStoreInput {
  content: string
  type: MemoryType
  tags?: string[]
  source?: string
}

export interface MemoryStoreResult {
  memory: Memory
  deduplicated: boolean
}

export interface MemoryStats {
  dbPath: string
  dbSizeBytes: number
  totalCount: number
  totalTokenCount: number
  byType: Record<MemoryType, number>
}
