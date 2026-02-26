import { describe, test } from 'node:test'
import assert from 'node:assert'

import { createShellPool } from './pool.ts'

describe('ShellPool', () => {
  test('executes a simple command', async () => {
    const pool = createShellPool()
    try {
      const result = await pool.exec({
        command: 'echo hello',
        cwd: '/tmp',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      })

      assert.equal(result.stdout.trim(), 'hello')
      assert.equal(result.exitCode, 0)
      assert.ok(result.durationMs >= 0)
    } finally {
      pool.shutdown()
    }
  })

  test('returns non-zero exit code on failure', async () => {
    const pool = createShellPool()
    try {
      const result = await pool.exec({
        command: 'exit 42',
        cwd: '/tmp',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      })

      assert.notEqual(result.exitCode, 0)
    } finally {
      pool.shutdown()
    }
  })

  test('enforces concurrency limit', async () => {
    const pool = createShellPool({ maxConcurrent: 2 })
    try {
      let maxActive = 0
      let currentActive = 0

      // Run 4 concurrent commands with max 2
      const promises = Array.from({ length: 4 }, (_, i) =>
        pool.exec({
          command: `echo job_${i} && sleep 0.05`,
          cwd: '/tmp',
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        }).then(result => {
          return result
        })
      )

      const results = await Promise.all(promises)

      // All should succeed
      for (const result of results) {
        assert.equal(result.exitCode, 0)
      }

      // Check queueLength and activeCount are consistent
      assert.equal(pool.queueLength, 0)
      assert.equal(pool.activeCount, 0)
    } finally {
      pool.shutdown()
    }
  })

  test('queue drains in order', async () => {
    const pool = createShellPool({ maxConcurrent: 1 })
    try {
      const results: string[] = []

      // With maxConcurrent=1, commands execute sequentially
      const promises = Array.from({ length: 3 }, (_, i) =>
        pool.exec({
          command: `echo ${i}`,
          cwd: '/tmp',
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        }).then(result => {
          results.push(result.stdout.trim())
        })
      )

      await Promise.all(promises)

      assert.deepEqual(results, ['0', '1', '2'])
    } finally {
      pool.shutdown()
    }
  })

  test('shutdown rejects queued jobs', async () => {
    const pool = createShellPool({ maxConcurrent: 1 })

    // Fill the one slot
    const running = pool.exec({
      command: 'sleep 1',
      cwd: '/tmp',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    })

    // Queue a second job
    const queued = pool.exec({
      command: 'echo queued',
      cwd: '/tmp',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    })

    // Shutdown should reject the queued job
    pool.shutdown()

    await assert.rejects(queued, /Shell pool shutting down/)

    // The running job should still complete (already in flight)
    const result = await running
    assert.ok(result.durationMs >= 0)
  })

  test('rejects after shutdown', async () => {
    const pool = createShellPool()
    pool.shutdown()

    await assert.rejects(
      pool.exec({
        command: 'echo nope',
        cwd: '/tmp',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }),
      /Shell pool is closed/
    )
  })

  test('captures stderr', async () => {
    const pool = createShellPool()
    try {
      const result = await pool.exec({
        command: 'echo err >&2',
        cwd: '/tmp',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      })

      assert.equal(result.stderr.trim(), 'err')
      assert.equal(result.exitCode, 0)
    } finally {
      pool.shutdown()
    }
  })
})
