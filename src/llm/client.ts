import OpenAI from 'openai'
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatMessage,
  Model,
} from './types.ts'
import {
  LLMError,
  LLMRateLimitError,
  LLMAuthenticationError,
  LLMInvalidRequestError,
  LLMModelNotFoundError,
} from './errors.ts'
import { inferProviderFromBaseUrl, stripThinkingContent } from './provider.ts'
import type { LLMProvider } from './provider.ts'

const DEFAULT_BASE_URL = 'https://api.synthetic.new/openai/v1'
const DEFAULT_MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504])

export interface LLMClientConfig {
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
  provider?: LLMProvider
  maxRetries?: number
}

export class LLMClient {
  private readonly client: OpenAI
  private readonly defaultModel: string
  private readonly provider: LLMProvider
  private readonly baseUrl: string
  private readonly maxRetries: number

  constructor(config: LLMClientConfig = {}) {
    const apiKey = config.apiKey

    if (!apiKey) {
      throw new LLMError(
        'API key is required. Set llm.apiKey in config file.',
        'MISSING_API_KEY'
      )
    }

    this.baseUrl = config.baseUrl ?? process.env.JARVIS_BASE_URL ?? DEFAULT_BASE_URL
    this.provider = config.provider ?? inferProviderFromBaseUrl(this.baseUrl)
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES

    this.client = new OpenAI({
      apiKey,
      baseURL: this.baseUrl,
    })

    this.defaultModel = config.defaultModel ?? ''
  }

  toUserVisibleContent(content: string): string {
    if (this.provider !== 'minimax') {
      return content
    }
    return stripThinkingContent(content)
  }

  private mapError(error: unknown): never {
    if (error instanceof OpenAI.APIError) {
      switch (error.status) {
        case 401:
          throw new LLMAuthenticationError(error.message)
        case 404:
          throw new LLMModelNotFoundError(error.message)
        case 429:
          throw new LLMRateLimitError(error.message)
        case 400:
          throw new LLMInvalidRequestError(error.message)
        default:
          throw new LLMError(
            error.message,
            `HTTP_${error.status}`,
            error.status
          )
      }
    }

    throw new LLMError(
      error instanceof Error ? error.message : String(error),
      'UNKNOWN_ERROR'
    )
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof OpenAI.APIError && error.status !== undefined) {
      return RETRYABLE_STATUS_CODES.has(error.status)
    }
    return false
  }

  private getRetryDelay(error: unknown, attempt: number): number {
    if (error instanceof OpenAI.APIError && error.status === 429) {
      const retryAfter = error.headers?.['retry-after']
      if (retryAfter) {
        const seconds = Number(retryAfter)
        if (Number.isFinite(seconds) && seconds > 0) {
          return Math.min(seconds * 1000, 30_000)
        }
      }
    }
    return RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
  }

  private async _withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error
        if (!this.isRetryable(error) || attempt === this.maxRetries - 1) {
          throw error
        }
        const delay = this.getRetryDelay(error, attempt)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    throw lastError
  }

  async chat(
    messages: ChatMessage[],
    options: Omit<ChatCompletionRequest, 'messages' | 'model'> & { model?: string } = {}
  ): Promise<ChatCompletionResponse> {
    try {
      const params: Record<string, unknown> = {
        model: options.model ?? this.defaultModel,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: false,
      }
      if (options.temperature !== undefined) params.temperature = options.temperature
      if (options.max_tokens !== undefined) params.max_tokens = options.max_tokens
      if (options.tools !== undefined) params.tools = options.tools
      if (options.tool_choice !== undefined) params.tool_choice = options.tool_choice
      if (options.response_format !== undefined) params.response_format = options.response_format
      if (this.provider === 'minimax') params.extra_body = { reasoning_split: true }

      const response = await this._withRetry(() =>
        this.client.chat.completions.create(
          params as unknown as Parameters<typeof this.client.chat.completions.create>[0]
        )
      )

      return response as unknown as ChatCompletionResponse
    } catch (error) {
      this.mapError(error)
    }
  }

  async *streamChat(
    messages: ChatMessage[],
    options: Omit<ChatCompletionRequest, 'messages' | 'model' | 'stream'> & { model?: string } = {}
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    try {
      const params: Record<string, unknown> = {
        model: options.model ?? this.defaultModel,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: true,
      }
      if (options.temperature !== undefined) params.temperature = options.temperature
      if (options.max_tokens !== undefined) params.max_tokens = options.max_tokens
      if (options.tools !== undefined) params.tools = options.tools
      if (options.tool_choice !== undefined) params.tool_choice = options.tool_choice
      if (options.response_format !== undefined) params.response_format = options.response_format
      if (this.provider === 'minimax') params.extra_body = { reasoning_split: true }

      const stream = await this.client.chat.completions.create(
        params as unknown as Parameters<typeof this.client.chat.completions.create>[0]
      ) as unknown as AsyncIterable<unknown>

      for await (const chunk of stream) {
        yield chunk as unknown as ChatCompletionChunk
      }
    } catch (error) {
      this.mapError(error)
    }
  }

  async listModels(): Promise<Model[]> {
    try {
      const response = await this.client.models.list()
      return response.data as unknown as Model[]
    } catch (error) {
      this.mapError(error)
    }
  }
}
