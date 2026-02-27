import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import type { WorkerRequest, WorkerResponse } from './types.ts'

const isCompiled = !import.meta.url.endsWith('.ts')
const workerExt = isCompiled ? '.js' : '.ts'
const workerExecArgv = isCompiled ? [] : ['--experimental-strip-types']

const WORKER_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `search-worker${workerExt}`
)

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

type PoolLogger = {
  info?: (meta: unknown, message?: string) => void
  warn?: (meta: unknown, message?: string) => void
  error?: (meta: unknown, message?: string) => void
}

export interface SearchWorkerPoolConfig {
  poolSize?: number
  logger?: PoolLogger
}

export interface SearchWorkerPool {
  glob(params: { pattern: string, searchRoot: string, workspaceRoot: string }): Promise<string>
  grep(params: { pattern: string, include?: string, searchRoot: string, workspaceRoot: string }): Promise<string>
  shutdown(): Promise<void>
}

export function createSearchWorkerPool(config: SearchWorkerPoolConfig = {}): SearchWorkerPool {
  const poolSize = config.poolSize ?? 2
  const logger = config.logger
  const workers: Worker[] = []
  const pendingByWorker = new Map<Worker, Map<string, PendingRequest>>()
  let nextWorkerIndex = 0
  let closed = false

  function spawnWorker(): Worker {
    const w = new Worker(WORKER_FILE, {
      execArgv: workerExecArgv,
    })

    const pending = new Map<string, PendingRequest>()
    pendingByWorker.set(w, pending)

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
      logger?.error?.({ error: error.message }, 'Search worker error')
      for (const [, req] of pending) {
        req.reject(new Error(`Worker error: ${error.message}`))
      }
      pending.clear()
    })

    w.on('exit', (code: number) => {
      for (const [, req] of pending) {
        req.reject(new Error(`Worker exited with code ${code}`))
      }
      pending.clear()

      if (!closed) {
        logger?.warn?.({ exitCode: code }, 'Search worker exited unexpectedly, respawning')
        const index = workers.indexOf(w)
        if (index !== -1) {
          pendingByWorker.delete(w)
          const replacement = spawnWorker()
          workers[index] = replacement
        }
      }
    })

    return w
  }

  // Initialize pool
  for (let i = 0; i < poolSize; i++) {
    workers.push(spawnWorker())
  }
  logger?.info?.({ poolSize }, 'Search worker pool created')

  function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (closed) {
      return Promise.reject(new Error('Search worker pool is closed'))
    }

    // Round-robin
    const worker = workers[nextWorkerIndex % workers.length]
    nextWorkerIndex++

    const pending = pendingByWorker.get(worker)!
    const requestId = randomUUID()
    const message: WorkerRequest = { requestId, method, params }

    return new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      worker.postMessage(message)
    })
  }

  return {
    async glob(params): Promise<string> {
      return await dispatch('glob', params as unknown as Record<string, unknown>) as string
    },

    async grep(params): Promise<string> {
      return await dispatch('grep', params as unknown as Record<string, unknown>) as string
    },

    async shutdown(): Promise<void> {
      closed = true
      // Reject pending
      for (const [, pending] of pendingByWorker) {
        for (const [, req] of pending) {
          req.reject(new Error('Pool shutting down'))
        }
        pending.clear()
      }
      // Terminate all workers
      await Promise.all(workers.map(w => w.terminate()))
      workers.length = 0
      pendingByWorker.clear()
      logger?.info?.({}, 'Search worker pool shut down')
    },
  }
}
