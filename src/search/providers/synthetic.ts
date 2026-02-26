import type { WebSearchProvider, WebSearchQuery, WebSearchResponse, WebSearchResult } from '../types.ts'

const DEFAULT_SYNTHETIC_BASE_URL = 'https://api.synthetic.new/v2/search'

interface SyntheticSearchConfig {
  apiKey: string
  baseUrl?: string
}

interface SyntheticResult {
  title?: string
  url?: string
  text?: string
  published?: string
}

interface SyntheticResponseShape {
  results?: SyntheticResult[]
}

function parseSyntheticResponse(input: unknown): WebSearchResult[] {
  if (!input || typeof input !== 'object') {
    return []
  }
  const data = input as SyntheticResponseShape
  const rows = data.results
  if (!Array.isArray(rows)) {
    return []
  }

  return rows
    .map((row) => {
      const title = typeof row.title === 'string' ? row.title.trim() : ''
      const url = typeof row.url === 'string' ? row.url.trim() : ''
      const description = typeof row.text === 'string' ? row.text.trim() : ''
      const published = typeof row.published === 'string' ? row.published : undefined
      if (!title || !url) {
        return null
      }
      return { title, url, description, published }
    })
    .filter((row): row is WebSearchResult => row !== null)
}

export function createSyntheticSearchProvider(config: SyntheticSearchConfig): WebSearchProvider {
  return {
    async search(input: WebSearchQuery): Promise<WebSearchResponse> {
      const response = await fetch(config.baseUrl || DEFAULT_SYNTHETIC_BASE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: input.query,
          limit: input.limit,
        }),
      })

      if (!response.ok) {
        const detail = await response.text()
        throw new Error(`Synthetic search failed: ${response.status} ${response.statusText} ${detail.slice(0, 200)}`)
      }

      const data = await response.json()
      return {
        provider: 'synthetic',
        results: parseSyntheticResponse(data).slice(0, input.limit),
      }
    },
  }
}
