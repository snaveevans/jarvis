import { parentPort, workerData } from 'node:worker_threads'

import { createMemoryDb } from '../memory/db.ts'
import { createMemoryRepository } from '../memory/repository.ts'
import type { MemorySearchInput, MemoryStoreInput, MemoryType } from '../memory/types.ts'
import type { WorkerRequest, WorkerResponse } from './types.ts'

if (!parentPort) {
  throw new Error('memory-worker must be run as a worker thread')
}

const { memoryDir, archiveRetentionDays } = workerData as {
  memoryDir?: string
  archiveRetentionDays?: number
}
const retentionDays = Number.isFinite(archiveRetentionDays) && (archiveRetentionDays as number) > 0
  ? Math.floor(archiveRetentionDays as number)
  : 14
const handle = createMemoryDb(memoryDir)
const { db, dbPath } = handle
const repo = createMemoryRepository(db, dbPath)

repo.purgeArchived(retentionDays)

const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
  search: (params) => repo.search(params as unknown as MemorySearchInput),
  getRecent: (params) => repo.getRecent(
    params.limit as number | undefined,
    params.type as MemoryType | undefined,
    params.includeArchived === true,
  ),
  store: (params) => repo.store(params as unknown as MemoryStoreInput),
  updateById: (params) => repo.updateById(
    params.id as number,
    params.content as string,
    params.tags as string[] | undefined,
  ),
  deleteById: (params) => repo.deleteById(params.id as number),
  clear: (params) => repo.clear(params.type as MemoryType | undefined),
  exportAll: () => repo.exportAll(),
  getStats: () => repo.getStats(),
  getAutoContext: (params) => repo.getAutoContext(params.query as string),
  getDbPath: () => dbPath,
  close: () => {
    handle.close()
    setTimeout(() => process.exit(0), 50)
    return true
  },
}

parentPort.on('message', (request: WorkerRequest) => {
  const response: WorkerResponse = { requestId: request.requestId }

  try {
    const handler = handlers[request.method]
    if (!handler) {
      response.error = `Unknown method: ${request.method}`
    } else {
      response.result = handler(request.params)
    }
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error)
  }

  parentPort!.postMessage(response)
})
