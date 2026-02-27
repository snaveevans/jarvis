import type { WebSearchProvider, WebSearchQuery, WebSearchResponse, WebSearchResult } from '../types.ts'

const DEFAULT_BRAVE_BASE_URL = 'https://api.search.brave.com/res/v1/web/search'

interface BraveSearchConfig {
  apiKey: string
  baseUrl?: string
}

interface BraveWebResult {
  title?: string
  url?: string
  description?: string
  age?: string
}

interface BraveResponseShape {
  web?: {
    results?: BraveWebResult[]
  }
}

function parseBraveResponse(input: unknown): WebSearchResult[] {
  if (!input || typeof input !== 'object') {
    return []
  }
  const data = input as BraveResponseShape
  const rows = data.web?.results
  if (!Array.isArray(rows)) {
    return []
  }

  const results: WebSearchResult[] = []
  for (const row of rows) {
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const url = typeof row.url === 'string' ? row.url.trim() : ''
    const description = typeof row.description === 'string' ? row.description.trim() : ''
    const published = typeof row.age === 'string' ? row.age : undefined
    if (title && url) {
      results.push({ title, url, description, published })
    }
  }
  return results
}

export function createBraveSearchProvider(config: BraveSearchConfig): WebSearchProvider {
  return {
    async search(input: WebSearchQuery): Promise<WebSearchResponse> {
      const baseUrl = config.baseUrl || DEFAULT_BRAVE_BASE_URL
      const url = new URL(baseUrl)
      url.searchParams.set('q', input.query)
      url.searchParams.set('count', String(input.limit))
      if (input.freshness) url.searchParams.set('freshness', input.freshness)
      if (input.country) url.searchParams.set('country', input.country)
      if (input.searchLang) url.searchParams.set('search_lang', input.searchLang)
      if (input.safeSearch) url.searchParams.set('safesearch', input.safeSearch)

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': config.apiKey,
        },
      })

      if (!response.ok) {
        const detail = await response.text()
        throw new Error(`Brave search failed: ${response.status} ${response.statusText} ${detail.slice(0, 200)}`)
      }

      const data = await response.json()
      return {
        provider: 'brave',
        results: parseBraveResponse(data).slice(0, input.limit),
      }
    },
  }
}
