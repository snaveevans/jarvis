import { createMemoryDb } from './db.ts'
import { createMemoryRepository } from './repository.ts'

import type {
  Memory,
  MemorySearchInput,
  MemorySearchResult,
  MemoryStats,
  MemoryStoreInput,
  MemoryStoreResult,
  MemoryType,
} from './types.ts'

type MemoryLogger = {
  info?: (meta: unknown, message?: string) => void
  warn?: (meta: unknown, message?: string) => void
  error?: (meta: unknown, message?: string) => void
}

export interface MemoryServiceConfig {
  memoryDir?: string
  archiveRetentionDays?: number
  logger?: MemoryLogger
}

export interface MemoryService {
  readonly dbPath: string
  search(input: MemorySearchInput): Promise<MemorySearchResult[]>
  getRecent(limit?: number, type?: MemoryType): Promise<Memory[]>
  store(input: MemoryStoreInput): Promise<MemoryStoreResult>
  updateById(id: number, content: string, tags?: string[]): Promise<Memory | null>
  deleteById(id: number): Promise<boolean>
  clear(type?: MemoryType): Promise<number>
  exportAll(): Promise<Memory[]>
  getStats(): Promise<MemoryStats>
  getAutoContext(query: string): Promise<string | undefined>
  close(): void | Promise<void>
}

export function createMemoryService(config: MemoryServiceConfig = {}): MemoryService {
  const logger = config.logger
  const archiveRetentionDays = Number.isFinite(config.archiveRetentionDays) &&
      (config.archiveRetentionDays as number) > 0
    ? Math.floor(config.archiveRetentionDays as number)
    : 14
  const handle = createMemoryDb(config.memoryDir)
  const { db, dbPath } = handle
  const repo = createMemoryRepository(db, dbPath)

  const purgedCount = repo.purgeArchived(archiveRetentionDays)
  if (purgedCount > 0) {
    logger?.info?.({ purgedCount, archiveRetentionDays }, 'Purged archived memories past retention')
  }

  return {
    dbPath,
    search: (input) => Promise.resolve(repo.search(input)),
    getRecent: (limit, type) => Promise.resolve(repo.getRecent(limit, type)),
    store: (input) => Promise.resolve(repo.store(input)),
    updateById: (id, content, tags) => Promise.resolve(repo.updateById(id, content, tags)),
    deleteById: (id) => Promise.resolve(repo.deleteById(id)),
    clear: (type) => Promise.resolve(repo.clear(type)),
    exportAll: () => Promise.resolve(repo.exportAll()),
    getStats: () => Promise.resolve(repo.getStats()),
    getAutoContext: (query) => Promise.resolve(repo.getAutoContext(query)),
    close: () => handle.close(),
  }
}
