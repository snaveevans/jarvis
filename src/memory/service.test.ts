import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import BetterSqlite3 from 'better-sqlite3'

import { createMemoryService } from './service.ts'
import { resolveMemoryDir } from './db.ts'

describe('MemoryService', () => {
  let memoryDir: string

  beforeEach(async () => {
    memoryDir = await mkdtemp(path.join(tmpdir(), 'jarvis-memory-test-'))
  })

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true })
  })

  test('stores and searches memories', async () => {
    const service = createMemoryService({ memoryDir })
    try {
      const storeResult = await service.store({
        content: 'I prefer functional patterns over classes.',
        type: 'preference',
        tags: ['typescript'],
      })

      assert.equal(storeResult.deduplicated, false)
      assert.equal(storeResult.memory.type, 'preference')

      const searchResults = await service.search({
        query: 'functional',
        type: 'preference',
      })

      assert.equal(searchResults.length, 1)
      assert.equal(searchResults[0].id, storeResult.memory.id)
    } finally {
      service.close()
    }
  })

  test('deduplicates near-exact content', async () => {
    const service = createMemoryService({ memoryDir })
    try {
      const first = await service.store({
        content: 'Auth uses JWT access tokens.',
        type: 'fact',
      })
      const second = await service.store({
        content: '  auth uses   jwt access tokens. ',
        type: 'fact',
      })

      assert.equal(first.memory.id, second.memory.id)
      assert.equal(second.deduplicated, true)
    } finally {
      service.close()
    }
  })

  test('builds bounded auto-context block', async () => {
    const service = createMemoryService({ memoryDir })
    try {
      await service.store({
        content: 'Project uses TypeScript strict mode.',
        type: 'fact',
      })
      await service.store({
        content: 'Use concise commit messages.',
        type: 'preference',
      })

      const context = await service.getAutoContext('TypeScript project')
      assert.ok(context)
      assert.match(context!, /Relevant context from memory:/)
      assert.match(context!, /TypeScript strict mode/)
    } finally {
      service.close()
    }
  })

  test('updates memory content by ID', async () => {
    const service = createMemoryService({ memoryDir })
    try {
      const { memory } = await service.store({
        content: 'User prefers 2-space indentation.',
        type: 'preference',
        tags: ['formatting'],
      })

      const updated = await service.updateById(memory.id, 'User prefers 4-space indentation for Python.', ['formatting', 'python'])
      assert.ok(updated)
      assert.equal(updated!.id, memory.id)
      assert.equal(updated!.content, 'User prefers 4-space indentation for Python.')
      assert.deepStrictEqual(updated!.tags, ['formatting', 'python'])

      // Verify searchable via FTS
      const results = await service.search({ query: '4-space indentation' })
      assert.equal(results.length, 1)
      assert.equal(results[0].id, memory.id)
    } finally {
      service.close()
    }
  })

  test('updateById returns null for non-existent or archived memories', async () => {
    const service = createMemoryService({ memoryDir })
    try {
      // Non-existent
      const notFound = await service.updateById(9999, 'new content')
      assert.equal(notFound, null)

      // Archived
      const { memory } = await service.store({
        content: 'Will be archived.',
        type: 'fact',
      })
      await service.deleteById(memory.id)
      const archived = await service.updateById(memory.id, 'updated content')
      assert.equal(archived, null)
    } finally {
      service.close()
    }
  })

  test('soft-deletes memories and excludes archived by default', async () => {
    const service = createMemoryService({ memoryDir })
    try {
      const { memory } = await service.store({
        content: 'Archive me.',
        type: 'fact',
      })

      const archived = await service.deleteById(memory.id)
      assert.equal(archived, true)

      const defaultResults = await service.search({ query: 'Archive me' })
      assert.equal(defaultResults.length, 0)

      const archivedResults = await service.search({
        query: 'Archive me',
        includeArchived: true,
      })
      assert.equal(archivedResults.length, 1)
      assert.ok(archivedResults[0].archivedAt)
    } finally {
      service.close()
    }
  })

  test('purges archived memories older than retention window at startup', async () => {
    const service = createMemoryService({ memoryDir, archiveRetentionDays: 14 })
    const { memory } = await service.store({
      content: 'Old archived memory',
      type: 'fact',
    })
    await service.deleteById(memory.id)
    service.close()

    const db = new BetterSqlite3(path.join(memoryDir, 'memory.db'))
    try {
      db.prepare(`UPDATE memories SET archived_at = '2000-01-01 00:00:00' WHERE id = ?`).run(memory.id)
    } finally {
      db.close()
    }

    const reopened = createMemoryService({ memoryDir, archiveRetentionDays: 14 })
    try {
      const all = await reopened.exportAll()
      assert.equal(all.length, 0)
    } finally {
      reopened.close()
    }
  })

  test('falls back to default memory dir when configured dir is empty', () => {
    const resolved = resolveMemoryDir('')
    assert.ok(resolved.endsWith(path.join('.jarvis')))
  })

  test('getAutoContext returns recent preference/fact memories even when FTS misses', async () => {
    const service = createMemoryService({ memoryDir })
    try {
      await service.store({
        content: 'User prefers dark mode.',
        type: 'preference',
        tags: ['ui'],
      })
      await service.store({
        content: 'Project uses PostgreSQL.',
        type: 'fact',
        tags: ['database'],
      })

      // "hello" won't match either memory via FTS
      const context = await service.getAutoContext('hello')
      assert.ok(context, 'Expected auto-context even for non-matching query')
      assert.match(context!, /dark mode|PostgreSQL/)
    } finally {
      service.close()
    }
  })

  test('getAutoContext deduplicates memories in both FTS and recent results', async () => {
    const service = createMemoryService({ memoryDir })
    try {
      await service.store({
        content: 'User prefers TypeScript strict mode.',
        type: 'preference',
        tags: ['typescript'],
      })

      // "TypeScript" will match via FTS, and the same memory is recent
      const context = await service.getAutoContext('TypeScript')
      assert.ok(context)
      // Should only appear once
      const matches = context!.match(/TypeScript strict mode/g)
      assert.equal(matches?.length, 1, 'Memory should appear exactly once (deduplicated)')
    } finally {
      service.close()
    }
  })

  test('getAutoContext excludes conversation_summary from recent baseline', async () => {
    const service = createMemoryService({ memoryDir })
    try {
      await service.store({
        content: 'Discussed project setup and deployment.',
        type: 'conversation_summary',
      })

      // No FTS match and summaries should not be in recent baseline
      const context = await service.getAutoContext('hello')
      assert.equal(context, undefined, 'conversation_summary should not appear in recent baseline')
    } finally {
      service.close()
    }
  })
})
