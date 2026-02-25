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

const BASE_URL = 'https://api.synthetic.new/openai/v1'

export interface LLMClientConfig {
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
}

export class LLMClient {
  private readonly client: OpenAI
  private readonly defaultModel: string

  constructor(config: LLMClientConfig = {}) {
    const apiKey = config.apiKey ?? process.env.SYNTHETIC_API_KEY
    
    if (!apiKey) {
      throw new LLMError(
        'API key is required. Set SYNTHETIC_API_KEY environment variable or pass apiKey to config.',
        'MISSING_API_KEY'
      )
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseUrl ?? BASE_URL,
    })
    
    this.defaultModel = config.defaultModel ?? 'hf:deepseek-ai/DeepSeek-V3-0324'
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

  async chat(
    messages: ChatMessage[],
    options: Omit<ChatCompletionRequest, 'messages' | 'model'> & { model?: string } = {}
  ): Promise<ChatCompletionResponse> {
    try {
      const response = await this.client.chat.completions.create({
        model: options.model ?? this.defaultModel,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        temperature: options.temperature,
        max_tokens: options.max_tokens,
        tools: options.tools,
        tool_choice: options.tool_choice,
        response_format: options.response_format,
        stream: false,
      })

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
      const stream = await this.client.chat.completions.create({
        model: options.model ?? this.defaultModel,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        temperature: options.temperature,
        max_tokens: options.max_tokens,
        tools: options.tools,
        tool_choice: options.tool_choice,
        response_format: options.response_format,
        stream: true,
      })

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
