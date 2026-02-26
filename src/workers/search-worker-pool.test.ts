import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSearchWorkerPool } from './search-worker-pool.ts'

import type { SearchWorkerPool } from './search-worker-pool.ts'

describe('SearchWorkerPool', () => {
  let testDir: string
  let pool: SearchWorkerPool

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'jarvis-search-test-'))
    pool = createSearchWorkerPool({ poolSize: 2 })

    // Create test files
    await writeFile(path.join(testDir, 'hello.ts'), 'export const greeting = "hello world"\n')
    await writeFile(path.join(testDir, 'bye.ts'), 'export const farewell = "goodbye"\n')
    await mkdir(path.join(testDir, 'sub'), { recursive: true })
    await writeFile(path.join(testDir, 'sub', 'nested.ts'), 'const x = 42\n')
  })

  afterEach(async () => {
    await pool.shutdown()
    await rm(testDir, { recursive: true, force: true })
  })

  test('glob finds files by pattern', async () => {
    const result = await pool.glob({
      pattern: '**/*.ts',
      searchRoot: testDir,
      workspaceRoot: testDir,
    })

    assert.ok(result.includes('hello.ts'))
    assert.ok(result.includes('bye.ts'))
    assert.ok(result.includes(path.join('sub', 'nested.ts')))
  })

  test('glob returns no matches for non-matching pattern', async () => {
    const result = await pool.glob({
      pattern: '**/*.py',
      searchRoot: testDir,
      workspaceRoot: testDir,
    })

    assert.equal(result, '(no matches)')
  })

  test('grep finds content in files', async () => {
    const result = await pool.grep({
      pattern: 'hello',
      searchRoot: testDir,
      workspaceRoot: testDir,
    })

    assert.ok(result.includes('hello.ts'))
    assert.ok(result.includes('hello world'))
  })

  test('grep respects include filter', async () => {
    const result = await pool.grep({
      pattern: 'const',
      include: 'sub/**/*',
      searchRoot: testDir,
      workspaceRoot: testDir,
    })

    assert.ok(result.includes('nested.ts'))
    assert.ok(!result.includes('hello.ts'))
  })

  test('grep returns no matches when pattern not found', async () => {
    const result = await pool.grep({
      pattern: 'nonexistent_string',
      searchRoot: testDir,
      workspaceRoot: testDir,
    })

    assert.equal(result, '(no matches)')
  })

  test('concurrent requests via round-robin', async () => {
    const [r1, r2, r3] = await Promise.all([
      pool.glob({ pattern: '**/*.ts', searchRoot: testDir, workspaceRoot: testDir }),
      pool.grep({ pattern: 'hello', searchRoot: testDir, workspaceRoot: testDir }),
      pool.glob({ pattern: 'sub/**/*', searchRoot: testDir, workspaceRoot: testDir }),
    ])

    assert.ok(r1.includes('hello.ts'))
    assert.ok(r2.includes('hello world'))
    assert.ok(r3.includes('nested.ts'))
  })
})
