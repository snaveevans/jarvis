import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'

import type { ShellJob, ShellResult, ShellPool } from './types.ts'

const exec = promisify(execCallback)

const DEFAULT_MAX_CONCURRENT = 3

export interface ShellPoolConfig {
  maxConcurrent?: number
}

interface QueueEntry {
  job: ShellJob
  resolve: (result: ShellResult) => void
  reject: (error: Error) => void
}

export function createShellPool(config: ShellPoolConfig = {}): ShellPool {
  const maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  const queue: QueueEntry[] = []
  let active = 0
  let closed = false

  function processQueue(): void {
    while (active < maxConcurrent && queue.length > 0) {
      const entry = queue.shift()!
      active++
      void runJob(entry)
    }
  }

  async function runJob(entry: QueueEntry): Promise<void> {
    const startMs = Date.now()
    try {
      const { stdout, stderr } = await exec(entry.job.command, {
        cwd: entry.job.cwd,
        timeout: entry.job.timeout,
        shell: '/bin/bash',
        maxBuffer: entry.job.maxBuffer,
      })

      entry.resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: 0,
        durationMs: Date.now() - startMs,
      })
    } catch (error) {
      const shellError = error as {
        stdout?: string
        stderr?: string
        code?: number | string
      }
      entry.resolve({
        stdout: shellError.stdout ?? '',
        stderr: shellError.stderr ?? '',
        exitCode: typeof shellError.code === 'number' ? shellError.code : 1,
        durationMs: Date.now() - startMs,
      })
    } finally {
      active--
      processQueue()
    }
  }

  return {
    exec(job: ShellJob): Promise<ShellResult> {
      if (closed) {
        return Promise.reject(new Error('Shell pool is closed'))
      }

      return new Promise<ShellResult>((resolve, reject) => {
        queue.push({ job, resolve, reject })
        processQueue()
      })
    },

    shutdown(): void {
      closed = true
      for (const entry of queue) {
        entry.reject(new Error('Shell pool shutting down'))
      }
      queue.length = 0
    },

    get queueLength(): number {
      return queue.length
    },

    get activeCount(): number {
      return active
    },
  }
}
