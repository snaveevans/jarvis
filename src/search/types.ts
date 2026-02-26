export type WebSearchProviderName = 'brave' | 'synthetic'

export interface WebSearchQuery {
  query: string
  limit: number
  freshness?: string
  country?: string
  searchLang?: string
  safeSearch?: 'off' | 'moderate' | 'strict'
}

export interface WebSearchResult {
  title: string
  url: string
  description: string
  published?: string
}

export interface WebSearchResponse {
  provider: WebSearchProviderName
  results: WebSearchResult[]
}

export interface WebSearchProvider {
  search(input: WebSearchQuery): Promise<WebSearchResponse>
}
