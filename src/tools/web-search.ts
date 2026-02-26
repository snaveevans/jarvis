import { capOutput } from './common.ts'
import { createBraveSearchProvider } from '../search/providers/brave.ts'
import { createSyntheticSearchProvider } from '../search/providers/synthetic.ts'

import type { Tool, ToolResult } from './types.ts'
import type { WebSearchProviderName, WebSearchQuery } from '../search/types.ts'
import type { JarvisConfig } from '../config.ts'

export interface WebSearchToolConfig {
  search: JarvisConfig['search']
  syntheticApiKeyFallback?: string
}

function clampLimit(limit: unknown, defaultLimit: number, maxLimit: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return defaultLimit
  }
  const rounded = Math.floor(limit)
  if (rounded < 1) return 1
  if (rounded > maxLimit) return maxLimit
  return rounded
}

function isProvider(value: unknown): value is WebSearchProviderName {
  return value === 'brave' || value === 'synthetic'
}

function formatResults(provider: string, query: string, rows: Array<{
  title: string
  url: string
  description: string
  published?: string
}>): string {
  if (rows.length === 0) {
    return `No results found for "${query}" (provider: ${provider}).`
  }

  const lines: string[] = [`Web search results for "${query}" (provider: ${provider}):`, '']
  for (const [index, row] of rows.entries()) {
    lines.push(`${index + 1}. ${row.title}`)
    lines.push(`   URL: ${row.url}`)
    if (row.description) {
      lines.push(`   Snippet: ${row.description}`)
    }
    if (row.published) {
      lines.push(`   Published: ${row.published}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

export function createWebSearchTool(config: WebSearchToolConfig): Tool {
  return {
    name: 'web_search',
    description: 'Search the web and return ranked results with snippets.',
    timeoutMs: config.search.timeoutMs,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query.',
        },
        provider: {
          type: 'string',
          enum: ['brave', 'synthetic'],
          description: 'Optional provider override.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return.',
        },
        freshness: {
          type: 'string',
          description: 'Brave freshness filter (pd, pw, pm, py, or date range).',
        },
        country: {
          type: 'string',
          description: 'Brave country code (e.g., US, DE).',
        },
        search_lang: {
          type: 'string',
          description: 'Brave content language (e.g., en, de).',
        },
        safesearch: {
          type: 'string',
          enum: ['off', 'moderate', 'strict'],
          description: 'Brave adult-content filter.',
        },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) {
        return { content: '', error: 'Missing required parameter: query' }
      }

      const provider: WebSearchProviderName = isProvider(args.provider)
        ? args.provider
        : config.search.provider
      const limit = clampLimit(args.limit, config.search.defaultLimit, config.search.maxLimit)

      const request: WebSearchQuery = {
        query,
        limit,
        freshness: typeof args.freshness === 'string' ? args.freshness : undefined,
        country: typeof args.country === 'string' ? args.country : undefined,
        searchLang: typeof args.search_lang === 'string' ? args.search_lang : undefined,
        safeSearch: args.safesearch === 'off' || args.safesearch === 'moderate' || args.safesearch === 'strict'
          ? args.safesearch
          : undefined,
      }

      try {
        if (provider === 'brave') {
          const apiKey = config.search.brave.apiKey
          if (!apiKey) {
            return { content: '', error: 'Brave web search is not configured. Set BRAVE_API_KEY.' }
          }
          const brave = createBraveSearchProvider({
            apiKey,
            baseUrl: config.search.brave.baseUrl,
          })
          const result = await brave.search(request)
          return { content: capOutput(formatResults(result.provider, query, result.results)) }
        }

        const syntheticApiKey = config.search.synthetic.apiKey || config.syntheticApiKeyFallback || ''
        if (!syntheticApiKey) {
          return {
            content: '',
            error: 'Synthetic web search is not configured. Set SYNTHETIC_SEARCH_API_KEY or SYNTHETIC_API_KEY.',
          }
        }
        const synthetic = createSyntheticSearchProvider({
          apiKey: syntheticApiKey,
          baseUrl: config.search.synthetic.baseUrl,
        })
        const result = await synthetic.search(request)
        return { content: capOutput(formatResults(result.provider, query, result.results)) }
      } catch (error) {
        return {
          content: '',
          error: `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}
