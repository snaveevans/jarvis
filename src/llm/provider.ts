export const LLM_PROVIDERS = ['synthetic', 'minimax', 'openai-compatible'] as const

export type LLMProvider = (typeof LLM_PROVIDERS)[number]

export function inferProviderFromBaseUrl(baseUrl: string): LLMProvider {
  const normalized = baseUrl.toLowerCase()
  if (normalized.includes('minimax')) {
    return 'minimax'
  }
  if (normalized.includes('synthetic.new')) {
    return 'synthetic'
  }
  return 'openai-compatible'
}

export function stripThinkingContent(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

