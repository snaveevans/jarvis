import assert from 'node:assert'
import { afterEach, describe, test } from 'node:test'

import { createWebSearchTool } from './web-search.ts'

const BASE_CONFIG = {
  provider: 'brave',
  defaultLimit: 5,
  maxLimit: 10,
  timeoutMs: 15000,
  brave: {
    apiKey: 'brave-test-key',
    baseUrl: 'https://api.search.brave.com/res/v1/web/search',
  },
  synthetic: {
    apiKey: '',
    baseUrl: 'https://api.synthetic.new/v2/search',
  },
} as const

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('web_search tool', () => {
  test('returns error when query is missing', async () => {
    const tool = createWebSearchTool({ search: BASE_CONFIG })
    const result = await tool.execute({})
    assert.match(result.error ?? '', /Missing required parameter: query/)
  })

  test('calls Brave provider and formats results', async () => {
    let requestedUrl = ''
    globalThis.fetch = (async (input: string | URL) => {
      requestedUrl = input.toString()
      return new Response(JSON.stringify({
        web: {
          results: [
            {
              title: 'Brave Result',
              url: 'https://example.com',
              description: 'Example description',
              age: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const tool = createWebSearchTool({ search: BASE_CONFIG })
    const result = await tool.execute({ query: 'jarvis', limit: 1 })

    assert.equal(result.error, undefined)
    assert.match(requestedUrl, /q=jarvis/)
    assert.match(requestedUrl, /count=1/)
    assert.match(result.content, /Brave Result/)
    assert.match(result.content, /https:\/\/example\.com/)
  })

  test('returns configuration error when Brave API key is missing', async () => {
    const tool = createWebSearchTool({
      search: {
        ...BASE_CONFIG,
        brave: {
          ...BASE_CONFIG.brave,
          apiKey: '',
        },
      },
    })

    const result = await tool.execute({ query: 'jarvis' })
    assert.match(result.error ?? '', /Brave web search is not configured/)
  })

  test('uses synthetic provider when requested', async () => {
    let requestMethod = ''
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      requestMethod = init?.method ?? 'GET'
      return new Response(JSON.stringify({
        results: [
          {
            title: 'Synthetic Result',
            url: 'https://synthetic.example',
            text: 'Synthetic snippet',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const tool = createWebSearchTool({
      search: {
        ...BASE_CONFIG,
        synthetic: {
          ...BASE_CONFIG.synthetic,
          apiKey: 'synthetic-key',
        },
      },
    })
    const result = await tool.execute({ query: 'jarvis', provider: 'synthetic' })

    assert.equal(result.error, undefined)
    assert.equal(requestMethod, 'POST')
    assert.match(result.content, /Synthetic Result/)
  })
})
