import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createMemoryWorkerClient } from './memory-worker-client.ts'

import type { MemoryService } from '../memory/service.ts'

describe('MemoryWorkerClient', () => {
  let memoryDir: string
  let service: MemoryService

  beforeEach(async () => {
    memoryDir = await mkdtemp(path.join(tmpdir(), 'jarvis-worker-test-'))
    service = createMemoryWorkerClient({ memoryDir })
  })

  afterEach(async () => {
    await service.close()
    await rm(memoryDir, { recursive: true, force: true })
  })

  test('stores and searches memories via worker', async () => {
    const storeResult = await service.store({
      content: 'Worker-stored preference: use tabs.',
      type: 'preference',
      tags: ['formatting'],
    })

    assert.equal(storeResult.deduplicated, false)
    assert.equal(storeResult.memory.type, 'preference')
    assert.ok(storeResult.memory.id > 0)

    const searchResults = await service.search({
      query: 'tabs',
      type: 'preference',
    })

    assert.equal(searchResults.length, 1)
    assert.equal(searchResults[0].id, storeResult.memory.id)
  })

  test('getRecent returns stored memories', async () => {
    await service.store({ content: 'Fact one.', type: 'fact' })
    await service.store({ content: 'Fact two.', type: 'fact' })

    const recent = await service.getRecent(10, 'fact')
    assert.equal(recent.length, 2)
  })

  test('deleteById archives a memory', async () => {
    const { memory } = await service.store({ content: 'To delete.', type: 'fact' })
    const deleted = await service.deleteById(memory.id)
    assert.equal(deleted, true)

    const results = await service.search({ query: 'To delete' })
    assert.equal(results.length, 0)

    const archivedResults = await service.search({ query: 'To delete', includeArchived: true })
    assert.equal(archivedResults.length, 1)
    assert.ok(archivedResults[0].archivedAt)
  })

  test('clear removes all memories', async () => {
    await service.store({ content: 'One.', type: 'fact' })
    await service.store({ content: 'Two.', type: 'preference' })

    const cleared = await service.clear()
    assert.equal(cleared, 2)

    const all = await service.exportAll()
    assert.equal(all.length, 0)
  })

  test('getStats returns correct counts', async () => {
    await service.store({ content: 'A fact.', type: 'fact' })
    await service.store({ content: 'A preference.', type: 'preference' })

    const stats = await service.getStats()
    assert.equal(stats.totalCount, 2)
    assert.equal(stats.byType.fact, 1)
    assert.equal(stats.byType.preference, 1)
  })

  test('getAutoContext returns formatted context', async () => {
    await service.store({ content: 'Project uses TypeScript strict mode.', type: 'fact' })

    const context = await service.getAutoContext('TypeScript')
    assert.ok(context)
    assert.match(context!, /Relevant context from memory:/)
    assert.match(context!, /TypeScript strict mode/)
  })

  test('deduplicates near-exact content via worker', async () => {
    const first = await service.store({ content: 'Auth uses JWT.', type: 'fact' })
    const second = await service.store({ content: '  auth uses  jwt. ', type: 'fact' })

    assert.equal(first.memory.id, second.memory.id)
    assert.equal(second.deduplicated, true)
  })

  test('concurrent requests resolve correctly', async () => {
    // Fire off multiple requests in parallel
    const [r1, r2, r3] = await Promise.all([
      service.store({ content: 'Concurrent 1.', type: 'fact' }),
      service.store({ content: 'Concurrent 2.', type: 'preference' }),
      service.store({ content: 'Concurrent 3.', type: 'fact' }),
    ])

    assert.ok(r1.memory.id > 0)
    assert.ok(r2.memory.id > 0)
    assert.ok(r3.memory.id > 0)

    // All should have different IDs
    const ids = new Set([r1.memory.id, r2.memory.id, r3.memory.id])
    assert.equal(ids.size, 3)
  })
})
