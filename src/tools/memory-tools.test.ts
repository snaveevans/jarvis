import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createMemoryService } from '../memory/index.ts'
import { createMemoryTools } from './memory-tools.ts'

describe('memory tools', () => {
  let memoryDir: string

  beforeEach(async () => {
    memoryDir = await mkdtemp(path.join(tmpdir(), 'jarvis-memory-tool-test-'))
  })

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true })
  })

  test('memory_store inserts a new memory', async () => {
    const service = createMemoryService({ memoryDir })
    const tools = createMemoryTools(service)
    const store = tools.find(tool => tool.name === 'memory_store')!

    try {
      const result = await store.execute({
        content: 'Use pnpm for local package management.',
        type: 'preference',
        tags: ['tooling'],
      })

      assert.equal(result.error, undefined)
      assert.match(result.content, /Memory stored/)
    } finally {
      service.close()
    }
  })

  test('memory_search returns matching rows', async () => {
    const service = createMemoryService({ memoryDir })
    const tools = createMemoryTools(service)
    const store = tools.find(tool => tool.name === 'memory_store')!
    const search = tools.find(tool => tool.name === 'memory_search')!

    try {
      await store.execute({
        content: 'Auth uses 15-minute access tokens.',
        type: 'fact',
      })

      const result = await search.execute({
        query: '15-minute',
        type: 'fact',
      })

      assert.equal(result.error, undefined)
      assert.match(result.content, /15-minute access tokens/)
    } finally {
      service.close()
    }
  })

  test('memory_store validates type', async () => {
    const service = createMemoryService({ memoryDir })
    const tools = createMemoryTools(service)
    const store = tools.find(tool => tool.name === 'memory_store')!

    try {
      const result = await store.execute({
        content: 'some content',
        type: 'unknown_type',
      })

      assert.ok(result.error)
      assert.match(result.error!, /type must be one of/)
    } finally {
      service.close()
    }
  })
})
