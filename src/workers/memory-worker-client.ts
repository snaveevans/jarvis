import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import type { MemoryService } from '../memory/service.ts'
import type {
  Memory,
  MemorySearchInput,
  MemorySearchResult,
  MemoryStats,
  MemoryStoreInput,
  MemoryStoreResult,
  MemoryType,
} from '../memory/types.ts'
import type { WorkerRequest, WorkerResponse } from './types.ts'

const isCompiled = !import.meta.url.endsWith('.ts')
const workerExt = isCompiled ? '.js' : '.ts'
const workerExecArgv = isCompiled ? [] : ['--experimental-strip-types']

const WORKER_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `memory-worker${workerExt}`
)

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

type MemoryLogger = {
  info?: (meta: unknown, message?: string) => void
  warn?: (meta: unknown, message?: string) => void
  error?: (meta: unknown, message?: string) => void
}

export interface MemoryWorkerClientConfig {
  memoryDir?: string
  archiveRetentionDays?: number
  logger?: MemoryLogger
}

export function createMemoryWorkerClient(config: MemoryWorkerClientConfig = {}): MemoryService {
  const logger = config.logger
  const pending = new Map<string, PendingRequest>()
  let worker: Worker | null = null
  let closed = false

  function spawnWorker(): Worker {
    const w = new Worker(WORKER_FILE, {
      execArgv: workerExecArgv,
      workerData: {
        memoryDir: config.memoryDir,
        archiveRetentionDays: config.archiveRetentionDays,
      },
    })

    w.on('message', (response: WorkerResponse) => {
      const req = pending.get(response.requestId)
      if (!req) return
      pending.delete(response.requestId)

      if (response.error) {
        req.reject(new Error(response.error))
      } else {
        req.resolve(response.result)
      }
    })

    w.on('error', (error: Error) => {
      logger?.error?.(
        { error: error.message },
        'Memory worker error'
      )
      // Reject all pending requests
      for (const [id, req] of pending) {
        req.reject(new Error(`Worker error: ${error.message}`))
        pending.delete(id)
      }
    })

    w.on('exit', (code: number) => {
      // Reject pending on any exit
      for (const [id, req] of pending) {
        req.reject(new Error(`Worker exited with code ${code}`))
        pending.delete(id)
      }
      // Respawn on unexpected exit
      if (!closed && worker === w) {
        logger?.warn?.(
          { exitCode: code },
          'Memory worker exited unexpectedly, respawning'
        )
        worker = spawnWorker()
      }
    })

    logger?.info?.({}, 'Memory worker spawned')
    return w
  }

  function request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (closed) {
      return Promise.reject(new Error('Memory worker client is closed'))
    }
    if (!worker) {
      worker = spawnWorker()
    }

    const requestId = randomUUID()
    const message: WorkerRequest = { requestId, method, params }

    return new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      worker!.postMessage(message)
    })
  }

  // Fetch dbPath synchronously by making a request (will resolve async)
  let cachedDbPath: string | undefined

  const service: MemoryService = {
    get dbPath(): string {
      // Return cached or placeholder until first request resolves
      return cachedDbPath ?? '(worker)'
    },

    async search(input: MemorySearchInput): Promise<MemorySearchResult[]> {
      return await request('search', input as unknown as Record<string, unknown>) as MemorySearchResult[]
    },

    async getRecent(limit?: number, type?: MemoryType): Promise<Memory[]> {
      return await request('getRecent', { limit, type }) as Memory[]
    },

    async store(input: MemoryStoreInput): Promise<MemoryStoreResult> {
      return await request('store', input as unknown as Record<string, unknown>) as MemoryStoreResult
    },

    async updateById(id: number, content: string, tags?: string[]): Promise<Memory | null> {
      return await request('updateById', { id, content, tags }) as Memory | null
    },

    async deleteById(id: number): Promise<boolean> {
      return await request('deleteById', { id }) as boolean
    },

    async clear(type?: MemoryType): Promise<number> {
      return await request('clear', { type }) as number
    },

    async exportAll(): Promise<Memory[]> {
      return await request('exportAll') as Memory[]
    },

    async getStats(): Promise<MemoryStats> {
      return await request('getStats') as MemoryStats
    },

    async getAutoContext(query: string): Promise<string | undefined> {
      return await request('getAutoContext', { query }) as string | undefined
    },

    async close(): Promise<void> {
      if (closed) return
      if (!worker) {
        closed = true
        return
      }

      const w = worker
      // Send close before setting closed flag (request() checks it)
      try {
        await request('close')
      } catch {
        // Worker might already be gone
      }
      closed = true
      worker = null

      // Wait for the worker to exit on its own (it calls process.exit after closing DB)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          void w.terminate().then(() => resolve(), () => resolve())
        }, 2000)
        w.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    },
  }

  // Eagerly fetch dbPath
  void request('getDbPath').then((result) => {
    cachedDbPath = result as string
  }).catch(() => {
    // Non-critical, keep going
  })

  return service
}
